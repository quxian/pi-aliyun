import * as FC from '@alicloud/fc20230330';
import * as DNS from '@alicloud/alidns20150109';
import * as OTS from '@alicloud/tablestore20201209';
import * as RAM from '@alicloud/ram20150501';
import * as CAS from '@alicloud/cas20200407';
import { setTimeout as delay } from 'node:timers/promises';
import { domainRecords, isMissing } from './cloud.mjs';
import { databaseNames } from './database-plan.mjs';
import { createDatabaseClients, getInstance } from './database.mjs';
import { readResources, saveResources } from './resources.mjs';
import { applicationCertificates, checkCertificateBindings } from './certificates.mjs';
import { unregisterRenewal } from './renewal.mjs';
import { errorInfo, operation } from './errors.mjs';

const missing = error => isMissing(error) || ['EntityNotExist.Role', 'EntityNotExist.Policy', 'OTSObjectNotExist'].includes(error.code);
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const decodePolicy = value => { try { return JSON.parse(value); } catch { return JSON.parse(decodeURIComponent(value)); } };
export const dnsTargets = config => [config.frontend && { domain: config.frontend.domain, value: `${config.frontend.bucket}.oss-${config.region}.aliyuncs.com` },
  config.backend && { domain: config.backend.domain, value: `${config.accountId}.${config.region}.fc.aliyuncs.com` }].filter(Boolean);

