import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import TableStore from 'tablestore';
import Proto from 'tablestore/lib/protocol/tablestore_compiled_proto.js';
import { validateConfig } from '../skills/aliyun/scripts/config.mjs';
import { databasePlan, databaseAccess, approveDatabase, requireDatabaseApproval, databaseEnvironment } from '../skills/aliyun/scripts/database-plan.mjs';
import { provisionDatabase, createTableInput, checkTable, inspectDatabase, bootstrapDatabaseRole } from '../skills/aliyun/scripts/database.mjs';
import { databaseForRequest } from '../skills/aliyun/assets/tablestore-runtime.mjs';

const temp = await mkdtemp(join(tmpdir(), 'pi-aliyun-db-smoke-'));
try {
  const raw = JSON.parse(await readFile(new URL('../examples/durable-notes/aliyun.example.json', import.meta.url), 'utf8'));
  const config = validateConfig(raw, temp);
  const plan = databasePlan(config);
  const a = databaseAccess(config);
  assert.equal(plan.cost.estimated30Days, 0.308);
  assert(a.runtimePolicy.Statement.every((s) => s.Resource.every((r) => r.includes(`/table/${a.prefix}`))));
  assert(!JSON.stringify(a.deploymentStatements).includes('ram:Create'));
  assert(!JSON.stringify(a.runtimePolicy).includes('ots:CreateTable'));
  assert.throws(() => validateConfig({ ...raw, database: { ...raw.database, instance: 'pi-aliyun' } }, temp), /reserved words/);
  assert.throws(() => validateConfig({ ...raw, backend: { ...raw.backend, environment: { TABLESTORE_ENDPOINT: 'https://attacker.invalid' } } }, temp), /conflicting/);
  const path = join(temp, 'aliyun.json');
  await assert.rejects(requireDatabaseApproval(config, path), /No cloud writes/);
  await assert.rejects(approveDatabase(config, path, 'wrong'), /fingerprint/);
  await approveDatabase(config, path, plan.fingerprint);
  await requireDatabaseApproval(config, path);
  assert.equal((await stat(join(temp, '.aliyun/database-approval.json'))).mode & 0o777, 0o600);
  const changed = validateConfig({ ...raw, database: { ...raw.database, clusterType: 'HYBRID' } }, temp);
  await assert.rejects(requireDatabaseApproval(changed, path), /changed/);

  // Exercise the real protobuf encoder/decoder with the patched protobufjs dependency.
  const input = createTableInput(config, config.database.tables[0]);
  const encoded = Proto.main.proto.CreateTableRequest.encode(TableStore.encoder.encode('createTable', input)).finish();
  const roundTrip = Proto.main.proto.CreateTableRequest.decode(encoded);
  assert.equal(roundTrip.reservedThroughput.capacityUnit.read, 0);
  assert.equal(roundTrip.tableOptions.timeToLive, -1);
  assert.equal(roundTrip.tableMeta.primaryKey[0].type, TableStore.PrimaryKeyType.STRING);
  const wireTable = Proto.main.proto.DescribeTableResponse.encode({
    tableMeta: roundTrip.tableMeta, reservedThroughputDetails: { capacityUnit: { read: 0, write: 0 }, lastIncreaseTime: 0, lastDecreaseTime: 0, numberOfDecreasesToday: 0 },
    tableOptions: { timeToLive: -1, maxVersions: 1 }, tableStatus: 1,
  }).finish();
  const actual = TableStore.decoder.decode('describeTable', wireTable);
  checkTable(actual, input);
  assert.throws(() => checkTable({ ...actual, tableOptions: { timeToLive: 60, maxVersions: 1 } }, input), /no automatic/);
  assert.throws(() => checkTable({ ...actual, reservedThroughputDetails: { capacityUnit: { read: 1, write: 0 } } }, input), /cost/);

  const missing = (code) => Object.assign(new Error('not found'), { code });
  let roleExists = false; let policyExists = false; let attached = false;
  const ram = {
    getRole: async () => { if (!roleExists) throw missing('EntityNotExist.Role'); return { body: { role: { description: `Managed by pi-aliyun: ${config.project}`, assumeRolePolicyDocument: JSON.stringify(a.trustPolicy) } } }; },
    createRole: async (request) => { request.validate(); roleExists = true; },
    getPolicy: async () => { if (!policyExists) throw missing('EntityNotExist.Policy'); return { body: { policy: { defaultVersionId: 'v1' } } }; },
    createPolicy: async (request) => { request.validate(); policyExists = true; },
    getPolicyVersion: async () => ({ body: { policyVersion: { policyDocument: JSON.stringify(a.runtimePolicy) } } }),
    attachPolicyToRole: async (request) => { request.validate(); attached = true; },
    listPoliciesForRole: async () => ({ body: { policies: { policy: attached ? [{ policyName: a.policyName, policyType: 'Custom' }] : [] } } }),
  };
  await bootstrapDatabaseRole(ram, config);
  await bootstrapDatabaseRole(ram, config);
  let exists = false; let tableExists = false; const writes = [];
  const clients = { ram,
    control: {
      listInstances: async () => ({ body: { instances: exists ? [{ instanceName: config.database.instance }] : [] } }),
      getInstance: async () => ({ body: { userId: config.accountId, regionId: config.region, instanceDescription: 'Managed by pi-aliyun databases', instanceSpecification: 'SSD', paymentType: 'PayAsYouGo', instanceStatus: 'normal' } }),
      createInstance: async (request) => { request.validate(); assert.equal(request.clusterType, 'SSD'); writes.push('instance'); exists = true; },
    },
    data: async (action, params) => {
      if (action === 'createTable') { assert.equal(params.reservedThroughput.capacityUnit.read, 0); writes.push('table'); tableExists = true; return {}; }
      assert.equal(action, 'describeTable');
      if (!tableExists) throw missing('OTSObjectNotExist');
      return actual;
    },
  };
  const before = await inspectDatabase(clients, config);
  assert.equal(before.instanceState, 'will-create');
  assert.deepEqual(writes, []);
  await provisionDatabase(clients, config, { wait: async () => {} });
  await provisionDatabase(clients, config, { wait: async () => {} });
  assert.deepEqual(writes, ['instance', 'table']);
  const bothFail = await inspectDatabase({ ...clients, ram: { ...ram, getRole: async () => { throw missing('Forbidden'); } }, control: { listInstances: async () => { throw missing('Forbidden'); } } }, config);
  assert.equal(bothFail.issues.length, 2);
  await assert.rejects(provisionDatabase({ ...clients, data: async () => ({ ...actual, tableOptions: { timeToLive: 60, maxVersions: 1 } }) }, config), /no automatic/);
  assert.deepEqual(writes, ['instance', 'table']);

  const env = databaseEnvironment(config);
  assert.throws(() => databaseForRequest({ headers: {} }, env), /credentials/);
  const db = databaseForRequest({ headers: { 'x-fc-access-key-id': 'temporary-id', 'x-fc-access-key-secret': 'temporary-secret', 'x-fc-security-token': 'temporary-token' } }, env);
  assert.equal(db.client.config.stsToken, 'temporary-token');
  const next = databaseForRequest({ headers: { 'x-fc-access-key-id': 'next-id', 'x-fc-access-key-secret': 'next-secret', 'x-fc-security-token': 'next-token' } }, env);
  assert.equal(next.client.config.stsToken, 'next-token');
  assert.equal(db.client.config.stsToken, 'temporary-token');
  console.log('Database smoke passed: approval invalidation, least-privilege plan, real SDK protobuf codec, role initialization, create/redeploy without data deletion, schema drift refusal, grouped permission errors and request-scoped credentials. No cloud APIs called.');
} finally { await rm(temp, { recursive: true, force: true }); }
