import { createHash } from 'node:crypto';

const fail = (message) => { throw new Error(message); };
function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown ${label} field: ${key}`);
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
export function databaseNames(config) {
  const suffix = `${config.project.slice(0, 32)}-${hash(config.project).slice(0, 8)}`;
  const roleName = `pi-db-${suffix}`;
  const ownerProject = config.database?.shared?.ownerProject || config.project;
  const ownerSuffix = `${ownerProject.slice(0, 32)}-${hash(ownerProject).slice(0, 8)}`;
  const prefix = `pi_${ownerSuffix.replaceAll('-', '_')}_`;
  return { ownerProject, instanceName: `pi-app-${hash(ownerProject).slice(0, 8)}`, instanceDescription: `Managed by pi-aliyun application: ${ownerProject}`,
    roleName, policyName: `PiDatabase-${suffix}`, prefix, roleArn: `acs:ram::${config.accountId}:role/${roleName}` };
}

export function validateDatabaseShared(config) {
  const shared = config.database?.shared;
  if (shared !== undefined) {
    fields(shared, ['ownerProject', 'reason'], 'database.shared');
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(shared.ownerProject || '')) fail('database.shared.ownerProject must name the application that owns the shared database');
    if (shared.ownerProject === config.project) fail('database.shared.ownerProject must name another application; omit shared for an independent database');
    if (typeof shared.reason !== 'string' || !shared.reason.trim() || shared.reason.length > 500) fail('database.shared.reason must describe the explicit reason for sharing in 1–500 characters');
  }
  return shared;
}

export function validateDatabase(config) {
  const d = config.database;
  if (!d) return;
  if (!config.backend) fail('database requires a backend');
  fields(d, ['kind', 'instance', 'clusterType', 'tables', 'usage', 'shared'], 'database');
  if (d.kind !== 'tablestore') fail('Managed database.kind must be tablestore; use backend.envFrom for an existing SQL connection and review a separate RDS purchase when SQL is required');
  d.clusterType ??= 'SSD';
  if (!['SSD', 'HYBRID'].includes(d.clusterType)) fail('database.clusterType must be SSD or HYBRID (CU billing only)');
  validateDatabaseShared(config);
  d.instance ??= databaseNames(config).instanceName;
  if (!/^[a-z][a-z0-9-]{1,14}[a-z0-9]$/.test(d.instance) || /ali|ay|ots|taobao|admin/.test(d.instance)) fail('database.instance must satisfy Tablestore naming rules: 3–16 characters, no reserved words');
  if (!Array.isArray(d.tables) || d.tables.length < 1 || d.tables.length > 64) fail('database.tables must declare 1–64 tables');
  const names = new Set();
  for (const table of d.tables) {
    fields(table, ['name', 'primaryKey'], 'database.tables entry');
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(table.name || '') || names.has(table.name)) fail('Table aliases must be unique lowercase names');
    names.add(table.name);
    if (!Array.isArray(table.primaryKey) || !table.primaryKey.length || table.primaryKey.length > 4) fail('Each table needs 1–4 primary key columns');
    const columns = new Set();
    for (const column of table.primaryKey) {
      fields(column, ['name', 'type'], 'primaryKey entry');
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(column.name || '') || columns.has(column.name)) fail('Primary key column names must be valid and unique');
      if (!['STRING', 'INTEGER', 'BINARY'].includes(column.type)) fail('Primary key type must be STRING, INTEGER, or BINARY');
      columns.add(column.name);
    }
  }
  d.usage ??= { storageGB: 0.1, readCU: 100000, writeCU: 10000, internetGB: 0.1 };
  fields(d.usage, ['storageGB', 'readCU', 'writeCU', 'internetGB'], 'database.usage');
  for (const key of ['storageGB', 'readCU', 'writeCU', 'internetGB']) if (!Number.isFinite(d.usage[key]) || d.usage[key] < 0) fail(`database.usage.${key} must be a nonnegative monthly estimate`);
  const { roleArn } = databaseNames(config);
  if (config.backend.role && config.backend.role !== roleArn) fail(`Managed Tablestore uses the dedicated project role ${roleArn}`);
  config.backend.role = roleArn;
  for (const name of ['TABLESTORE_INSTANCE', 'TABLESTORE_ENDPOINT', 'TABLESTORE_TABLES']) {
    if (name in config.backend.environment || name in config.backend.envFrom) fail(`${name} is supplied by database configuration; remove the conflicting backend variable`);
  }
}

export function databaseEnvironment(config) {
  const d = config.database;
  if (!d) return {};
  const { prefix } = databaseNames(config);
  return {
    TABLESTORE_INSTANCE: d.instance,
    TABLESTORE_ENDPOINT: `https://${d.instance}.${config.region}.ots.aliyuncs.com`,
    TABLESTORE_TABLES: JSON.stringify(Object.fromEntries(d.tables.map((table) => [table.name, prefix + table.name]))),
  };
}

