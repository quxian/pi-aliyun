#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, doctor, plan } from './config.mjs';
import { databasePlan, approveDatabase, requireDatabaseApproval } from './database-plan.mjs';

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('pi-aliyun <init|doctor|plan|policy|build|deploy|renew|db-plan|db-inspect|db-setup|db-role> [--config aliyun.json]\npi-aliyun db-approve --fingerprint <approved db-plan fingerprint> [--config aliyun.json]\npi-aliyun schedule --config aliyun.json [--registry path]\npi-aliyun renew-all [--registry path]\npi-aliyun install-renewal --user service-user --registry path\npolicy prints an administrator-reviewed RAM policy. db-role is a separate administrator command; deploy never grants RAM permissions.');
    return;
  }
  const allowed = ['schedule', 'renew-all', 'install-renewal'].includes(command)
    ? { schedule: ['config', 'registry'], 'renew-all': ['registry'], 'install-renewal': ['user', 'registry'] }[command]
    : command === 'db-approve' ? ['config', 'fingerprint'] : ['config'];
  if (!['init', 'doctor', 'plan', 'policy', 'build', 'deploy', 'renew', 'schedule', 'renew-all', 'install-renewal', 'db-plan', 'db-inspect', 'db-approve', 'db-setup', 'db-role'].includes(command)) throw new Error('Unknown command; use --help');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].slice(2);
    if (!args[i].startsWith('--') || !allowed.includes(name) || !args[i + 1] || Object.hasOwn(options, name)) throw new Error('Invalid or duplicate argument; use --help');
    options[name] = args[i + 1];
  }
  const path = resolve(options.config || 'aliyun.json');
  if (['schedule', 'renew-all', 'install-renewal'].includes(command)) {
    const { defaultRegistry, registerRenewal, renewRegistered, installRenewalTimer } = await import('./renewal.mjs');
    const registry = options.registry ? resolve(options.registry) : defaultRegistry();
    if (command === 'schedule') await registerRenewal(path, registry);
    else if (command === 'renew-all') await renewRegistered(registry);
    else {
      if (!options.registry || !options.user) throw new Error('install-renewal requires --user and --registry');
      await installRenewalTimer(options.user, registry);
    }
    return;
  }
  if (command === 'init') {
    await mkdir(dirname(path), { recursive: true });
    await copyFile(fileURLToPath(new URL('../assets/aliyun.example.json', import.meta.url)), path, 1);
    console.log(`Created ${path}. Set account, resource names, domains, output directories and TLS before deployment.`);
    return;
  }
  const config = await loadConfig(path);
  if (command === 'doctor') { console.log((await doctor(config)).join('\n')); return; }
  if (command === 'plan') { console.log(JSON.stringify(plan(config), null, 2)); return; }
  if (command === 'db-plan') { console.log(JSON.stringify(databasePlan(config), null, 2)); return; }
  if (command === 'db-approve') { await approveDatabase(config, path, options.fingerprint); return; }
  if (command === 'policy') {
    const { deploymentPolicy } = await import('./policy.mjs');
    console.log(JSON.stringify(deploymentPolicy(config), null, 2)); return;
  }
  const { createClients, ensureCname, deployFrontend, deployBackend, bindFrontendDomain, bindBackendDomain } = await import('./cloud.mjs');
  if (['deploy', 'db-setup', 'db-role'].includes(command)) await requireDatabaseApproval(config, path);
  if (['db-inspect', 'db-setup', 'db-role'].includes(command)) {
    if (!config.database) throw new Error('Configure database first');
    const { createDatabaseClients, inspectDatabase, provisionDatabase, bootstrapDatabaseRole } = await import('./database.mjs');
    const { credential } = await createClients(config, { services: [] });
    const clients = createDatabaseClients(config, credential);
    if (command === 'db-inspect') {
      const result = await inspectDatabase(clients, config);
      console.log(JSON.stringify(result, null, 2));
      if (result.issues.length) process.exitCode = 1;
    } else if (command === 'db-role') await bootstrapDatabaseRole(clients.ram, config);
    else await provisionDatabase(clients, config);
    return;
  }
  const { prepareTls } = await import('./tls.mjs');
  if (command === 'renew') {
    const tls = await prepareTls(config);
    const clients = await createClients(config);
    if (config.frontend) await bindFrontendDomain(clients.oss, config, tls, { dns: clients.dns });
    if (config.backend) await bindBackendDomain(clients.fc, config, tls, { existingOnly: true });
    console.log('TLS checked and uploaded to configured OSS/FC domains. No application build or deployment was run.');
    return;
  }
  const { buildArtifacts } = await import('./artifacts.mjs');
  const artifacts = await buildArtifacts(config);
  console.log(`Local artifacts ready: ${artifacts.frontendFiles?.length || 0} frontend files; ${artifacts.backendArchive?.length || 0} backend ZIP bytes.`);
  if (command === 'build') return;
  const clients = await createClients(config);
  if (config.database) {
    const { createDatabaseClients, provisionDatabase } = await import('./database.mjs');
    Object.assign(artifacts.environment, await provisionDatabase(createDatabaseClients(config, clients.credential), config));
  }
  const tls = await prepareTls(config);
  if (config.backend) {
    await deployBackend(clients.fc, config, artifacts.backendArchive, artifacts.environment);
    await ensureCname(clients.dns, config, config.backend.domain, `${config.accountId}.${config.region}.fc.aliyuncs.com`);
    await bindBackendDomain(clients.fc, config, tls);
    console.log(`Backend published: https://${config.backend.domain}`);
  }
  if (config.frontend) {
    await deployFrontend(clients.oss, config, artifacts.frontendFiles, tls, { dns: clients.dns });
    await ensureCname(clients.dns, config, config.frontend.domain, `${config.frontend.bucket}.oss-${config.region}.aliyuncs.com`);
    console.log(`Frontend published: https://${config.frontend.domain}`);
  }
  console.log('Cloud configuration and uploads completed. DNS propagation and application health still require verification.');
}

main().catch((error) => {
  // SDK errors can contain Authorization headers, function environments and certificate keys.
  const code = typeof error.code === 'string' && /^[A-Za-z0-9_.-]+$/.test(error.code) ? error.code : undefined;
  const isRemote = Boolean(error.data || error.requestId || error.statusCode || error.status || error.params);
  console.error(isRemote ? `Cloud request failed${code ? ` (${code})` : ''}; inspect cloud audit logs. Deployment may be partial; rerun after correcting the cause.` : `pi-aliyun: ${error.message}`);
  process.exitCode = 1;
});
