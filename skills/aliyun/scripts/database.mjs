import TablestoreModule, * as OTS from '@alicloud/tablestore20201209';
import RAMModule from '@alicloud/ram20150501';
import { verifyDatabaseRole, bootstrapDatabaseRole } from './database-role.mjs';
export { verifyDatabaseRole, bootstrapDatabaseRole } from './database-role.mjs';
import TableStore from 'tablestore';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { databaseAccess, databaseEnvironment, databaseNames } from './database-plan.mjs';
import { createTablestoreClient } from '../assets/tablestore-runtime.mjs';

const Client = (module) => module.default || module;
const invoke = (client, action, params) => new Promise((resolve, reject) => client[action](params, (error, data) => error ? reject(error) : resolve(data)));
export function createDatabaseClients(config, credential) {
  return {
    control: new (Client(TablestoreModule))({ credential, regionId: config.region, endpoint: `tablestore.${config.region}.aliyuncs.com`, protocol: 'https' }),
    ram: new (Client(RAMModule))({ credential, endpoint: 'ram.aliyuncs.com', protocol: 'https' }),
    data: async (action, params) => {
      // Resolve again for every operation so a long-running deployment never pins an expired STS token.
      const key = await credential.getCredential();
      const client = createTablestoreClient({ accessKeyId: key.accessKeyId, secretAccessKey: key.accessKeySecret, stsToken: key.securityToken,
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
      if (body.instanceDescription !== databaseNames(config).instanceDescription) throw new Error('Existing Tablestore instance belongs to a different application; choose an owned instance or explicitly declare sharing');
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

export async function inspectDatabase(clients, config) {
  const result = { instance: config.database.instance, tables: [], issues: [] };
  // Report independent configuration and permission failures together.
  try { await verifyDatabaseRole(clients.ram, config); result.runtimeRole = 'ready'; }
  catch (error) {
    if (error.code === 'EntityNotExist.Role') result.runtimeRole = 'will-create';
    else result.issues.push({ component: 'runtimeRole', code: error.code || 'ConfigurationMismatch', message: error.code ? 'Review the account deployment permissions and application role' : error.message });
  }
  try {
    const exists = await instanceInfo(clients.control, config);
    result.instanceState = exists ? 'ready' : 'will-create';
    if (exists) for (const table of config.database.tables) {
      const input = createTableInput(config, table);
      const current = await tableInfo(clients.data, input);
      result.tables.push({ name: input.tableMeta.tableName, state: !current ? 'will-create' : current.tableStatus === 1 ? 'ready' : 'not-active' });
    }
  } catch (error) { result.issues.push({ component: 'tablestore', code: error.code || 'ConfigurationMismatch', message: error.code ? 'Review Tablestore service activation and the account deployment policy' : error.message }); }
  return result;
}

export async function provisionDatabase(clients, config, { wait = () => delay(3000), attempts = 20, dnsAttempts = 200 } = {}) {
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
  await bootstrapDatabaseRole(clients.ram, config);
  if (!exists) {
    const created = await clients.control.createInstance(new OTS.CreateInstanceRequest({ instanceName: config.database.instance, clusterType: config.database.clusterType, instanceDescription: databaseNames(config).instanceDescription,
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
