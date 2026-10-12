import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import * as FC from '@alicloud/fc20230330';
import { databaseNames, validateDatabaseShared } from './database-plan.mjs';
import { verifyDatabaseRole } from './database-role.mjs';
import { deploymentPolicy as websiteDeploymentPolicy } from './policy.mjs';

export const defaultPlatformPath = () => join(homedir(), '.config/pi-aliyun/platform.json');
export function validatePlatform(value) {
  const p = structuredClone(value);
  const keys = ['version', 'accountId', 'region', 'zone', 'projectRoot', 'authorizerFunction', 'deployerRole', 'acmeEmail', 'acmeProxyUrl', 'authorization'];
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !keys.includes(k))) throw new Error('Invalid platform profile fields');
  if (p.version !== 2 || !/^\d{6,20}$/.test(p.accountId) || !/^[a-z]{2}-[a-z0-9-]+$/.test(p.region)) throw new Error('Invalid platform account/region/version');
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(p.zone)) throw new Error('Invalid platform zone');
  if (!isAbsolute(p.projectRoot || '') || p.projectRoot === '/' || /[\r\n\0]/.test(p.projectRoot)) throw new Error('platform.projectRoot must be an absolute persistent directory');
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(p.authorizerFunction || '') || !/^[A-Za-z0-9-]{1,64}$/.test(p.deployerRole || '')) throw new Error('Invalid platform authorizer/deployer name');
  if (p.acmeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.acmeEmail)) throw new Error('Invalid ACME email');
  if (p.authorization !== undefined && (typeof p.authorization !== 'string' || !p.authorization.trim() || p.authorization.length > 4000)) throw new Error('platform.authorization must record the operator-approved deployment and spending scope in 1–4000 characters');
  if (p.acmeProxyUrl) {
    const u = new URL(p.acmeProxyUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('Invalid ACME proxy origin');
  }
  return p;
}
export async function loadPlatform(path = defaultPlatformPath(), { optional = false } = {}) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
  return validatePlatform(JSON.parse(text));
}
export function projectConfig(p, project, shared) {
  if (!/^pi-aliyun-[a-z0-9][a-z0-9-]{0,21}$/.test(project || '') || project === p.authorizerFunction) throw new Error('Choose a project matching pi-aliyun-<name>, maximum 32 characters, excluding the authorizer');
  const config = { accountId: p.accountId, region: p.region, project, database: { ...(shared === undefined ? {} : { shared }) } };
  validateDatabaseShared(config);
  if (shared && (!/^pi-aliyun-[a-z0-9][a-z0-9-]{0,21}$/.test(shared.ownerProject) || shared.ownerProject === p.authorizerFunction)) throw new Error('Shared database ownerProject is outside the approved namespace');
  config.database.instance = databaseNames(config).instanceName;
  return config;
}
export function checkPlatformProject(p, config) {
  const expected = projectConfig(p, config.project, config.database?.shared);
  if (config.accountId !== p.accountId || config.region !== p.region || config.dns.zone !== p.zone) throw new Error('Project account, region or DNS zone is outside the installed platform approval');
  if (config.frontend && config.frontend.bucket !== `${config.project}-${p.accountId}`) throw new Error('Platform bucket must be <project>-<accountId>');
  if (config.backend && config.backend.functionName !== config.project) throw new Error('Platform functionName must equal project');
  if (config.database && (config.database.instance !== expected.database.instance || config.database.clusterType !== 'SSD')) throw new Error('Platform database must use its application-owned SSD instance; sharing requires database.shared with an ownerProject and reason');
}
export async function checkPersistentProject(p, path) {
  const dir = await realpath(resolve(path, '..'));
  const packageRoot = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
  const within = (root) => dir === root || dir.startsWith(root + sep);
  if (within(packageRoot)) throw new Error('Keep application source outside the pi-aliyun package installation directory');
  const temporaryRoots = await Promise.all([tmpdir(), '/tmp', '/var/tmp', '/run'].map(root => realpath(root).catch(() => resolve(root))));
  if (temporaryRoots.some(within)) throw new Error('Keep application source in a persistent directory, outside system temporary directories');
}
export function platformPlan(p) {
  const account = p.accountId, instance = `acs:ots:${p.region}:${account}:instance/pi-app-*`;
  const role = `acs:ram:*:${account}:role/pi-db-pi-aliyun-*`, policy = `acs:ram:*:${account}:policy/PiDatabase-pi-aliyun-*`;
  const brokerRole = p.authorizerFunction, brokerPolicy = 'PiAliyunAuthorizer';
  const functionArn = `acs:fc:${p.region}:${account}:functions/${p.authorizerFunction}`;
  const allow = (Action, ...Resource) => ({ Effect: 'Allow', Action, Resource });
  const trust = { Version: '1', Statement: [{ Effect: 'Allow', Action: ['sts:AssumeRole'], Principal: { Service: ['fc.aliyuncs.com'] } }] };
  const deploymentPolicy = { Version: '1', Statement: [
    ...websiteDeploymentPolicy({ accountId: account, dns: { zone: p.zone }, frontend: { bucket: `pi-aliyun-example-${account}` } }).Statement,
    allow(['ots:ListInstance'], `acs:ots:${p.region}:${account}:instance/*`),
    allow(['ots:GetInstance', 'ots:InsertInstance'], instance),
    allow(['ots:CreateTable', 'ots:DescribeTable'], `${instance}/table/pi_pi_aliyun_*`),
    allow(['ram:GetRole', 'ram:ListPoliciesForRole'], role),
    allow(['ram:GetPolicy', 'ram:GetPolicyVersion'], policy),
    { ...allow(['ram:PassRole'], role), Condition: { StringEquals: { 'acs:Service': 'fc.aliyuncs.com' } } },
    allow(['fc:InvokeFunction'], functionArn),
    { Effect: 'Deny', Action: ['fc:CreateFunction', 'fc:UpdateFunction', 'fc:DeleteFunction', 'fc:CreateTrigger', 'fc:UpdateTrigger', 'fc:DeleteTrigger', 'fc:PutConcurrencyConfig', 'fc:PutScalingConfig', 'fc:PublishFunctionVersion', 'fc:CreateAlias', 'fc:UpdateAlias'], Resource: [functionArn, `${functionArn}/*`] },
    { Effect: 'Deny', Action: ['ram:PassRole', 'sts:AssumeRole'], Resource: [`acs:ram:*:${account}:role/${brokerRole}`, `acs:ram::${account}:role/${brokerRole}`] },
  ] };
  const authorizerPolicy = { Version: '1', Statement: [
    allow(['ram:GetRole', 'ram:ListPoliciesForRole', 'ram:CreateRole'], role),
    allow(['ram:GetPolicy', 'ram:GetPolicyVersion', 'ram:CreatePolicy', 'ram:ListEntitiesForPolicy', 'ram:ListPolicyVersions', 'ram:CreatePolicyVersion', 'ram:DeletePolicyVersion'], policy),
    allow(['ram:AttachPolicyToRole'], role, policy),
  ] };
  const value = { version: 2, accountId: account, region: p.region, zone: p.zone, database: { instancePattern: 'pi-app-<sha256(ownerProject)[0:8]>', ownership: 'Per application by default; explicit shared ownerProject and reason only', clusterType: 'SSD' },
    authorizerFunction: p.authorizerFunction, authorizerRole: brokerRole, authorizerPolicyName: brokerPolicy,
    deployerRole: p.deployerRole, deploymentPolicyName: 'PiAliyunPlatformDeploy', trust, authorizerPolicy, deploymentPolicy,
    functionSettings: { runtime: 'nodejs20', cpu: 0.1, memorySize: 256, timeout: 60, instanceConcurrency: 1, maxInstances: 1, minInstances: 0, httpTrigger: false },
    scope: 'Complete deployment permissions for application website buckets pi-aliyun-*-<accountId>, FC, the configured DNS zone, HTTPS certificates and application-owned SSD instances. Each application has a separate runtime role and row-data policy. Sharing requires an explicit ownerProject and reason. The protected authorizer creates or updates only its managed fixed-template policies; no arbitrary policy input or application resource deletion. Temporary migration access to legacy databases is not included.',
  };
  return { ...value, fingerprint: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}
export async function ensureProjectRole(fc, ram, config, profile) {
  try { await verifyDatabaseRole(ram, config); return; }
  catch { /* The fixed-template authorizer can also finish an interrupted role setup. */ }
  const request = { version: 2, operation: 'ensure', project: config.project, ...(config.database.shared ? { shared: config.database.shared } : {}) };
  const response = await fc.invokeFunction(profile.authorizerFunction, new FC.InvokeFunctionRequest({ body: Readable.from([Buffer.from(JSON.stringify(request))]), qualifier: 'LATEST' }));
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += Buffer.byteLength(chunk); if (size > 16384) throw new Error('Authorizer response is too large'); chunks.push(Buffer.from(chunk)); }
  const result = JSON.parse(Buffer.concat(chunks).toString());
  if (response.headers?.['x-fc-function-error'] || result.status !== 'ready' || result.roleArn !== databaseNames(config).roleArn) throw new Error('Project authorization did not complete; inspect the administrator-managed authorizer');
  await verifyDatabaseRole(ram, config);
  console.log(`Project runtime authorization ready: ${result.roleArn}`);
}
export async function initProject(p, project) {
  projectConfig(p, project);
  const directory = join(p.projectRoot, project);
  await mkdir(directory, { mode: 0o700 });
  const template = JSON.parse(await readFile(new URL('../assets/aliyun.example.json', import.meta.url), 'utf8'));
  Object.assign(template, { accountId: p.accountId, region: p.region, project });
  template.frontend.bucket = `${project}-${p.accountId}`;
  template.frontend.domain = `${project.slice(10)}.${p.zone}`;
  template.backend.functionName = project; template.backend.domain = `${project.slice(10)}-api.${p.zone}`;
  Object.assign(template.backend, { cpu: 0.1, memorySize: 256, maxInstances: 1, timeout: 30, instanceConcurrency: 5 });
  template.dns.zone = p.zone;
  if (p.acmeEmail) template.tls.acme = { email: p.acmeEmail, accountKeyFile: '.aliyun/tls/account.key', ...(p.acmeProxyUrl ? { proxyUrl: p.acmeProxyUrl } : {}) };
  await writeFile(join(directory, 'aliyun.json'), JSON.stringify(template, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, '.gitignore'), 'node_modules/\n.aliyun/\n.env\n.env.*\n*.pem\n*.key\ndist/\n', { flag: 'wx' });
  console.log(directory);
}
