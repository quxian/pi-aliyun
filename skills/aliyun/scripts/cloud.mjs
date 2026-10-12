import CredentialModule from '@alicloud/credentials';
import FCModule, * as FC from '@alicloud/fc20230330';
import DNSModule, * as DNS from '@alicloud/alidns20150109';
import STSModule from '@alicloud/sts20150401';
import OSS from 'ali-oss';
import { contentType } from 'mime-types';
import { setTimeout as delay } from 'node:timers/promises';

const Client = (module) => module.default || module;
export async function createClients(config, { services = ['dns', 'fc', 'oss'] } = {}) {
  const credential = new (Client(CredentialModule))();
  const sts = new (Client(STSModule))({ credential, endpoint: 'sts.cn-hangzhou.aliyuncs.com', protocol: 'https' });
  let identity;
  try { identity = await sts.getCallerIdentity(); }
  catch { throw new Error('Could not verify Alibaba Cloud credentials with STS GetCallerIdentity; check the SDK credential chain and network'); }
  if (identity.body?.accountId !== config.accountId) throw new Error('Credential account does not match config.accountId; no resources were changed');
  const clients = {};
  if (services.includes('dns')) clients.dns = new (Client(DNSModule))({ credential, endpoint: 'alidns.cn-hangzhou.aliyuncs.com', protocol: 'https' });
  if (services.includes('fc') && config.backend) clients.fc = new (Client(FCModule))({ credential, regionId: config.region, endpoint: `fcv3.${config.region}.aliyuncs.com`, protocol: 'https' });
  if (services.includes('oss') && config.frontend) {
    const resolveCredential = async () => {
      const result = await credential.getCredential();
      return { accessKeyId: result.accessKeyId, accessKeySecret: result.accessKeySecret, stsToken: result.securityToken };
    };
    clients.oss = new OSS({
      ...await resolveCredential(), region: `oss-${config.region}`, bucket: config.frontend.bucket,
      secure: true, authorizationV4: true, refreshSTSToken: resolveCredential, refreshSTSTokenInterval: 60_000,
    });
  }
  return clients;
}

export function isMissing(error) {
  return ['FunctionNotFound', 'TriggerNotFound', 'DomainNameNotFound', 'CustomDomainNotFound', 'NoSuchBucket'].includes(error.code);
}

async function domainRecords(dns, config, RR) {
  const records = [];
  for (let pageNumber = 1; ; pageNumber++) {
    const response = await dns.describeDomainRecords(new DNS.DescribeDomainRecordsRequest({ domainName: config.dns.zone, RRKeyWord: RR, searchMode: 'EXACT', pageNumber, pageSize: 500 }));
    const batch = response.body?.domainRecords?.record || [];
    records.push(...batch.filter((item) => item.RR === RR));
    if (pageNumber * 500 >= (response.body?.totalCount || 0)) break;
  }
  return records;
}

export async function ensureCname(dns, config, domain, target) {
  const RR = domain.slice(0, -(config.dns.zone.length + 1));
  const records = await domainRecords(dns, config, RR);
  if (records.some((item) => item.type !== 'CNAME' || item.line !== 'default') || records.length > 1) throw new Error(`DNS ${domain} has conflicting records; resolve them before deployment`);
  const record = records[0];
  if (record?.status === 'DISABLE') throw new Error(`DNS ${domain} is disabled; enable the intended record before deployment`);
  if (record && record.value.replace(/\.$/, '') === target && record.TTL === config.dns.ttl) return;
  const values = { RR, type: 'CNAME', value: target, TTL: config.dns.ttl, line: 'default' };
  if (record) await dns.updateDomainRecord(new DNS.UpdateDomainRecordRequest({ ...values, recordId: record.recordId }));
  else await dns.addDomainRecord(new DNS.AddDomainRecordRequest({ ...values, domainName: config.dns.zone }));
}

const xml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
export function websiteXml(spa) {
  return `<WebsiteConfiguration><IndexDocument><Suffix>index.html</Suffix></IndexDocument>${spa ? '<ErrorDocument><Key>index.html</Key><HttpStatus>200</HttpStatus></ErrorDocument>' : ''}</WebsiteConfiguration>`;
}
export function certificateXml(domain, tls) {
  return `<BucketCnameConfiguration><Cname><Domain>${xml(domain)}</Domain><CertificateConfiguration><Certificate>${xml(tls.certificate)}</Certificate><PrivateKey>${xml(tls.privateKey)}</PrivateKey><Force>true</Force></CertificateConfiguration></Cname></BucketCnameConfiguration>`;
}