export function databaseAccess(config) {
  if (!config.database) fail('Configure database first');
  const names = databaseNames(config);
  const instance = `acs:ots:${config.region}:${config.accountId}:instance/${config.database.instance}`;
  const tables = `${instance}/table/${names.prefix}*`;
  const allow = (Action, Resource) => ({ Effect: 'Allow', Action, Resource: [Resource] });
  return {
    ...names,
    trustPolicy: { Version: '1', Statement: [{ Effect: 'Allow', Action: ['sts:AssumeRole'], Principal: { Service: ['fc.aliyuncs.com'] } }] },
    runtimePolicy: { Version: '1', Statement: [allow(['ots:GetRow', 'ots:PutRow', 'ots:UpdateRow', 'ots:DeleteRow', 'ots:GetRange', 'ots:BatchGetRow', 'ots:BatchWriteRow'], tables)] },

  };
}

export function databasePlan(config) {
  if (!config.database) return { kind: 'none', action: 'No managed database; existing SQL credentials can use backend.envFrom' };
  const d = config.database;
  const rates = d.clusterType === 'SSD'
    ? { storageGBHour: 0.0015, readPer10kCU: 0.01, writePer10kCU: 0.02, internetGB: 0.8 }
    : { storageGBHour: 0.000417, readPer10kCU: 0.004, writePer10kCU: 0.002, internetGB: 0.8 };
  const u = d.usage;
  const amount = u.storageGB * 720 * rates.storageGBHour + u.readCU / 10000 * rates.readPer10kCU + u.writeCU / 10000 * rates.writePer10kCU + u.internetGB * rates.internetGB;
  const access = databaseAccess(config);
  const value = {
    accountId: config.accountId, region: config.region, project: config.project, functionName: config.backend.functionName,
    kind: d.kind, instance: d.instance, ownerProject: access.ownerProject, ownership: d.shared ? 'explicitly-shared' : 'application', shared: d.shared || null,
    clusterType: d.clusterType, billing: 'CU / PayAsYouGo',
    network: 'Authenticated HTTPS public endpoint, RAM-authorized requests only; no anonymous data access. No VPC/NAT is created. Public downlink is included in the estimate.',
    tables: d.tables.map((table) => ({ ...table, physicalName: access.prefix + table.name, reservedRead: 0, reservedWrite: 0, timeToLive: -1, maxVersions: 1 })),
    action: d.shared
      ? 'Use the explicitly declared owner application instance and table prefix; verify ownership and schemas; never delete or implicitly migrate data'
      : 'Create this application-owned instance and tables if absent; verify ownership and existing schemas; never delete or implicitly migrate data',
    environment: databaseEnvironment(config), access,
    cost: {
      currency: 'CNY', checkedOn: '2026-10-12', source: 'https://www.aliyun.com/price/product#/ots/detail/otsbag', rates, usage: u,
      estimated30Days: Number(amount.toFixed(4)), fixedInstanceFee: 0,
      assumptions: 'Public-cloud list-price reference, 30-day average storage, no reserved CU, indexes, replication or backup service; no free allowance deducted. Verify the selected region/account price before approval. Excludes OSS/FC and application costs.',
      limit: 'Estimate only, not a bill cap. CU mode has no spending hard limit; authentication, bounded reads and rate limits belong in the application.',
    },
  };
  return value;
}
