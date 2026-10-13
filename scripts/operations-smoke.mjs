import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../skills/aliyun/scripts/config.mjs';
import { databaseNames } from '../skills/aliyun/scripts/database-plan.mjs';
import { inspectApplication, planDestroy, destroyApplication, dnsTargets } from '../skills/aliyun/scripts/operations.mjs';
import { verifyApplication } from '../skills/aliyun/scripts/verify.mjs';
import { errorInfo } from '../skills/aliyun/scripts/errors.mjs';
import { saveResources } from '../skills/aliyun/scripts/resources.mjs';
import { backendNames } from '../skills/aliyun/scripts/ros.mjs';
import { applicationCertificates } from '../skills/aliyun/scripts/certificates.mjs';

const root = await mkdtemp(join(tmpdir(), 'pi-aliyun-operations-'));
const absent = code => { throw Object.assign(new Error('missing'), { code }); };
try {
  const raw = JSON.parse(await readFile(new URL('../examples/durable-notes/aliyun.example.json', import.meta.url), 'utf8'));
  const config = validateConfig(raw, root), names = databaseNames(config), path = join(root, 'aliyun.json'), registry = join(root, 'renewal.json');
  await writeFile(path, JSON.stringify(raw));
  await writeFile(registry, JSON.stringify({ version: 1, projects: [path, '/srv/other/aliyun.json'] }));
  await saveResources(config, path);
  const state = { codeBucket: true, codeObjects: ['code/' + 'a'.repeat(64) + '.zip'], function: true, domain: true, trigger: true, bucket: true, database: true, role: true, policy: true, attached: true,
    tables: [names.prefix + 'notes'], objects: ['index.html'], certificate: true, uploads: [], wrongBucket: false, shared: false, versioned: false };
  const writes = [], checked = request => request.validate();
  const records = dnsTargets(config).map((target, i) => ({ recordId: String(i), RR: target.domain.slice(0, -(config.dns.zone.length + 1)), type: 'CNAME', line: 'default', status: 'ENABLE', value: target.value }));
  const domains = [config.frontend.domain, config.backend.domain];
  const certificate = { fingerprint: 'a'.repeat(40), publicKeySha256: 'b'.repeat(64), serialNumber: 'c'.repeat(32) };
  const clients = {
    ros: {
      listStacks: async req => { checked(req); return { body: { stacks: state.function ? [{ stackName: backendNames(config).stackName, stackId: 'stack-123', status: 'CREATE_COMPLETE' }] : [] } }; },
      getStack: async req => { checked(req); return { body: { stackName: backendNames(config).stackName, stackId: 'stack-123', status: state.function ? 'CREATE_COMPLETE' : 'DELETE_COMPLETE', tags: [{ key: 'pi-aliyun-project', value: config.project }] } }; },
      getTemplate: async () => ({ body: { templateBody: { Description: `Managed by pi-aliyun: ${config.project}`, Resources: {
        Function: { Type: 'ALIYUN::FC3::Function', Properties: { FunctionName: config.backend.functionName, Code: { OssBucketName: backendNames(config).codeBucket } } },
        Concurrency: { Type: 'ALIYUN::FC3::ConcurrencyConfig' }, HttpTrigger: { Type: 'ALIYUN::FC3::Trigger' },
        Domain: { Type: 'ALIYUN::FC3::CustomDomain', Properties: { DomainName: config.backend.domain, Protocol: 'HTTPS' } },
      } } } }),
      deleteStack: async req => { checked(req); state.function = false; writes.push('stack'); },
    },
    codeOss: {
      getBucketInfo: async () => state.codeBucket ? { bucket: { Owner: { ID: config.accountId }, Location: config.region } } : absent('NoSuchBucket'),
      getBucketTags: async () => ({ tag: { 'pi-aliyun-project': config.project, 'pi-aliyun-purpose': 'backend-code' } }),
      getBucketACL: async () => ({ acl: 'private' }),
      getBucketVersioning: async () => ({}),
      listV2: async () => ({ objects: state.codeObjects.map(name => ({ name })) }),
      listUploads: async () => ({ uploads: [] }),
      deleteMulti: async items => { state.codeObjects = []; writes.push('code-objects'); return { deleted: items }; },
      deleteBucket: async () => { state.codeBucket = false; writes.push('code-bucket'); },
    },
    oss: {
      getBucketInfo: async () => state.bucket ? { bucket: { Owner: { ID: config.accountId }, Location: `oss-${config.region}` } } : absent('NoSuchBucket'),
      getBucketTags: async () => ({ tag: { 'pi-aliyun-project': state.wrongBucket ? 'another-app' : config.project } }),
      getBucketVersioning: async () => ({ versionStatus: state.versioned ? 'Enabled' : undefined }),
      request: async () => ({ data: { Cname: { Domain: config.frontend.domain } } }),
      listUploads: async () => ({ uploads: state.uploads }),
      listV2: async () => ({ objects: state.objects.map(name => ({ name })) }),
      deleteMulti: async items => { state.objects = []; writes.push('objects'); return { deleted: items }; },
      deleteBucket: async () => { state.bucket = false; writes.push('bucket'); },
    },
    dns: {
      describeDomainRecords: async req => ({ body: { totalCount: records.length, domainRecords: { record: records.filter(r => r.RR === req.RRKeyWord) } } }),
      deleteDomainRecord: async req => { checked(req); records.splice(records.findIndex(r => r.recordId === req.recordId), 1); writes.push('dns'); },
    },
    cas: {
      listUserCertificateOrder: async req => { checked(req); return { body: { totalCount: state.certificate ? 1 : 0, certificateOrderList: state.certificate ? [{ certificateId: 123, commonName: domains[0], sans: domains.join(','), fingerprint: certificate.fingerprint, sha2: certificate.publicKeySha256, serialNo: certificate.serialNumber, upload: true }] : [] } }; },
      listCloudResources: async req => { checked(req); return { body: { total: 0, data: [] } }; },
      deleteUserCertificate: async req => { checked(req); state.certificate = false; writes.push('certificate'); },
    },
  };
  const database = {
    control: {
      listInstances: async req => { checked(req); return { body: { instances: state.database ? [{ instanceName: config.database.instance }] : [] } }; },
      getInstance: async req => { checked(req); return { body: { userId: config.accountId, regionId: config.region, instanceDescription: names.instanceDescription, instanceStatus: state.database === 'pending' ? 'deleting' : 'normal' } }; },
      deleteInstance: async req => { checked(req); state.database = 'pending'; writes.push('database'); },
    },
    data: async (action, args) => {
      if (action === 'listTable') return { tableNames: state.tables };
      assert.equal(action, 'deleteTable'); state.tables = state.tables.filter(t => t !== args.tableName); writes.push('table');
    },
    ram: {
      getRole: async req => { checked(req); return state.role ? { body: { role: { description: `Managed by pi-aliyun: ${config.project}` } } } : absent('EntityNotExist.Role'); },
      listPoliciesForRole: async req => { checked(req); return { body: { policies: { policy: state.attached ? [{ policyType: 'Custom', policyName: names.policyName }] : [] } } }; },
      getPolicy: async req => { checked(req); return state.policy ? { body: { policy: { description: `Managed by pi-aliyun: ${config.project}`, defaultVersion: 'v1' } } } : absent('EntityNotExist.Policy'); },
      listEntitiesForPolicy: async req => { checked(req); return { body: { roles: { role: state.attached ? [{ roleName: names.roleName }] : [] } } }; },
      listPolicies: async req => { checked(req); return { body: { policies: { policy: state.shared ? [{ policyName: 'PiDatabase-pi-aliyun-other', defaultVersion: 'v1' }] : [] } } }; },
      getPolicyVersion: async req => { checked(req); return { body: { policyVersion: { policyDocument: JSON.stringify({ Statement: [{ Resource: [`acs:ots:${config.region}:${config.accountId}:instance/${config.database.instance}/table/*`] }] }) } } }; },
      detachPolicyFromRole: async req => { checked(req); state.attached = false; writes.push('detach'); },
      deleteRole: async req => { checked(req); state.role = false; writes.push('role'); },
      listPolicyVersions: async req => { checked(req); return { body: { policyVersions: { policyVersion: [{ versionId: 'v1', isDefaultVersion: true }, { versionId: 'v2', isDefaultVersion: false }] } } }; },
      deletePolicyVersion: async req => { checked(req); assert.equal(req.versionId, 'v2'); writes.push('version'); },
      deletePolicy: async req => { checked(req); state.policy = false; writes.push('policy'); },
    },
  };
  assert((await inspectApplication(clients, config, path, { database })).ok);
  assert.equal((await applicationCertificates(clients.cas, config, {}))[0].owned, false);
  const manifestPath = join(root, '.aliyun/resources.json');
  const manifest = JSON.parse(await readFile(manifestPath)); manifest.tls.certificates = [certificate]; await writeFile(manifestPath, JSON.stringify(manifest));
  assert((await planDestroy(clients, config, path, { database })).ok);
  assert.deepEqual(writes, []);
  await assert.rejects(destroyApplication(clients, config, path, { database, confirm: 'wrong', registry }), /exact project/);
  for (const flag of ['wrongBucket', 'versioned', 'shared']) {
    state[flag] = true;
    const plan = await planDestroy(clients, config, path, { database });
    assert.equal(plan.ok, false, flag);
    await assert.rejects(destroyApplication(clients, config, path, { database, confirm: config.project, registry }), /preflight/);
    assert.deepEqual(writes, []); state[flag] = false;
  }
  const deleted = await destroyApplication(clients, config, path, { database, confirm: config.project, registry, attempts: 2, wait: async () => { state.database = false; } });
  assert(deleted.deleted);
  for (const item of ['stack', 'code-objects', 'code-bucket', 'objects', 'bucket', 'table', 'database', 'detach', 'role', 'version', 'policy', 'certificate']) assert(writes.includes(item), item);
  assert.deepEqual(JSON.parse(await readFile(registry)).projects, ['/srv/other/aliyun.json']);
  const count = writes.length;
  assert((await destroyApplication(clients, config, path, { database, confirm: config.project, registry })).deleted);
  assert.equal(writes.length, count);
  let probes = 0;
  const verified = await verifyApplication(config, { attempts: 2, wait: async () => {}, probe: async url => ({ url, status: ++probes > 2 ? 200 : 503 }) });
  assert(verified.ok);
  assert(!(await verifyApplication(config, { probe: async () => ({ status: 401 }) })).ok);
  assert(!(await verifyApplication(config, { probe: async () => { throw Object.assign(new Error('TLS failure'), { code: 'CERT_HAS_EXPIRED' }); } })).ok);
  const redacted = JSON.stringify(errorInfo({ code: 'Forbidden', message: 'secret', data: { RequestId: 'request-123', Authorization: 'secret' } }));
  assert(redacted.includes('request-123') && !redacted.includes('secret'));
  console.log('Operations smoke passed: read-only status/preview, foreign/shared/versioned resource refusal, complete deletion, asynchronous release, retry after deletion, renewal removal, certificate ownership and HTTPS failure handling. No cloud APIs called.');
} finally { await rm(root, { recursive: true, force: true }); }