export function cacheControl(key) {
  if (/(?:^|\/)[^/]+[.-][a-f0-9]{8,}\.(?:js|css|woff2?|png|jpe?g|svg|webp|avif)$/i.test(key)) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

export async function deployFrontend(oss, config, files, tls, options = {}) {
  const f = config.frontend;
  try {
    const info = await oss.getBucketInfo(f.bucket);
    if (String(info.bucket.Owner.ID) !== config.accountId) throw new Error('Configured OSS bucket is not owned by accountId');
    if (info.bucket.Location !== `oss-${config.region}` && info.bucket.Location !== config.region) throw new Error('OSS bucket region does not match config.region');
    const tags = await oss.getBucketTags(f.bucket);
    if (tags.tag['pi-aliyun-project'] !== config.project) throw new Error('Existing OSS bucket is not managed by this project; choose a new dedicated bucket');
  } catch (error) {
    if (error.code !== 'NoSuchBucket') throw error;
    await oss.putBucket(f.bucket, { acl: 'private', storageClass: 'Standard' });
    await oss.putBucketTags(f.bucket, { 'pi-aliyun-project': config.project });
  }
  // New OSS buckets block public access by default; this dedicated website bucket must serve anonymous readers.
  await oss.request({ method: 'PUT', bucket: f.bucket, subres: 'publicAccessBlock', content: '<PublicAccessBlockConfiguration><BlockPublicAccess>false</BlockPublicAccess></PublicAccessBlockConfiguration>', mime: 'xml', successStatuses: [200] });
  await oss.putBucketACL(f.bucket, 'public-read');
  // The SDK's website helper omits ErrorDocument.HttpStatus; its signed request API preserves it.
  await oss.request({ method: 'PUT', bucket: f.bucket, subres: 'website', content: websiteXml(f.spa), mime: 'xml', successStatuses: [200] });
  // Publish HTML last so a new entrypoint never refers to assets still being uploaded.
  const ordered = [...files].sort((a, b) => Number(a.key.endsWith('.html')) - Number(b.key.endsWith('.html')) || a.key.localeCompare(b.key));
  for (const file of ordered) {
    await oss.put(file.key, file.path, { headers: { 'Content-Type': contentType(file.key) || 'application/octet-stream', 'Cache-Control': cacheControl(file.key) } });
  }
  await bindFrontendDomain(oss, config, tls, options);
}

export async function bindFrontendDomain(oss, config, tls, { dns, attempts = 25, wait = () => delay(5000) } = {}) {
  const tags = await oss.getBucketTags(config.frontend.bucket);
  if (tags.tag['pi-aliyun-project'] !== config.project) throw new Error('OSS bucket is not managed by this project');
  // PutCname is an official OSS API not exposed by ali-oss's convenience helpers.
  const bind = () => oss.request({ method: 'POST', bucket: config.frontend.bucket, subres: { cname: '', comp: 'add' }, content: certificateXml(config.frontend.domain, tls), mime: 'xml', successStatuses: [200] });
  try { await bind(); return; }
  catch (error) { if (error.code !== 'NeedVerifyDomainOwnership' || !dns) throw error; }
  const { bucket, domain } = config.frontend;
  console.log(`Verifying OSS domain ownership through DNS: ${domain}`);
  let token;
  try {
    const response = await oss.request({ method: 'POST', bucket, subres: { cname: '', comp: 'token' }, content: `<BucketCnameConfiguration><Cname><Domain>${xml(domain)}</Domain></Cname></BucketCnameConfiguration>`, mime: 'xml', xmlResponse: true, successStatuses: [200] });
    if (response.data?.Bucket !== bucket || response.data?.Cname !== domain || typeof response.data?.Token !== 'string' || !response.data.Token) throw new Error('OSS returned an invalid domain verification token');
    token = response.data.Token;
  } catch (error) {
    if (error.code !== 'NoNeedCreateCnameToken') throw error;
    await bind(); return;
  }
  const RR = `_dnsauth.${domain.slice(0, -(config.dns.zone.length + 1))}`;
  const records = await domainRecords(dns, config, RR);
  if (records.some((record) => record.type !== 'TXT' || record.status === 'DISABLE')) throw new Error(`DNS verification record ${RR} has conflicting or disabled records`);
  let createdRecordId;
  try {
    if (!records.some((record) => record.value === token)) {
      const response = await dns.addDomainRecord(new DNS.AddDomainRecordRequest({ domainName: config.dns.zone, RR, type: 'TXT', value: token, TTL: 600, line: 'default' }));
      createdRecordId = response.body?.recordId;
      if (!createdRecordId) throw new Error('AliDNS did not return the OSS verification record ID');
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { await bind(); console.log(`OSS domain verified and bound: ${domain}`); return; }
      catch (error) { if (error.code !== 'NeedVerifyDomainOwnership') throw error; }
      if (attempt < attempts - 1) await wait();
    }
    throw new Error(`OSS domain verification timed out for ${domain}; check authoritative DNS and retry deployment`);
  } finally {
    if (createdRecordId) {
      try { await dns.deleteDomainRecord(new DNS.DeleteDomainRecordRequest({ recordId: createdRecordId })); }
      catch { console.error(`Could not remove this run's OSS verification TXT record ${createdRecordId} (${config.dns.zone}); remove it after checking the record`); }
    }
  }
}

export function functionInput(config, archive, environment) {
  const b = config.backend;
  return {
    functionName: b.functionName, description: `Managed by pi-aliyun: ${config.project}`,
    runtime: b.runtime, handler: 'index.handler', code: { zipFile: archive.toString('base64') },
    cpu: b.cpu, memorySize: b.memorySize, diskSize: 512, timeout: b.timeout,
    instanceConcurrency: b.instanceConcurrency, internetAccess: true,
    customRuntimeConfig: { command: b.command.slice(0, 1), args: b.command.slice(1), port: b.port },
    environmentVariables: { ...environment, PORT: String(b.port) },
    ...(b.role ? { role: b.role } : {}), ...(b.vpcConfig ? { vpcConfig: b.vpcConfig } : {}),
  };
}

const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];
export function corsConfig(config) {
  return config.frontend ? { allowOrigins: [`https://${config.frontend.domain}`], allowMethods: methods, allowHeaders: ['Content-Type', 'Authorization'], allowCredentials: true, maxAge: 600 } : undefined;
}

