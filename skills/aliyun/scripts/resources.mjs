import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { databaseNames } from './database-plan.mjs';

export function resourceManifest(config) {
  const names = config.database ? databaseNames(config) : undefined;
  return {
    version: 1, project: config.project, accountId: config.accountId, region: config.region,
    frontend: config.frontend ? { bucket: config.frontend.bucket, domain: config.frontend.domain } : undefined,
    backend: config.backend ? { functionName: config.backend.functionName, domain: config.backend.domain, role: config.backend.role } : undefined,
    database: config.database ? {
      instance: config.database.instance, ownerProject: names.ownerProject,
      shared: config.database.shared, tables: config.database.tables.map(table => names.prefix + table.name),
    } : undefined,
    tls: { domains: [config.frontend?.domain, config.backend?.domain].filter(Boolean) },
  };
}

export async function saveResources(config, configPath) {
  const directory = join(dirname(configPath), '.aliyun');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'resources.json'), temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...resourceManifest(config), deployedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
  console.log(`Application resource inventory saved: ${file}`);
}
