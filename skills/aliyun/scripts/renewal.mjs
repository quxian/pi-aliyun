import { readFile, mkdir, writeFile, rename, realpath, rm } from 'node:fs/promises';
import { randomUUID, X509Certificate } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from './config.mjs';
import { loadAccount, checkAccountProject, checkPersistentProject } from './account.mjs';
import { errorInfo } from './errors.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
export const defaultRegistry = () => resolve(homedir(), '.config/pi-aliyun/renewal.json');

async function updateRegistry(registryPath, update) {
  await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
  // Canonicalize the parent even before the registry exists, so path aliases share one lock.
  const path = resolve(await realpath(dirname(registryPath)), basename(registryPath));
  const release = await lockfile.lock(path, { realpath: false, retries: { retries: 150, factor: 1, minTimeout: 100, maxTimeout: 100 } });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const registry = await readRegistry(path, true);
    update(registry);
    await writeFile(temporary, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
    await release();
  }
}

function connectionEnvironment(connection) {
  if (connection === undefined) return {};
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)
    || Object.keys(connection).some(key => !['credentialFile', 'accountFile'].includes(key))
    || [connection.credentialFile, connection.accountFile].some(path => typeof path !== 'string' || !isAbsolute(path) || /[\r\n\0]/.test(path))) {
    throw new Error('Renewal connection must contain absolute credentialFile and accountFile paths');
  }
  return { PI_ALIYUN_CONNECTION_FILE: connection.credentialFile, PI_ALIYUN_ACCOUNT_FILE: connection.accountFile };
}

async function readRegistry(path, allowMissing = false) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (allowMissing && error.code === 'ENOENT') return { version: 1, projects: [] }; throw new Error(`Cannot read renewal registry: ${path}`); }
  if (value.version !== 1 || !Array.isArray(value.projects) || value.projects.some((entry) => typeof entry !== 'string' || !isAbsolute(entry))) throw new Error('Renewal registry must contain version: 1 and an array of absolute config paths');
  connectionEnvironment(value.connection);
  return value;
}

export async function registerRenewal(configPath, registryPath = defaultRegistry()) {
  const path = resolve(configPath);
  const config = await loadConfig(path);
  if (!config.tls.acme || !config.tls.acme.agreeToTerms) throw new Error('Scheduled renewal requires ACME configuration and accepted CA terms');
  await updateRegistry(registryPath, registry => {
    if (process.env.PI_ALIYUN_CONNECTION_FILE || process.env.PI_ALIYUN_ACCOUNT_FILE) {
      const connection = { credentialFile: process.env.PI_ALIYUN_CONNECTION_FILE, accountFile: process.env.PI_ALIYUN_ACCOUNT_FILE };
      connectionEnvironment(connection);
      registry.connection = connection;
    }
    registry.projects = [...new Set([...registry.projects, path])];
  });
  console.log(`Registered certificate renewal: ${path}`);
}

export async function unregisterRenewal(configPath, registryPath = defaultRegistry()) {
  await updateRegistry(registryPath, registry => {
    registry.projects = registry.projects.filter(path => path !== resolve(configPath));
  });
}

export async function renewProject(configPath) {
  const result = { configPath: resolve(configPath), project: basename(dirname(configPath)), domains: [], checkedAt: new Date().toISOString() };
  try {
    const config = await loadConfig(configPath);
    result.project = config.project;
    result.domains = [config.frontend?.domain, config.backend?.domain].filter(Boolean);
    const account = await loadAccount();
    checkAccountProject(account, config);
    await checkPersistentProject(account, configPath);
    const { readResources, saveResources } = await import('./resources.mjs');
    await readResources(config, configPath);
    const { prepareTls } = await import('./tls.mjs');
    const { createClients, bindFrontendDomain } = await import('./cloud.mjs');
    const { renewBackendCertificate } = await import('./ros.mjs');
    const tls = await prepareTls(config);
    await saveResources(config, configPath, { state: 'renewing' });
    const clients = await createClients(config);
    if (config.frontend) await bindFrontendDomain(clients.oss, config, tls, { dns: clients.dns });
    if (config.backend) await renewBackendCertificate(clients.ros, config, tls);
    await saveResources(config, configPath, { state: 'renewed' });
    return { ...result, checkedAt: new Date().toISOString(), status: 'ok', expiresAt: new Date(new X509Certificate(tls.certificate).validTo).toISOString() };
  } catch (error) {
    return { ...result, checkedAt: new Date().toISOString(), status: 'error', error: errorInfo(error) };
  }
}