export async function inspectApplication(clients, config, configPath, { database = config.database && createDatabaseClients(config, clients.credential) } = {}) {
  const inventory = await readResources(config, configPath);
  const checks = [];
  const inspect = async (component, run) => {
    try { const detail = await run(); checks.push({ component, exists: true, ok: true, ...detail }); }
    catch (error) { checks.push(missing(error) ? { component, exists: false, ok: false } : { component, ok: false, error: errorInfo(error) }); }
  };
  const tasks = [];
  if (config.backend) {
    const b = config.backend;
    tasks.push(inspect('function', async () => {
      const { body } = await clients.fc.getFunction(b.functionName, new FC.GetFunctionRequest({}));
      ensure(body.description === `Managed by pi-aliyun: ${config.project}`, 'FC function belongs to another application');
      return { name: b.functionName, runtime: body.runtime, state: body.state, cpu: body.cpu, memorySize: body.memorySize, lastModified: body.lastModifiedTime,
        ok: (!body.state || body.state === 'Active') && (body.role === b.role || (!body.role && !b.role)), roleMatches: body.role === b.role || (!body.role && !b.role) };
    }));
    tasks.push(inspect('api-domain', async () => {
      const { body } = await clients.fc.getCustomDomain(b.domain);
      const routes = body.routeConfig?.routes || [];
      ensure(routes.length === 1 && routes[0].functionName === b.functionName && routes[0].path === '/*', 'FC domain is not exclusively owned by this function');
      return { domain: b.domain, protocol: body.protocol, ok: body.protocol === 'HTTPS' };
    }));
    tasks.push(inspect('http-trigger', async () => {
      const { body } = await clients.fc.getTrigger(b.functionName, 'http');
      const settings = JSON.parse(body.triggerConfig);
      return { disableURLInternet: settings.disableURLInternet, ok: settings.disableURLInternet === true };
    }));
  }
  if (config.frontend) tasks.push(inspect('bucket', async () => {
    const bucket = config.frontend.bucket;
    const info = await clients.oss.getBucketInfo(bucket);
    const tags = await clients.oss.getBucketTags(bucket);
    ensure(String(info.bucket.Owner.ID) === config.accountId && [config.region, `oss-${config.region}`].includes(info.bucket.Location) && tags.tag['pi-aliyun-project'] === config.project, 'OSS bucket ownership or region differs from this application');
    return { name: bucket, location: info.bucket.Location };
  }));
  for (const target of dnsTargets(config)) tasks.push(inspect(`dns:${target.domain}`, async () => {
    const records = await domainRecords(clients.dns, config, target.domain.slice(0, -(config.dns.zone.length + 1)));
    ensure(records.every(record => record.type === 'CNAME' && record.value.replace(/\.$/, '') === target.value && record.line === 'default'), `DNS ${target.domain} points outside this application`);
    return { exists: records.length > 0, ok: records.length === 1 && records[0].status === 'ENABLE', records: records.map(({ recordId, RR, type, value, status }) => ({ recordId, RR, type, value, status })) };
  }));
  if (database) {
    const names = databaseNames(config);
    tasks.push(inspect('database', async () => {
      const info = await getInstance(database.control, config.database.instance);
      if (!info) return { exists: false, ok: false, tables: [] };
      ensure(info.userId === config.accountId && info.regionId === config.region && info.instanceDescription === names.instanceDescription, 'Database instance belongs to another application');
      const tables = info.instanceStatus === 'normal' ? (await database.data('listTable', {})).tableNames : [];
      ensure(Array.isArray(tables), 'Tablestore returned no table inventory');
      return { name: config.database.instance, state: info.instanceStatus, shared: Boolean(config.database.shared), tables,
        ok: info.instanceStatus === 'normal' && config.database.tables.every(table => tables.includes(names.prefix + table.name)) };
    }));
    tasks.push(inspect('runtime-role', async () => {
      const { body } = await database.ram.getRole(new RAM.GetRoleRequest({ roleName: names.roleName }));
      ensure(body.role.description === `Managed by pi-aliyun: ${config.project}`, 'Runtime role belongs to another application');
      const attached = (await database.ram.listPoliciesForRole(new RAM.ListPoliciesForRoleRequest({ roleName: names.roleName }))).body.policies?.policy || [];
      ensure(attached.every(p => p.policyType === 'Custom' && p.policyName === names.policyName), 'Runtime role has additional policies');
      return { name: names.roleName, attached: attached.length, ok: attached.length === 1 };
    }));
    tasks.push(inspect('runtime-policy', async () => {
      const { body } = await database.ram.getPolicy(new RAM.GetPolicyRequest({ policyType: 'Custom', policyName: names.policyName }));
      ensure(body.policy.description === `Managed by pi-aliyun: ${config.project}`, 'Runtime policy belongs to another application');
      const entities = (await database.ram.listEntitiesForPolicy(new RAM.ListEntitiesForPolicyRequest({ policyType: 'Custom', policyName: names.policyName }))).body;
      ensure(!entities.users?.user?.length && !entities.groups?.group?.length && !entities.roles?.role?.some(role => role.roleName !== names.roleName), 'Runtime policy is attached to other identities');
      return { name: names.policyName, version: body.policy.defaultVersion };
    }));
  }
  tasks.push(inspect('certificates', async () => ({ certificates: await applicationCertificates(clients.cas, config, inventory) })));
  await Promise.all(tasks);
  checks.sort((a, b) => a.component.localeCompare(b.component));
  return { project: config.project, accountId: config.accountId, region: config.region, ok: checks.every(check => check.ok), checks };
}

async function checkSharedDatabase(ram, config) {
  const own = databaseNames(config).policyName;
  let marker;
  do {
    const { body } = await ram.listPolicies(new RAM.ListPoliciesRequest({ policyType: 'Custom', maxItems: 100, marker }));
    for (const policy of body.policies?.policy || []) {
      if (policy.policyName === own || !policy.policyName.startsWith('PiDatabase-pi-aliyun-')) continue;
      const { body: version } = await ram.getPolicyVersion(new RAM.GetPolicyVersionRequest({ policyType: 'Custom', policyName: policy.policyName, versionId: policy.defaultVersion }));
      const document = JSON.stringify(decodePolicy(version.policyVersion.policyDocument));
      ensure(!document.includes(`instance/${config.database.instance}/`), `Database is shared with ${policy.policyName}; remove or change that application's dependency before deleting the owner`);
    }
    marker = body.isTruncated ? body.marker : undefined;
  } while (marker);
}

