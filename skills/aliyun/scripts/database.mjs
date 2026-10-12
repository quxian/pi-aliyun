import TablestoreModule, * as OTS from '@alicloud/tablestore20201209';
import RAMModule, * as RAM from '@alicloud/ram20150501';
import TableStore from 'tablestore';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { databaseAccess, databaseEnvironment, databaseNames } from './database-plan.mjs';

const Client = (module) => module.default || module;
const marker = 'Managed by pi-aliyun databases';
const invoke = (client, action, params) => new Promise((resolve, reject) => client[action](params, (error, data) => error ? reject(error) : resolve(data)));
export function createDatabaseClients(config, credential) {
  return {
    control: new (Client(TablestoreModule))({ credential, regionId: config.region, endpoint: `tablestore.${config.region}.aliyuncs.com`, protocol: 'https' }),
    ram: new (Client(RAMModule))({ credential, endpoint: 'ram.aliyuncs.com', protocol: 'https' }),
    data: async (action, params) => {
      // Resolve again for every operation so a long-running deployment never pins an expired STS token.
      const key = await credential.getCredential();
      const client = new TableStore.Client({ accessKeyId: key.accessKeyId, secretAccessKey: key.accessKeySecret, stsToken: key.securityToken,
        endpoint: databaseEnvironment(config).TABLESTORE_ENDPOINT, instancename: config.database.instance,
        maxRetries: 2, httpOptions: { timeout: 15000 } });
      return invoke(client, action, params);
    },
  };
}

async function instanceInfo(control, config) {
  let nextToken;
  do {
    const response = await control.listInstances(new OTS.ListInstancesRequest({ instanceName: config.database.instance, maxResults: 100, nextToken }));
    if (response.body?.instances?.some((item) => item.instanceName === config.database.instance)) {
      const { body } = await control.getInstance(new OTS.GetInstanceRequest({ instanceName: config.database.instance }));
      if (body?.userId !== config.accountId || body.regionId !== config.region) throw new Error('Tablestore account or region mismatch');
      if (body.instanceDescription !== marker) throw new Error('Existing Tablestore instance is not managed by pi-aliyun; choose a new dedicated instance');
      if (body.instanceSpecification !== config.database.clusterType || body.paymentType !== 'PayAsYouGo' || Number(body.VCUQuota || 0) > 0) throw new Error('Tablestore instance is not the approved CU billing/type configuration');
      if (body.instanceStatus !== 'normal') throw new Error('Tablestore instance is not available; check its status before retrying');
      return body;
    }
    nextToken = response.body?.nextToken;
  } while (nextToken);
  return undefined;
}

export function createTableInput(config, table) {
  return { tableMeta: { tableName: databaseNames(config).prefix + table.name, primaryKey: table.primaryKey },
    reservedThroughput: { capacityUnit: { read: 0, write: 0 } }, tableOptions: { timeToLive: -1, maxVersions: 1 } };
}
export function checkTable(actual, expected) {
  const keys = actual.tableMeta?.primaryKey?.map(({ name, type }) => ({ name, type: typeof type === 'number' ? Object.keys(TableStore.PrimaryKeyType).find((key) => TableStore.PrimaryKeyType[key] === type) : type }));
  const capacity = actual.reservedThroughputDetails?.capacityUnit;
  if (!isDeepStrictEqual(keys, expected.tableMeta.primaryKey) || actual.tableOptions?.timeToLive !== -1 || actual.tableOptions?.maxVersions !== 1 || capacity?.read !== 0 || capacity?.write !== 0 || actual.indexMetas?.length || actual.streamDetails?.enableStream) {
    throw new Error(`Existing table ${expected.tableMeta.tableName} differs from the approved schema/cost settings; no automatic migration, reset or deletion is allowed`);
  }
}
async function tableInfo(data, input) {
  try { const actual = await data('describeTable', { tableName: input.tableMeta.tableName }); checkTable(actual, input); return actual; }
  catch (error) { if (error.code === 'OTSObjectNotExist') return undefined; throw error; }
}