async function runRenewal(configPath, environment, signal) {
  let output;
  try {
    const result = await execute(process.execPath, [cli, 'renew', '--config', configPath, '--json'], { env: environment, signal, timeout: 900_000, maxBuffer: 1024 * 1024 });
    output = result.stdout;
  } catch (error) {
    // Never expose execFile errors or raw progress logs; only the CLI's safe result is public.
    if (signal.aborted) throw signal.reason;
    if (!error.stdout) throw new Error(error.killed ? '续期任务超时，请重试此应用。' : '续期进程未完成，请重试此应用。');
    output = error.stdout;
  }
  const result = JSON.parse(output);
  if (!['ok', 'error'].includes(result.status) || result.configPath !== resolve(configPath)) throw new Error('续期进程返回了无效结果。');
  return result;
}

export async function renewRegistered(registryPath = defaultRegistry(), { run = runRenewal } = {}) {
  const registry = await readRegistry(registryPath, true);
  const environment = { ...process.env, ...connectionEnvironment(registry.connection) };
  const projects = [];
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  try {
    for (const path of [...new Set(registry.projects)]) {
      controller.signal.throwIfAborted();
      let info = { configPath: path, project: basename(dirname(path)), domains: [], checkedAt: new Date().toISOString() };
      try {
        const config = await loadConfig(path);
        info = { ...info, project: config.project, domains: [config.frontend?.domain, config.backend?.domain].filter(Boolean) };
        projects.push(await run(path, environment, controller.signal) ?? { ...info, status: 'ok' });
      } catch (error) {
        controller.signal.throwIfAborted();
        projects.push({ ...info, status: 'error', error: errorInfo(error) });
      }
    }
  } finally {
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
  }
  return { checkedAt: new Date().toISOString(), ok: projects.every(project => project.status === 'ok'), projects };
}

function quote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid newline or NUL in systemd path');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$')}"`;
}

export function renewalUnits({ user, registryPath, cliPath = cli, nodePath = process.execPath }) {
  if (!/^[a-z_][a-z0-9_-]*$/.test(user || '') || user === 'root') throw new Error('Choose a non-root service user for certificate renewal');
  if (![registryPath, cliPath, nodePath].every(isAbsolute)) throw new Error('Systemd paths must be absolute');
  const marker = '# Managed by pi-aliyun certificate renewal\n';
  return {
    'pi-aliyun-renew.service': `${marker}[Unit]\nDescription=Renew registered pi-aliyun HTTPS certificates\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=oneshot\nUser=${user}\nUMask=0077\nWorkingDirectory=/\nExecStart=${quote(nodePath)} ${quote(cliPath)} renew-all --registry ${quote(registryPath)}\nTimeoutStartSec=2h\nNoNewPrivileges=true\n`,
    'pi-aliyun-renew.timer': `${marker}[Unit]\nDescription=Daily pi-aliyun certificate check\n\n[Timer]\nOnCalendar=*-*-* 03:15:00\nRandomizedDelaySec=15m\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

export async function installRenewalTimer(user, registryPath) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Installing the systemd timer requires a Linux administrator; run schedule as the service user first');
  await readRegistry(registryPath);
  const units = renewalUnits({ user, registryPath });
  for (const name of Object.keys(units)) {
    let existing;
    try { existing = await readFile(`/etc/systemd/system/${name}`, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && !existing.startsWith('# Managed by pi-aliyun certificate renewal\n')) throw new Error(`Refusing to replace an unrelated systemd unit: ${name}`);
  }
  for (const [name, content] of Object.entries(units)) await writeFile(`/etc/systemd/system/${name}`, content, { mode: 0o644 });
  await execute('systemctl', ['daemon-reload']);
  await execute('systemctl', ['enable', '--now', 'pi-aliyun-renew.timer']);
  console.log(`Daily renewal timer enabled as ${user}. Registry: ${registryPath}`);
}