export async function planDestroy(clients, config, configPath, options = {}) {
  const database = options.database || (config.database && createDatabaseClients(config, clients.credential));
  const report = await inspectApplication(clients, config, configPath, { database });
  const get = name => report.checks.find(check => check.component === name);
  const blockers = report.checks.filter(check => check.error).map(check => ({ component: check.component, ...check.error }));
  const inspect = async (component, run) => { try { await run(); } catch (error) { blockers.push({ component, ...errorInfo(error) }); } };
  if (get('bucket')?.exists) await inspect('bucket', async () => {
    const version = await clients.oss.getBucketVersioning(config.frontend.bucket);
    ensure(!version.versionStatus, 'Versioned OSS buckets require an explicit version-retention decision; no objects were deleted');
    const result = await clients.oss.request({ method: 'GET', bucket: config.frontend.bucket, subres: 'cname', xmlResponse: true, successStatuses: [200] });
    ensure(array(result.data?.Cname).every(item => item.Domain === config.frontend.domain), 'Bucket has additional domain bindings');
  });
  if (get('function')?.exists) await inspect('function', async () => {
    ensure(!config.backend.vpcConfig, 'Custom VPC resources require a separate teardown plan');
    const { body } = await clients.fc.listTriggers(config.backend.functionName, new FC.ListTriggersRequest({ limit: 100 }));
    ensure(!body.nextToken && (body.triggers || []).every(trigger => trigger.triggerName === 'http' && trigger.triggerType === 'http'), 'Function has additional triggers');
    let nextToken;
    do {
      const { body: domains } = await clients.fc.listCustomDomains(new FC.ListCustomDomainsRequest({ limit: 100, nextToken }));
      for (const domain of domains.customDomains || []) ensure(domain.domainName === config.backend.domain || !(domain.routeConfig?.routes || []).some(route => route.functionName === config.backend.functionName), 'Function is used by another custom domain');
      nextToken = domains.nextToken;
    } while (nextToken);
  });
  if (database && !config.database.shared && get('database')?.exists) await inspect('database', async () => {
    const names = databaseNames(config);
    ensure(get('database').tables.every(table => table.startsWith(names.prefix)), 'Database contains tables outside this application');
    await checkSharedDatabase(database.ram, config);
  });
  const certificates = get('certificates')?.certificates || [];
  await inspect('certificates', () => checkCertificateBindings(clients.cas, certificates, config));
  return { ...report, ok: blockers.length === 0, blockers,
    retained: [config.database?.shared && `Shared database ${config.database.instance}`, ...certificates.filter(cert => !cert.owned).map(cert => `Certificate ${cert.id}: fingerprint or domains not owned`), 'Local source, configuration and private files'].filter(Boolean),
    warning: 'Confirmed execution permanently deletes this application\'s cloud data. No backup is created.' };
}

