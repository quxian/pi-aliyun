import { createCredential } from './connection.mjs';
import { createRosClient, backendNames } from './ros.mjs';
import DNSModule, * as DNS from '@alicloud/alidns20150109';
import STSModule from '@alicloud/sts20150401';
import OSS from 'ali-oss';
import { contentType } from 'mime-types';
import { setTimeout as delay } from 'node:timers/promises';
import { X509Certificate } from 'node:crypto';

const Client = (module) => module.default || module;
export async function createClients(config, { services = ['dns', 'ros', 'oss'] } = {}) {
  const credential = await createCredential();
  const sts = new (Client(STSModule))({ credential, endpoint: 'sts.cn-hangzhou.aliyuncs.com', protocol: 'https' });
  let identity;
  try { identity = await sts.getCallerIdentity(); }
  catch { throw new Error('Could not verify Alibaba Cloud credentials with STS GetCallerIdentity; check the SDK credential chain and network'); }
  if (identity.body?.accountId !== config.accountId) throw new Error('Credential account does not match config.accountId; no resources were changed');
  const clients = { credential };
  if (services.includes('cas')) {
    const { default: CASModule } = await import('@alicloud/cas20200407');
    clients.cas = new (Client(CASModule))({ credential, endpoint: 'cas.aliyuncs.com', protocol: 'https' });
  }
  if (services.includes('dns')) clients.dns = new (Client(DNSModule))({ credential, endpoint: 'alidns.cn-hangzhou.aliyuncs.com', protocol: 'https' });
  if (services.includes('ros') && config.backend) clients.ros = createRosClient(credential);
  if (services.includes('oss') && (config.frontend || config.backend)) {
    const resolveCredential = async () => {
      const result = await credential.getCredential();
      return { accessKeyId: result.accessKeyId, accessKeySecret: result.accessKeySecret, stsToken: result.securityToken };
    };
    const options = { ...await resolveCredential(), region: `oss-${config.region}`, secure: true, authorizationV4: true,
      refreshSTSToken: resolveCredential, refreshSTSTokenInterval: 60_000 };
    if (config.frontend) clients.oss = new OSS({ ...options, bucket: config.frontend.bucket });
    if (config.backend) clients.codeOss = new OSS({ ...options, bucket: backendNames(config).codeBucket });
  }
  return clients;
}

export function isMissing(error) {
  return ['FunctionNotFound', 'TriggerNotFound', 'DomainNameNotFound', 'CustomDomainNotFound', 'NoSuchBucket'].includes(error.code);
}

export async function domainRecords(dns, config, RR) {
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
  if (record && record.value.replace(/\.$/, '') !== target) throw new Error(`DNS ${domain} points to another resource; resolve the ownership conflict before deployment`);
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
  const listed = await oss.request({ method: 'GET', bucket: config.frontend.bucket, subres: 'cname', xmlResponse: true, successStatuses: [200] });
  const entries = Array.isArray(listed.data?.Cname) ? listed.data.Cname : listed.data?.Cname ? [listed.data.Cname] : [];
  const current = entries.find(item => item.Domain === config.frontend.domain);
  // Avoid creating a duplicate uploaded certificate on every deploy/daily check.
  if (current?.Certificate?.Status === 'Enabled' && current.Certificate.Fingerprint?.toUpperCase() === new X509Certificate(tls.certificate).fingerprint) return;
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
