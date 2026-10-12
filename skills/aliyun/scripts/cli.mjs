#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, doctor, plan } from './config.mjs';
import { databasePlan } from './database-plan.mjs';
import { loadAccount, initProject, checkAccountProject, checkPersistentProject } from './account.mjs';

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('pi-aliyun <init|doctor|plan|build|deploy|renew|db-plan|db-inspect|db-setup> [--config aliyun.json]\npi-aliyun <account|policy> [--profile path]\npi-aliyun project-init --project pi-aliyun-name [--profile path]\npi-aliyun schedule --config aliyun.json [--registry path]\npi-aliyun renew-all [--registry path]\npi-aliyun install-renewal --user service-user --registry path\nConfigure one trusted deployment identity. Applications own independent resources unless sharing is explicit.');
    return;
  }
  const accountCommands = { account: ['profile'], policy: ['profile'], 'project-init': ['profile', 'project'] };
  const allowed = accountCommands[command] || (['schedule', 'renew-all', 'install-renewal'].includes(command)
    ? { schedule: ['config', 'registry'], 'renew-all': ['registry'], 'install-renewal': ['user', 'registry'] }[command]
    : ['config']);
  if (!accountCommands[command] && !['init', 'doctor', 'plan', 'policy', 'build', 'deploy', 'renew', 'schedule', 'renew-all', 'install-renewal', 'db-plan', 'db-inspect', 'db-setup'].includes(command)) throw new Error('Unknown command; use --help');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].slice(2);
    if (!args[i].startsWith('--') || !allowed.includes(name) || !args[i + 1] || Object.hasOwn(options, name)) throw new Error('Invalid or duplicate argument; use --help');
    options[name] = args[i + 1];
  }
  const path = resolve(options.config || 'aliyun.json');
  if (accountCommands[command]) {
    const profile = await loadAccount(options.profile);
    if (command === 'account') console.log(JSON.stringify(profile, null, 2));
    else if (command === 'policy') {
      const { deploymentPolicy } = await import('./policy.mjs');
      console.log(JSON.stringify(deploymentPolicy(profile), null, 2));
    } else await initProject(profile, options.project);
    return;
  }
  if (['schedule', 'renew-all', 'install-renewal'].includes(command)) {
    const { defaultRegistry, registerRenewal, renewRegistered, installRenewalTimer } = await import('./renewal.mjs');
    const registry = options.registry ? resolve(options.registry) : defaultRegistry();
    if (command === 'schedule') {
      const account = await loadAccount(undefined, { optional: true });
      if (account) { checkAccountProject(account, await loadConfig(path)); await checkPersistentProject(account, path); }
      await registerRenewal(path, registry);
    }
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
  const account = await loadAccount(undefined, { optional: true });
  if (account && ['deploy', 'db-setup'].includes(command)) {
    checkAccountProject(account, config);
    await checkPersistentProject(account, path);
  }
  if (command === 'doctor') { console.log((await doctor(config)).join('\n')); return; }
  if (command === 'plan') { console.log(JSON.stringify(plan(config), null, 2)); return; }
  if (command === 'db-plan') { console.log(JSON.stringify(databasePlan(config), null, 2)); return; }
  const { createClients, ensureCname, deployFrontend, deployBackend, bindFrontendDomain, bindBackendDomain } = await import('./cloud.mjs');
  if (['db-inspect', 'db-setup'].includes(command)) {
    if (!config.database) throw new Error('Configure database first');
    const { createDatabaseClients, inspectDatabase, provisionDatabase } = await import('./database.mjs');
    const { credential } = await createClients(config, { services: [] });
    const clients = createDatabaseClients(config, credential);
    if (command === 'db-inspect') {
      const result = await inspectDatabase(clients, config);
      console.log(JSON.stringify(result, null, 2));
      if (result.issues.length) process.exitCode = 1;
    } else await provisionDatabase(clients, config);
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
    const databaseClients = createDatabaseClients(config, clients.credential);
    Object.assign(artifacts.environment, await provisionDatabase(databaseClients, config));
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
  const { saveResources } = await import('./resources.mjs');
  await saveResources(config, path);
  if (account && config.tls.acme?.agreeToTerms) {
    const { registerRenewal } = await import('./renewal.mjs');
    await registerRenewal(path);
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
