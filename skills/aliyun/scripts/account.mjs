import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseNames, validateDatabaseShared } from './database-plan.mjs';

export const defaultAccountPath = () => process.env.PI_ALIYUN_ACCOUNT_FILE || join(homedir(), '.config/pi-aliyun/account.json');

export function validateAccount(value) {
  const p = structuredClone(value);
  const keys = ['version', 'accountId', 'region', 'zone', 'projectRoot', 'acmeEmail', 'acmeProxyUrl', 'acmeTermsAccepted', 'authorization'];
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !keys.includes(k))) throw new Error('Invalid account profile fields');
  if (p.version !== 1 || typeof p.accountId !== 'string' || !/^\d{6,20}$/.test(p.accountId) || !/^[a-z]{2}-[a-z0-9-]+$/.test(p.region)) throw new Error('Invalid account profile accountId/region/version');
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(p.zone)) throw new Error('Invalid account DNS zone');
  if (!isAbsolute(p.projectRoot || '') || resolve(p.projectRoot) === '/' || /[\r\n\0]/.test(p.projectRoot)) throw new Error('account.projectRoot must be an absolute persistent directory');
  if (p.acmeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.acmeEmail)) throw new Error('Invalid ACME email');
  if (p.acmeTermsAccepted !== undefined && typeof p.acmeTermsAccepted !== 'boolean') throw new Error('acmeTermsAccepted must reflect the operator\'s actual CA agreement');
  if (p.authorization !== undefined && (typeof p.authorization !== 'string' || !p.authorization.trim() || p.authorization.length > 4000)) throw new Error('account.authorization must record the operator-approved deployment and spending scope in 1–4000 characters');
  if (p.acmeProxyUrl) {
    const u = new URL(p.acmeProxyUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('Invalid ACME proxy origin');
  }
  return p;
}

export async function loadAccount(path = defaultAccountPath(), { optional = false } = {}) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
  return validateAccount(JSON.parse(text));
}

function projectDatabase(p, project, shared) {
  const managedProject = value => /^pi-aliyun-[a-z0-9][a-z0-9-]{0,21}$/.test(value || '');
  if (!managedProject(project)) throw new Error('Choose a project matching pi-aliyun-<name>, maximum 32 characters');
  const config = { accountId: p.accountId, region: p.region, project, database: { ...(shared === undefined ? {} : { shared }) } };
  validateDatabaseShared(config);
  if (shared && !managedProject(shared.ownerProject)) throw new Error('Shared database ownerProject must match the pi-aliyun-* application namespace');
  return databaseNames(config);
}

export function checkAccountProject(p, config) {
  const expected = projectDatabase(p, config.project, config.database?.shared);
  if (config.accountId !== p.accountId || config.region !== p.region || config.dns?.zone !== p.zone) throw new Error('Project account, region or DNS zone differs from the configured account');
  if (config.frontend && config.frontend.bucket !== `${config.project}-${p.accountId}`) throw new Error('Application bucket must be <project>-<accountId>');
  if (config.backend && config.backend.functionName !== config.project) throw new Error('Application functionName must equal project');
  if (config.database && config.database.instance !== expected.instanceName) throw new Error('Application database must use its own instance; sharing requires database.shared with an ownerProject and reason');
}

export async function checkPersistentProject(_account, path) {
  const dir = await realpath(resolve(path, '..'));
  const packageRoot = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
  const within = root => dir === root || dir.startsWith(root + sep);
  if (within(packageRoot)) throw new Error('Keep application source outside the pi-aliyun package installation directory');
  const temporaryRoots = await Promise.all([tmpdir(), '/tmp', '/var/tmp', '/run'].map(root => realpath(root).catch(() => resolve(root))));
  if (temporaryRoots.some(within)) throw new Error('Keep application source in a persistent directory, outside system temporary directories');
}

export async function initProject(p, project, configPath) {
  projectDatabase(p, project);
  const directory = configPath ? resolve(configPath, '..') : join(p.projectRoot, project);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const template = JSON.parse(await readFile(new URL('../assets/aliyun.example.json', import.meta.url), 'utf8'));
  Object.assign(template, { accountId: p.accountId, region: p.region, project });
  template.frontend.bucket = `${project}-${p.accountId}`;
  template.frontend.domain = `${project.slice(10)}.${p.zone}`;
  template.backend.functionName = project;
  template.backend.domain = `${project.slice(10)}-api.${p.zone}`;
  Object.assign(template.backend, { cpu: 0.1, memorySize: 256, maxInstances: 1, timeout: 30, instanceConcurrency: 5 });
  template.dns.zone = p.zone;
  if (p.acmeEmail) template.tls.acme = { email: p.acmeEmail, accountKeyFile: '.aliyun/tls/account.key', agreeToTerms: p.acmeTermsAccepted === true, ...(p.acmeProxyUrl ? { proxyUrl: p.acmeProxyUrl } : {}) };
  await writeFile(configPath || join(directory, 'aliyun.json'), JSON.stringify(template, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  // Existing application repositories keep their ignore rules.
  const ignorePath = join(directory, '.gitignore');
  const prior = await readFile(ignorePath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const rules = ['node_modules/', '.aliyun/', '.env', '.env.*', '*.pem', '*.key', 'dist/'];
  await writeFile(ignorePath, [prior.trimEnd(), ...rules.filter(rule => !prior.split(/\r?\n/).includes(rule))].filter(Boolean).join('\n') + '\n');
  console.log(directory);
}