function document(value) {
  if (typeof value !== 'string') throw new Error('RAM returned a missing policy document');
  try { return JSON.parse(value); } catch { return JSON.parse(decodeURIComponent(value)); }
}
function normalizedPolicy(policy) {
  const list = (value) => Array.isArray(value) ? value : [value];
  const statements = list(policy.Statement).map((source) => {
    const statement = { ...source };
    // The RAM console collapses one-element lists; their authorization meaning is unchanged.
    for (const key of ['Action', 'NotAction', 'Resource', 'NotResource']) {
      if (Object.hasOwn(statement, key)) statement[key] = list(statement[key]).sort();
    }
    for (const key of ['Principal', 'NotPrincipal']) {
      if (statement[key] && typeof statement[key] === 'object') {
        statement[key] = Object.fromEntries(Object.entries(statement[key]).map(([type, value]) => [type, list(value).sort()]));
      }
    }
    return statement;
  });
  return { ...policy, Statement: statements };
}
function policyEqual(actual, expected) { return isDeepStrictEqual(normalizedPolicy(document(actual)), normalizedPolicy(expected)); }
export async function verifyDatabaseRole(ram, config) {
  const access = databaseAccess(config);
  const role = (await ram.getRole(new RAM.GetRoleRequest({ roleName: access.roleName }))).body?.role;
  if (!policyEqual(role?.assumeRolePolicyDocument, access.trustPolicy)) throw new Error('Database runtime role trust differs from db-plan; administrator review is required');
  const attached = (await ram.listPoliciesForRole(new RAM.ListPoliciesForRoleRequest({ roleName: access.roleName }))).body?.policies?.policy;
  if (!attached || attached.length !== 1 || attached[0].policyName !== access.policyName || attached[0].policyType !== 'Custom') throw new Error('Database runtime role must have only its project policy from db-plan');
  const policy = (await ram.getPolicy(new RAM.GetPolicyRequest({ policyType: 'Custom', policyName: access.policyName }))).body?.policy;
  const version = (await ram.getPolicyVersion(new RAM.GetPolicyVersionRequest({ policyType: 'Custom', policyName: access.policyName, versionId: policy?.defaultVersion }))).body?.policyVersion;
  if (!policyEqual(version?.policyDocument, access.runtimePolicy)) throw new Error('Database runtime policy differs from the approved project scope');
}

// This command uses a separately authorized administrator identity. It is never called by deploy.
export async function bootstrapDatabaseRole(ram, config) {
  const a = databaseAccess(config);
  const description = `Managed by pi-aliyun: ${config.project}`;
  try {
    const role = (await ram.getRole(new RAM.GetRoleRequest({ roleName: a.roleName }))).body?.role;
    if (role?.description !== description || !policyEqual(role?.assumeRolePolicyDocument, a.trustPolicy)) throw new Error('Existing role is not the expected pi-aliyun project role');
    const existing = (await ram.listPoliciesForRole(new RAM.ListPoliciesForRoleRequest({ roleName: a.roleName }))).body?.policies?.policy || [];
    if (existing.some((policy) => policy.policyName !== a.policyName || policy.policyType !== 'Custom')) throw new Error('Existing role has additional policies; administrator review is required before modifying it');
  } catch (error) {
    if (error.code !== 'EntityNotExist.Role') throw error;
    await ram.createRole(new RAM.CreateRoleRequest({ roleName: a.roleName, description, assumeRolePolicyDocument: JSON.stringify(a.trustPolicy) }));
  }
  try {
    const policy = (await ram.getPolicy(new RAM.GetPolicyRequest({ policyType: 'Custom', policyName: a.policyName }))).body?.policy;
    const version = (await ram.getPolicyVersion(new RAM.GetPolicyVersionRequest({ policyType: 'Custom', policyName: a.policyName, versionId: policy?.defaultVersion }))).body?.policyVersion;
    if (!policyEqual(version?.policyDocument, a.runtimePolicy)) throw new Error('Existing policy differs; refusing to replace permissions');
  } catch (error) {
    if (error.code !== 'EntityNotExist.Policy') throw error;
    await ram.createPolicy(new RAM.CreatePolicyRequest({ policyName: a.policyName, description, policyDocument: JSON.stringify(a.runtimePolicy) }));
  }
  await ram.attachPolicyToRole(new RAM.AttachPolicyToRoleRequest({ roleName: a.roleName, policyType: 'Custom', policyName: a.policyName }));
  await verifyDatabaseRole(ram, config);
  console.log(`Database runtime role ready: ${a.roleName}`);
}