export async function destroyApplication(clients, config, configPath, { confirm, registry, database = config.database && createDatabaseClients(config, clients.credential), wait = () => delay(20000), attempts = 31 } = {}) {
  ensure(confirm === config.project, 'Deletion requires --confirm with the exact project name and the user\'s authorization to delete its data');
  const plan = await planDestroy(clients, config, configPath, { database });
  ensure(plan.ok, `Deletion preflight blocked: ${JSON.stringify(plan.blockers)}`);
  const get = name => plan.checks.find(check => check.component === name);
  await saveResources(config, configPath, { state: 'deleting' });
  await unregisterRenewal(configPath, registry);
  for (const target of dnsTargets(config)) for (const record of get(`dns:${target.domain}`).records || []) {
    await operation(`Delete DNS ${target.domain}`, () => clients.dns.deleteDomainRecord(new DNS.DeleteDomainRecordRequest({ recordId: record.recordId })));
  }
  if (get('api-domain')?.exists) await operation('Delete API domain', () => clients.fc.deleteCustomDomain(config.backend.domain));
  if (get('function')?.exists) {
    if (get('http-trigger')?.exists) await operation('Delete HTTP trigger', () => clients.fc.deleteTrigger(config.backend.functionName, 'http'));
    await operation('Delete function scaling settings', async () => {
      const ignoreAbsent = async run => { try { await run(); } catch (error) { if (!missing(error) && !['ScalingConfigNotFound', 'ConcurrencyConfigNotFound'].includes(error.code)) throw error; } };
      await ignoreAbsent(() => clients.fc.deleteScalingConfig(config.backend.functionName, new FC.DeleteScalingConfigRequest({ qualifier: 'LATEST' })));
      await ignoreAbsent(() => clients.fc.deleteConcurrencyConfig(config.backend.functionName));
    });
    await operation('Delete function', () => clients.fc.deleteFunction(config.backend.functionName));
  }
  if (get('bucket')?.exists) await operation('Empty and delete application bucket', async () => {
    for (;;) {
      const { uploads } = await clients.oss.listUploads({ 'max-uploads': 1000 });
      if (!uploads.length) break;
      for (const item of uploads) await clients.oss.abortMultipartUpload(item.name, item.uploadId);
    }
    for (;;) {
      const { objects = [] } = await clients.oss.listV2({ 'max-keys': 1000 });
      if (!objects.length) break;
      const deleted = await clients.oss.deleteMulti(objects.map(item => item.name));
      ensure(deleted.deleted.length === objects.length, 'Some OSS objects were not deleted; inspect retention/permissions and retry');
    }
    await clients.oss.deleteBucket(config.frontend.bucket);
  });
  if (database) {
    const names = databaseNames(config);
    if (!config.database.shared && get('database')?.exists && get('database').state !== 'deleting') await operation('Delete application database', async () => {
      for (const tableName of get('database').tables) await database.data('deleteTable', { tableName });
      await database.control.deleteInstance(new OTS.DeleteInstanceRequest({ instanceName: config.database.instance }));
    });
    if (get('runtime-role')?.exists) await operation('Delete runtime role', async () => {
      if (get('runtime-role').attached) await database.ram.detachPolicyFromRole(new RAM.DetachPolicyFromRoleRequest({ roleName: names.roleName, policyName: names.policyName, policyType: 'Custom' }));
      await database.ram.deleteRole(new RAM.DeleteRoleRequest({ roleName: names.roleName }));
    });
    if (get('runtime-policy')?.exists) await operation('Delete runtime policy', async () => {
      const { body } = await database.ram.listPolicyVersions(new RAM.ListPolicyVersionsRequest({ policyName: names.policyName, policyType: 'Custom' }));
      for (const version of body.policyVersions?.policyVersion || []) if (version.isDefaultVersion === false) await database.ram.deletePolicyVersion(new RAM.DeletePolicyVersionRequest({ policyName: names.policyName, versionId: version.versionId }));
      await database.ram.deletePolicy(new RAM.DeletePolicyRequest({ policyName: names.policyName }));
    });
  }
  for (const cert of get('certificates').certificates.filter(item => item.owned)) await operation(`Delete certificate ${cert.id}`, () => clients.cas.deleteUserCertificate(new CAS.DeleteUserCertificateRequest({ certId: cert.id })));
  if (database && !config.database.shared) {
    for (let attempt = 0; ; attempt++) {
      if (!await getInstance(database.control, config.database.instance)) break;
      ensure(attempt < attempts - 1, 'Tablestore release is still pending; rerun destroy with the same config to finish verification');
      console.log('Waiting for Tablestore instance release…');
      await wait();
    }
  }
  const after = await inspectApplication(clients, config, configPath, { database });
  const remaining = after.checks.filter(check => check.error || (check.component === 'certificates' ? check.certificates?.some(cert => cert.owned) : check.exists && !(check.component === 'database' && config.database.shared)));
  ensure(!remaining.length, `Deletion is incomplete: ${JSON.stringify(remaining)}`);
  await saveResources(config, configPath, { state: 'deleted' });
  return { project: config.project, deleted: true, retained: plan.retained.filter(Boolean) };
}
