import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from './config.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
export const defaultRegistry = () => resolve(homedir(), '.config/pi-aliyun/renewal.json');

async function readRegistry(path, allowMissing = false) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (allowMissing && error.code === 'ENOENT') return { version: 1, projects: [] }; throw new Error(`Cannot read renewal registry: ${path}`); }
  if (value.version !== 1 || !Array.isArray(value.projects) || value.projects.some((entry) => typeof entry !== 'string' || !isAbsolute(entry))) throw new Error('Renewal registry must contain version: 1 and an array of absolute config paths');
  return value;
}

export async function registerRenewal(configPath, registryPath = defaultRegistry()) {
  const path = resolve(configPath);
  const config = await loadConfig(path);
  if (!config.tls.acme || !config.tls.acme.agreeToTerms) throw new Error('Scheduled renewal requires ACME configuration and accepted CA terms');
  const registry = await readRegistry(registryPath, true);
  registry.projects = [...new Set([...registry.projects, path])];
  await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
  const temporary = `${registryPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, registryPath);
  console.log(`Registered certificate renewal: ${path}`);
}

export async function unregisterRenewal(configPath, registryPath = defaultRegistry()) {
  const registry = await readRegistry(registryPath, true);
  registry.projects = registry.projects.filter(path => path !== resolve(configPath));
  await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
  const temporary = `${registryPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, registryPath);
}

async function runRenewal(configPath) {
  try {
    const result = await execute(process.execPath, [cli, 'renew', '--config', configPath], { timeout: 600_000, maxBuffer: 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (error) {
    // The child CLI already redacts SDK errors; never print execFile's full error or environment.
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw new Error(error.killed ? 'renewal exceeded 10 minutes' : 'renewal command failed');
  }
}

export async function renewRegistered(registryPath = defaultRegistry(), { run = runRenewal } = {}) {
  const registry = await readRegistry(registryPath);
  const failures = [];
  for (const path of [...new Set(registry.projects)]) {
    console.log(`Checking scheduled certificate: ${path}`);
    try { await run(path); }
    catch { failures.push(path); console.error(`Scheduled certificate check failed: ${path}`); }
  }
  if (failures.length) throw new Error(`${failures.length} certificate check(s) failed; inspect the preceding project logs`);
  console.log(`Scheduled certificate checks completed: ${registry.projects.length} project(s)`);
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