export async function inspectDatabase(clients, config) {
  const result = { instance: config.database.instance, tables: [], issues: [] };
  // Collect independent permission failures so the operator can request them together.
  try { await verifyDatabaseRole(clients.ram, config); result.runtimeRole = 'ready'; }
  catch (error) { result.issues.push({ component: 'runtimeRole', code: error.code || 'ConfigurationMismatch', message: error.code ? 'Review the RAM role and deployment statements in db-plan' : error.message }); }
  try {
    const exists = await instanceInfo(clients.control, config);
    result.instanceState = exists ? 'ready' : 'will-create';
    if (exists) for (const table of config.database.tables) {
      const input = createTableInput(config, table);
      const current = await tableInfo(clients.data, input);
      result.tables.push({ name: input.tableMeta.tableName, state: !current ? 'will-create' : current.tableStatus === 1 ? 'ready' : 'not-active' });
    }
  } catch (error) { result.issues.push({ component: 'tablestore', code: error.code || 'ConfigurationMismatch', message: error.code ? 'Review Tablestore service activation and the deployment statements in db-plan' : error.message }); }
  return result;
}

export async function provisionDatabase(clients, config, { wait = () => delay(3000), attempts = 20, dnsAttempts = 200 } = {}) {
  await verifyDatabaseRole(clients.ram, config);
  const exists = await instanceInfo(clients.control, config);
  const inputs = config.database.tables.map((table) => createTableInput(config, table));
  const describe = async (input) => {
    for (let attempt = 0; ; attempt++) {
      try { return await tableInfo(clients.data, input); }
      catch (error) {
        // A newly created instance can be visible in the control API before its DNS propagates.
        if (error.code !== 'NetworkingError' || error.syscall !== 'getaddrinfo' || attempt >= dnsAttempts - 1) throw error;
        if (attempt === 0) console.log(`Waiting for Tablestore DNS: ${config.database.instance}`);
        await wait();
      }
    }
  };
  // Validate all existing tables before creating anything, rather than partially applying a changed schema.
  const missing = [];
  for (const input of inputs) {
    const current = exists ? await describe(input) : undefined;
    if (!current) missing.push(input);
    else if (current.tableStatus !== 1) throw new Error(`Table ${input.tableMeta.tableName} is not active; retry after initialization or resolve its status`);
  }
  if (!exists) {
    const created = await clients.control.createInstance(new OTS.CreateInstanceRequest({ instanceName: config.database.instance, clusterType: config.database.clusterType, instanceDescription: marker,
      networkTypeACL: ['INTERNET', 'VPC'], networkSourceACL: [] }));
    if (created?.body?.code && String(created.body.code) !== '200') throw Object.assign(new Error('Tablestore instance creation failed'), { code: created.body.code, data: {} });
    let ready;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await instanceInfo(clients.control, config)) { ready = true; break; }
      if (attempt < attempts - 1) await wait();
    }
    if (!ready) throw new Error('Tablestore creation is pending; retry after it becomes available');
  }
  for (const input of missing) {
    if (!exists && await describe(input)) continue;
    await clients.data('createTable', input);
    let ready;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if ((await tableInfo(clients.data, input))?.tableStatus === 1) { ready = true; break; }
      if (attempt < attempts - 1) await wait();
    }
    if (!ready) throw new Error(`Table ${input.tableMeta.tableName} is still initializing; retry deployment later`);
  }
  console.log(`Database ready: ${config.database.instance}; ${inputs.length} project tables; reserved CU 0; persistent data retained.`);
  return databaseEnvironment(config);
}
