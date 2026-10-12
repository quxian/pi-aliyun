import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import TableStore from 'tablestore';
import Proto from 'tablestore/lib/protocol/tablestore_compiled_proto.js';
import { validateConfig } from '../skills/aliyun/scripts/config.mjs';
import { databasePlan, databaseAccess, databaseEnvironment, databaseNames, validateDatabaseShared } from '../skills/aliyun/scripts/database-plan.mjs';
import { provisionDatabase, createTableInput, checkTable, inspectDatabase, bootstrapDatabaseRole, verifyDatabaseRole } from '../skills/aliyun/scripts/database.mjs';
import { databaseForRequest } from '../skills/aliyun/assets/tablestore-runtime.mjs';

const temp = await mkdtemp(join(tmpdir(), 'pi-aliyun-db-smoke-'));
try {
  const raw = JSON.parse(await readFile(new URL('../examples/durable-notes/aliyun.example.json', import.meta.url), 'utf8'));
  raw.project = 'pi-aliyun-notes';
  delete raw.database.instance;
  const config = validateConfig(raw, temp);
  const plan = databasePlan(config);
  const a = databaseAccess(config);
  assert.equal(plan.cost.estimated30Days, 0.308);
  assert(a.runtimePolicy.Statement.every((s) => s.Resource.every((r) => r.includes(`/table/${a.prefix}`))));
  assert(!JSON.stringify(a.runtimePolicy).includes('ots:CreateTable'));
  assert.throws(() => validateConfig({ ...raw, database: { ...raw.database, instance: 'pi-aliyun' } }, temp), /reserved words/);
  assert.throws(() => validateConfig({ ...raw, backend: { ...raw.backend, environment: { TABLESTORE_ENDPOINT: 'https://attacker.invalid' } } }, temp), /conflicting/);
  assert.equal(config.database.instance, 'pi-app-8035e383');
  assert.equal(databaseNames(config).prefix, 'pi_pi_aliyun_notes_8035e383_');
  const independent = validateConfig({ ...raw, project: 'pi-aliyun-ledger' }, temp);
  assert.notEqual(independent.database.instance, config.database.instance);
  assert.notEqual(databaseNames(independent).prefix, a.prefix);
  assert(!JSON.stringify(databaseAccess(independent).runtimePolicy).includes(`/instance/${config.database.instance}/`));
  const shared = validateConfig({ ...raw, project: 'pi-aliyun-worker', database: { ...raw.database, shared: { ownerProject: raw.project, reason: 'The worker and notes are explicitly one application system' } } }, temp);
  assert.equal(shared.database.instance, config.database.instance);
  assert.equal(databaseNames(shared).prefix, a.prefix);
  assert.notEqual(databaseNames(shared).roleName, a.roleName);
  assert.equal(databasePlan(shared).ownership, 'explicitly-shared');
  assert.deepEqual(databaseAccess(shared).runtimePolicy, a.runtimePolicy);
  assert.equal(databasePlan(config).ownership, 'application');
  assert.equal(validateDatabaseShared(shared), shared.database.shared);
  for (const declared of [true, { ownerProject: raw.project, reason: 'same app' }, { ownerProject: 'other', reason: '  ' }, { ownerProject: 'other', reason: 'x'.repeat(501) }, { ownerProject: 'bad/name', reason: 'same system' }, { ownerProject: 'other', reason: 'same system', extra: true }]) {
    assert.throws(() => validateConfig({ ...raw, database: { ...raw.database, shared: declared } }, temp), /shared/);
  }
  const custom = validateConfig({ ...raw, database: { ...raw.database, instance: 'custom-notes' } }, temp);
  assert.equal(custom.database.instance, 'custom-notes');
  assert.equal(databaseNames(custom).ownerProject, raw.project);

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
  const description = `Managed by pi-aliyun: ${config.project}`;
  let runtimeDocument = JSON.stringify(a.runtimePolicy); let defaultVersion = 'v1';
  let versions = [{ versionId: 'v1', isDefaultVersion: true, createDate: '2026-01-01' }];
  const roleWrites = [];
  const ram = {
    getRole: async () => { if (!roleExists) throw missing('EntityNotExist.Role'); return { body: { role: { description, assumeRolePolicyDocument: JSON.stringify(a.trustPolicy) } } }; },
    createRole: async (request) => { request.validate(); roleExists = true; roleWrites.push('role'); },
    getPolicy: async () => { if (!policyExists) throw missing('EntityNotExist.Policy'); return { body: { policy: { description, defaultVersion } } }; },
    createPolicy: async (request) => { request.validate(); policyExists = true; roleWrites.push('policy'); },
    getPolicyVersion: async (request) => { assert.equal(request.versionId, defaultVersion); return { body: { policyVersion: { policyDocument: runtimeDocument } } }; },
    listPolicyVersions: async (request) => { request.validate(); return { body: { policyVersions: { policyVersion: versions } } }; },
    deletePolicyVersion: async (request) => { request.validate(); assert.notEqual(request.versionId, defaultVersion); roleWrites.push(`delete:${request.versionId}`); versions = versions.filter((item) => item.versionId !== request.versionId); },
    createPolicyVersion: async (request) => { request.validate(); assert.equal(request.setAsDefault, true); assert(versions.length < 5); roleWrites.push('version'); runtimeDocument = request.policyDocument; versions.forEach((item) => { item.isDefaultVersion = false; }); defaultVersion = 'v6'; versions.push({ versionId: 'v6', isDefaultVersion: true, createDate: '2026-10-12' }); },
    attachPolicyToRole: async (request) => { request.validate(); attached = true; roleWrites.push('attach'); },
    listEntitiesForPolicy: async (request) => { request.validate(); return { body: { roles: { role: attached ? [{ roleName: a.roleName }] : [] } } }; },
    listPoliciesForRole: async () => ({ body: { policies: { policy: attached ? [{ policyName: a.policyName, policyType: 'Custom' }] : [] } } }),
  };
  await bootstrapDatabaseRole(ram, config);
  await bootstrapDatabaseRole(ram, config);
  assert.deepEqual(roleWrites, ['role', 'policy', 'attach']);
  runtimeDocument = JSON.stringify(databaseAccess({ ...config, database: { ...config.database, instance: 'pi-app-other' } }).runtimePolicy);
  versions = Array.from({ length: 5 }, (_, index) => ({ versionId: `v${index + 1}`, isDefaultVersion: index === 4, createDate: `2026-01-0${index + 1}` }));
  defaultVersion = 'v5';
  await bootstrapDatabaseRole(ram, config);
  assert.deepEqual(roleWrites, ['role', 'policy', 'attach', 'delete:v1', 'version']);
  assert.equal(versions.length, 5);
  assert(versions.some((item) => item.versionId === 'v5'));
  assert.equal(runtimeDocument, JSON.stringify(a.runtimePolicy));
  const writeCount = roleWrites.length;
  await assert.rejects(bootstrapDatabaseRole({ ...ram, getRole: async () => ({ body: { role: { description: 'not owned', assumeRolePolicyDocument: JSON.stringify(a.trustPolicy) } } }) }, config), /expected.*role/);
  await assert.rejects(bootstrapDatabaseRole({ ...ram, getPolicy: async () => ({ body: { policy: { description: 'not owned', defaultVersion } } }) }, config), /not owned/);
  await assert.rejects(bootstrapDatabaseRole({ ...ram, listPoliciesForRole: async () => ({ body: { policies: { policy: [{ policyName: 'AdministratorAccess', policyType: 'System' }] } } }) }, config), /additional policies/);
  await assert.rejects(bootstrapDatabaseRole({ ...ram, listEntitiesForPolicy: async () => ({ body: { roles: { role: [{ roleName: 'another-role' }] } } }) }, config), /additional bindings/);
  await assert.rejects(bootstrapDatabaseRole({ ...ram, listEntitiesForPolicy: async () => ({ body: { users: { user: [{ userName: 'someone' }] } } }) }, config), /additional bindings/);
  assert.equal(roleWrites.length, writeCount);
  const consoleTrust = structuredClone(a.trustPolicy);
  consoleTrust.Statement[0].Action = 'sts:AssumeRole';
  consoleTrust.Statement[0].Principal.Service = 'fc.aliyuncs.com';
  const consolePolicy = structuredClone(a.runtimePolicy);
  consolePolicy.Statement[0].Resource = consolePolicy.Statement[0].Resource[0];
  const consoleRam = { ...ram,
    getRole: async () => ({ body: { role: { description, assumeRolePolicyDocument: JSON.stringify(consoleTrust) } } }),
    getPolicyVersion: async () => ({ body: { policyVersion: { policyDocument: JSON.stringify(consolePolicy) } } }),
  };
  await verifyDatabaseRole(consoleRam, config);
  consoleTrust.Statement[0].Principal.Service = ['fc.aliyuncs.com', 'ecs.aliyuncs.com'];
  await assert.rejects(verifyDatabaseRole(consoleRam, config), /trust differs/);
  let exists = false; let tableExists = false; let dnsPending = true; const writes = [];
  const clients = { ram,
    control: {
      listInstances: async () => ({ body: { instances: exists ? [{ instanceName: config.database.instance }] : [] } }),
      getInstance: async () => ({ body: { userId: config.accountId, regionId: config.region, instanceDescription: a.instanceDescription, instanceSpecification: 'SSD', paymentType: 'PayAsYouGo', instanceStatus: 'normal' } }),
      createInstance: async (request) => { request.validate(); assert.equal(request.clusterType, 'SSD'); assert.equal(request.instanceDescription, a.instanceDescription); assert.deepEqual(request.networkTypeACL, ['INTERNET', 'VPC']); assert.deepEqual(request.networkSourceACL, []); writes.push('instance'); exists = true; },
    },
    data: async (action, params) => {
      if (action === 'createTable') { assert.equal(params.reservedThroughput.capacityUnit.read, 0); writes.push('table'); tableExists = true; return {}; }
      assert.equal(action, 'describeTable');
      if (dnsPending) { dnsPending = false; throw Object.assign(new Error('DNS pending'), { code: 'NetworkingError', syscall: 'getaddrinfo' }); }
      if (!tableExists) throw missing('OTSObjectNotExist');
      return actual;
    },
  };
  const before = await inspectDatabase(clients, config);
  assert.equal(before.instanceState, 'will-create');
  assert.deepEqual(writes, []);
  let waits = 0;
  await provisionDatabase(clients, config, { wait: async () => { waits++; } });
  assert.equal(waits, 1);
  await provisionDatabase(clients, config, { wait: async () => {} });
  assert.deepEqual(writes, ['instance', 'table']);
  for (const instanceDescription of ['Managed by pi-aliyun databases', databaseNames(independent).instanceDescription, 'not managed']) {
    const wrongOwner = { ...clients, control: { ...clients.control, getInstance: async () => ({ body: { ...(await clients.control.getInstance()).body, instanceDescription } }) } };
    await assert.rejects(provisionDatabase(wrongOwner, config), /different application/);
  }
  assert.deepEqual(writes, ['instance', 'table']);
  const bothFail = await inspectDatabase({ ...clients, ram: { ...ram, getRole: async () => { throw missing('Forbidden'); } }, control: { listInstances: async () => { throw missing('Forbidden'); } } }, config);
  assert.equal(bothFail.issues.length, 2);
  await assert.rejects(provisionDatabase({ ...clients, data: async () => ({ ...actual, tableOptions: { timeToLive: 60, maxVersions: 1 } }) }, config), /no automatic/);
  assert.deepEqual(writes, ['instance', 'table']);

  const env = databaseEnvironment(config);
  assert.throws(() => databaseForRequest({ headers: {} }, env), /credentials/);
  const db = databaseForRequest({ headers: { 'x-fc-access-key-id': 'temporary-id', 'x-fc-access-key-secret': 'temporary-secret', 'x-fc-security-token': 'temporary-token' } }, env);
  assert.equal(db.client.config.stsToken, 'temporary-token');
  const protobufError = { httpResponse: { statusCode: 404, headers: {}, body: Proto.main.proto.Error.encode({ code: 'OTSObjectNotExist', message: 'Requested table does not exist.' }).finish() } };
  db.client.extractError(protobufError);
  assert.equal(protobufError.error.code, 'OTSObjectNotExist');
  assert.equal(protobufError.error.statusCode, 404);
  const xmlError = { httpResponse: { statusCode: 403, headers: {}, body: Buffer.from('<Error><Code>OTSAuthFailed</Code><Message>Denied</Message></Error>') } };
  db.client.extractError(xmlError);
  assert.equal(xmlError.error.code, 403);
  assert.equal(xmlError.error.statusCode, 403);
  const next = databaseForRequest({ headers: { 'x-fc-access-key-id': 'next-id', 'x-fc-access-key-secret': 'next-secret', 'x-fc-security-token': 'next-token' } }, env);
  assert.equal(next.client.config.stsToken, 'next-token');
  assert.equal(db.client.config.stsToken, 'temporary-token');
  console.log('Database smoke passed: independent instances, explicit sharing, ownership enforcement, least-privilege plan, real SDK protobuf codec, safe role policy rotation, create/redeploy without data deletion, schema drift refusal, grouped permission errors and request-scoped credentials. No cloud APIs called.');
} finally { await rm(temp, { recursive: true, force: true }); }
