import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { X509Certificate, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { backendNames } from './ros.mjs';
import { databaseNames } from './database-plan.mjs';

export function certificateIdentity(pem) {
  const certificate = new X509Certificate(pem);
  return {
    fingerprint: certificate.fingerprint.replaceAll(':', '').toLowerCase(),
    publicKeySha256: createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
    serialNumber: certificate.serialNumber.toLowerCase(),
  };
}

export function resourceManifest(config) {
  const names = config.database ? databaseNames(config) : undefined;
  return {
    version: 1, project: config.project, accountId: config.accountId, region: config.region,
    frontend: config.frontend ? { bucket: config.frontend.bucket, domain: config.frontend.domain } : undefined,
    backend: config.backend ? { ...backendNames(config), functionName: config.backend.functionName, domain: config.backend.domain, role: config.backend.role } : undefined,
    database: config.database ? {
      instance: config.database.instance, ownerProject: names.ownerProject,
      shared: config.database.shared, role: names.roleName, policy: names.policyName, tables: config.database.tables.map(table => names.prefix + table.name),
    } : undefined,
    tls: { domains: [config.frontend?.domain, config.backend?.domain].filter(Boolean) },
  };
}

export async function readResources(config, configPath) {
  let saved;
  try { saved = JSON.parse(await readFile(join(dirname(configPath), '.aliyun/resources.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const key of ['project', 'accountId', 'region']) if (saved[key] !== config[key]) throw new Error('Resource inventory belongs to another application/account');
  for (const [section, keys] of [['frontend', ['bucket', 'domain']], ['backend', ['functionName', 'domain']], ['database', ['instance']]]) {
    if (saved[section] && keys.some(key => saved[section][key] !== config[section]?.[key])) throw new Error(`Existing ${section} resources differ from configuration. Manage the old resources with their original config before changing identity.`);
  }
  if (saved.backend && saved.backend.stackName !== backendNames(config).stackName) {
    throw new Error('This application has an older backend outside ROS. Handle its existing FC resources explicitly before using the ROS deployment commands; do not delete the inventory to bypass this check.');
  }
  return saved;
}

export async function saveResources(config, configPath, updates = {}) {
  const previous = await readResources(config, configPath);
  const directory = join(dirname(configPath), '.aliyun');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'resources.json'), temporary = `${file}.${process.pid}.tmp`;
  const certificates = new Map((previous?.tls?.certificates || []).map(item => [item.fingerprint, item]));
  try { const item = certificateIdentity(await readFile(config.tls.certFile)); certificates.set(item.fingerprint, item); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const manifest = resourceManifest(config);
  await writeFile(temporary, JSON.stringify({ ...manifest, ...updates, deployedAt: previous?.deployedAt || new Date().toISOString(), updatedAt: new Date().toISOString(), tls: { ...manifest.tls, certificates: [...certificates.values()] } }, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
  console.log(`Application resource inventory saved: ${file}`);
}