export async function deployBackend(fc, config, archive, environment) {
  const b = config.backend;
  const values = functionInput(config, archive, environment);
  let exists;
  try {
    const current = await fc.getFunction(b.functionName, new FC.GetFunctionRequest({}));
    if (current.body?.description !== values.description) throw new Error('Existing FC function is not managed by this project; choose a new function name');
    exists = true;
  }
  catch (error) { if (!isMissing(error)) throw error; exists = false; }
  if (exists) {
    const { functionName, ...updates } = values;
    await fc.updateFunction(functionName, new FC.UpdateFunctionRequest({ body: new FC.UpdateFunctionInput(updates) }));
  } else await fc.createFunction(new FC.CreateFunctionRequest({ body: new FC.CreateFunctionInput(values) }));
  // The API's historical 'concurrency' quota counts function instances, not per-instance requests.
  await fc.putConcurrencyConfig(b.functionName, new FC.PutConcurrencyConfigRequest({ body: new FC.PutConcurrencyInput({ reservedConcurrency: b.maxInstances }) }));
  await fc.putScalingConfig(b.functionName, new FC.PutScalingConfigRequest({ qualifier: 'LATEST', body: new FC.PutScalingConfigInput({ minInstances: 0, enableOnDemandScaling: true, horizontalScalingPolicies: [], scheduledPolicies: [] }) }));
  const triggerConfig = JSON.stringify({ authType: 'anonymous', methods: [...methods, 'OPTIONS'], disableURLInternet: true, ...(corsConfig(config) ? { corsConfig: corsConfig(config) } : {}) });
  try {
    await fc.getTrigger(b.functionName, 'http');
    await fc.updateTrigger(b.functionName, 'http', new FC.UpdateTriggerRequest({ body: new FC.UpdateTriggerInput({ triggerConfig, qualifier: 'LATEST' }) }));
  } catch (error) {
    if (!isMissing(error)) throw error;
    await fc.createTrigger(b.functionName, new FC.CreateTriggerRequest({ body: new FC.CreateTriggerInput({ triggerName: 'http', triggerType: 'http', qualifier: 'LATEST', triggerConfig }) }));
  }
}

export async function bindBackendDomain(fc, config, tls, { existingOnly = false, attempts = 25, wait = () => delay(5000) } = {}) {
  const b = config.backend;
  const values = {
    domainName: b.domain, protocol: 'HTTPS', certConfig: { certName: `${config.project}-tls`, certificate: tls.certificate, privateKey: tls.privateKey },
    routeConfig: { routes: [{ functionName: b.functionName, path: '/*', qualifier: 'LATEST', methods: [...methods, 'OPTIONS'] }] },
    ...(corsConfig(config) ? { corsConfig: corsConfig(config) } : {}),
  };
  let exists;
  try {
    const current = await fc.getCustomDomain(b.domain);
    const routes = current.body?.routeConfig?.routes || [];
    if (routes.length !== 1 || routes[0].functionName !== b.functionName || routes[0].path !== '/*') throw new Error('Existing FC domain is not exclusively routed to this project function');
    exists = true;
  }
  catch (error) { if (existingOnly || !isMissing(error)) throw error; exists = false; }
  const { domainName, ...updates } = values;
  const bind = exists
    ? () => fc.updateCustomDomain(domainName, new FC.UpdateCustomDomainRequest({ body: new FC.UpdateCustomDomainInput(existingOnly ? { certConfig: updates.certConfig } : updates) }))
    : () => fc.createCustomDomain(new FC.CreateCustomDomainRequest({ body: new FC.CreateCustomDomainInput(values) }));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await bind(); return; }
    catch (error) { if (error.code !== 'DomainNameNotResolved') throw error; }
    if (attempt === 0) console.log(`Waiting for FC to recognize the CNAME: ${domainName}`);
    if (attempt < attempts - 1) await wait();
  }
  throw new Error(`FC has not recognized the CNAME for ${domainName}; check DNS propagation and retry deployment`);
}
