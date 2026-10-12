#!/usr/bin/env node
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, doctor, plan } from './config.mjs';
import { databasePlan } from './database-plan.mjs';
import { loadPlatform, platformPlan, initProject, checkPlatformProject, checkPersistentProject, ensureProjectRole } from './platform.mjs';

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('pi-aliyun <init|doctor|plan|policy|build|deploy|renew|db-plan|db-inspect|db-setup|db-role> [--config aliyun.json]\npi-aliyun <platform|platform-plan> [--profile path]\npi-aliyun project-init --project pi-aliyun-name [--profile path]\npi-aliyun platform-bundle --output directory [--profile path]\npi-aliyun platform-bootstrap --bundle directory --fingerprint approved-hash [--profile path]\npi-aliyun schedule --config aliyun.json [--registry path]\npi-aliyun renew-all [--registry path]\npi-aliyun install-renewal --user service-user --registry path\nAuthorize the deployment environment once. Applications own independent resources unless sharing is explicit. Cloud access does not itself authorize new costs.');
    return;
  }
  const platformCommands = { platform: ['profile'], 'platform-plan': ['profile'], 'platform-bundle': ['profile', 'output'], 'platform-bootstrap': ['profile', 'bundle', 'fingerprint'], 'project-init': ['profile', 'project'] };
  const allowed = platformCommands[command] || (['schedule', 'renew-all', 'install-renewal'].includes(command)
    ? { schedule: ['config', 'registry'], 'renew-all': ['registry'], 'install-renewal': ['user', 'registry'] }[command]
    : ['config']);
  if (!platformCommands[command] && !['init', 'doctor', 'plan', 'policy', 'build', 'deploy', 'renew', 'schedule', 'renew-all', 'install-renewal', 'db-plan', 'db-inspect', 'db-setup', 'db-role'].includes(command)) throw new Error('Unknown command; use --help');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].slice(2);
    if (!args[i].startsWith('--') || !allowed.includes(name) || !args[i + 1] || Object.hasOwn(options, name)) throw new Error('Invalid or duplicate argument; use --help');
    options[name] = args[i + 1];
  }
  const path = resolve(options.config || 'aliyun.json');
  if (platformCommands[command]) {
    const profile = await loadPlatform(options.profile);
    if (command === 'platform') console.log(JSON.stringify(profile, null, 2));
    else if (command === 'platform-plan') console.log(JSON.stringify(platformPlan(profile), null, 2));
    else if (command === 'project-init') await initProject(profile, options.project);
    else {
      const { preparePlatformBundle, bootstrapPlatform } = await import('./platform-admin.mjs');
      if (command === 'platform-bundle') {
        if (!options.output) throw new Error('platform-bundle needs --output');
        await preparePlatformBundle(profile, resolve(options.output));
      } else {
        if (!options.bundle) throw new Error('platform-bootstrap needs --bundle');
        const bundle = resolve(options.bundle);
        const saved = JSON.parse(await readFile(resolve(bundle, 'platform-plan.json'), 'utf8'));
        if (saved.fingerprint !== platformPlan(profile).fingerprint) throw new Error('Bundle belongs to another platform plan');
        const { createClients } = await import('./cloud.mjs');
        const clients = await createClients({ ...profile, backend: {} }, { services: ['fc'] });
        await bootstrapPlatform(profile, clients, await readFile(resolve(bundle, 'authorizer.zip')), options.fingerprint);
      }
    }
    return;
  }
  if (['schedule', 'renew-all', 'install-renewal'].includes(command)) {
    const { defaultRegistry, registerRenewal, renewRegistered, installRenewalTimer } = await import('./renewal.mjs');
    const registry = options.registry ? resolve(options.registry) : defaultRegistry();
    if (command === 'schedule') {
      const platform = await loadPlatform(undefined, { optional: true });
      if (platform) { checkPlatformProject(platform, await loadConfig(path)); await checkPersistentProject(platform, path); }
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
  const platform = await loadPlatform(undefined, { optional: true });
  if (platform && ['deploy', 'db-setup'].includes(command)) {
    checkPlatformProject(platform, config);
    await checkPersistentProject(platform, path);
  }
  if (command === 'doctor') { console.log((await doctor(config)).join('\n')); return; }
  if (command === 'plan') { console.log(JSON.stringify(plan(config), null, 2)); return; }
  if (command === 'db-plan') { console.log(JSON.stringify(databasePlan(config), null, 2)); return; }
  if (command === 'policy') {
    const { deploymentPolicy } = await import('./policy.mjs');
    console.log(JSON.stringify(deploymentPolicy(config), null, 2)); return;
  }
  const { createClients, ensureCname, deployFrontend, deployBackend, bindFrontendDomain, bindBackendDomain } = await import('./cloud.mjs');
  if (['db-inspect', 'db-setup', 'db-role'].includes(command)) {
    if (!config.database) throw new Error('Configure database first');
    const { createDatabaseClients, inspectDatabase, provisionDatabase, bootstrapDatabaseRole } = await import('./database.mjs');
    const { credential, fc } = await createClients(config, { services: platform ? ['fc'] : [] });
    const clients = createDatabaseClients(config, credential);
    if (command === 'db-inspect') {
      const result = await inspectDatabase(clients, config);
      if (platform) {
        checkPlatformProject(platform, config);
        const missing = result.issues.find(issue => issue.component === 'runtimeRole' && issue.code === 'EntityNotExist.Role');
        if (missing) { result.issues = result.issues.filter(issue => issue !== missing); result.runtimeRole = 'will-create-via-authorizer'; }
      }
      console.log(JSON.stringify(result, null, 2));
      if (result.issues.length) process.exitCode = 1;
    } else if (command === 'db-role') await bootstrapDatabaseRole(clients.ram, config);
    else {
      if (platform) await ensureProjectRole(fc, clients.ram, config, platform);
      await provisionDatabase(clients, config);
    }
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
    if (platform) await ensureProjectRole(clients.fc, databaseClients.ram, config, platform);
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
  if (platform && config.tls.acme?.agreeToTerms) {
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
