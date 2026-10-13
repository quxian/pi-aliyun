#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadConfig, doctor, plan } from './config.mjs';
import { databasePlan } from './database-plan.mjs';
import { loadAccount, initProject, accountZone, checkAccountProject, checkPersistentProject } from './account.mjs';
import { errorInfo, operation } from './errors.mjs';
import { readResources, saveResources } from './resources.mjs';
import { verifyApplication } from './verify.mjs';

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'connection') {
    if (args.length) throw new Error('connection accepts its optional credential selection as JSON on stdin');
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 65536) throw new Error('Connection input is too large');
    }
    const { inspectConnection } = await import('./connection.mjs');
    console.log(JSON.stringify(await inspectConnection(input.trim() ? JSON.parse(input) : {})));
    return;
  }
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('pi-aliyun init --project pi-aliyun-name [--profile path] [--config existing-project/aliyun.json] [--zone example.com]\npi-aliyun <doctor|plan|build|deploy|status|diagnose|verify|renew|db-plan|db-inspect|db-setup> [--config aliyun.json]\npi-aliyun destroy [--config aliyun.json] [--confirm exact-project-name]\npi-aliyun account [--profile path]\npi-aliyun policy [--profile path] [--zone example.com]\npi-aliyun schedule --config aliyun.json [--registry path]\npi-aliyun renew-all [--registry path]\npi-aliyun install-renewal --user service-user --registry path\ninit always inherits the account. destroy without --confirm is read-only.');
    return;
  }
  const accountCommands = { account: ['profile'], policy: ['profile', 'zone'], init: ['profile', 'project', 'config', 'zone'] };
  const commands = {
    ...accountCommands,
    doctor: ['config'], plan: ['config'], build: ['config'], deploy: ['config'],
    status: ['config'], diagnose: ['config'], verify: ['config'], renew: ['config'],
    'db-plan': ['config'], 'db-inspect': ['config'], 'db-setup': ['config'],
    destroy: ['config', 'confirm'], schedule: ['config', 'registry'],
    'renew-all': ['registry'], 'install-renewal': ['user', 'registry'],
  };
  if (!Object.hasOwn(commands, command)) throw new Error('Unknown command; use --help');
  const allowed = commands[command];
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
      console.log(JSON.stringify(deploymentPolicy({ ...profile, zone: accountZone(profile, options.zone) }), null, 2));
    } else await initProject(profile, options.project, options.config ? path : undefined, options.zone);
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
  const config = await loadConfig(path);
  const account = await loadAccount(undefined, { optional: true });
  if (['deploy', 'db-setup', 'renew', 'status', 'diagnose', 'verify', 'destroy'].includes(command)) {
    if (!account) throw new Error('Configure the account once before cloud operations; use account and policy');
    checkAccountProject(account, config);
    await checkPersistentProject(account, path);
    await readResources(config, path);
  }
  if (command === 'doctor') { console.log((await doctor(config)).join('\n')); return; }
  if (command === 'plan') { console.log(JSON.stringify(plan(config), null, 2)); return; }
  if (command === 'db-plan') { console.log(JSON.stringify(databasePlan(config), null, 2)); return; }
  if (command === 'verify') {
    const report = await verifyApplication(config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  let artifacts;
  if (command === 'build' || command === 'deploy') {
    const { buildArtifacts } = await import('./artifacts.mjs');
    artifacts = await buildArtifacts(config);
    console.log(`Local artifacts ready: ${artifacts.frontendFiles?.length || 0} frontend files; ${artifacts.backendArchive?.length || 0} backend ZIP bytes.`);
    if (command === 'build') return;
  }
  const { createClients, ensureCname, deployFrontend, deployBackend, bindFrontendDomain, bindBackendDomain } = await import('./cloud.mjs');
  if (['status', 'diagnose', 'destroy'].includes(command)) {
    const clients = await createClients(config, { services: ['dns', 'fc', 'oss', 'cas'] });
    const { inspectApplication, planDestroy, destroyApplication } = await import('./operations.mjs');
    let report;
    if (command === 'destroy') report = options.confirm
      ? await destroyApplication(clients, config, path, { confirm: options.confirm })
      : await planDestroy(clients, config, path);
    else {
      report = await inspectApplication(clients, config, path);
      if (command === 'diagnose') {
        report.local = await doctor(config);
        report.https = await verifyApplication(config);
        report.ok &&= report.https.ok;
        if (config.database) {
          const { createDatabaseClients, inspectDatabase } = await import('./database.mjs');
          report.database = await inspectDatabase(createDatabaseClients(config, clients.credential), config);
          report.ok &&= report.database.issues.length === 0;
        }
      }
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.ok === false) process.exitCode = 1;
    return;
  }
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
    await saveResources(config, path, { state: 'renewing' });
    const clients = await createClients(config);
    if (config.frontend) await bindFrontendDomain(clients.oss, config, tls, { dns: clients.dns });
    if (config.backend) await bindBackendDomain(clients.fc, config, tls, { existingOnly: true });
    await saveResources(config, path, { state: 'renewed' });
    console.log('TLS checked and uploaded to configured OSS/FC domains. No application build or deployment was run.');
    return;
  }
  const clients = await createClients(config);
  await saveResources(config, path, { state: 'deploying' });
  if (config.database) {
    const { createDatabaseClients, provisionDatabase } = await import('./database.mjs');
    const databaseClients = createDatabaseClients(config, clients.credential);
    Object.assign(artifacts.environment, await operation('Prepare database and runtime role', () => provisionDatabase(databaseClients, config)));
  }
  const tls = await operation('Prepare HTTPS certificate', () => prepareTls(config));
  await saveResources(config, path, { state: 'deploying' });
  if (config.backend) {
    await operation(`Deploy FC ${config.backend.functionName}`, () => deployBackend(clients.fc, config, artifacts.backendArchive, artifacts.environment));
    await ensureCname(clients.dns, config, config.backend.domain, `${config.accountId}.${config.region}.fc.aliyuncs.com`);
    await bindBackendDomain(clients.fc, config, tls);
    console.log(`Backend published: https://${config.backend.domain}`);
  }
  if (config.frontend) {
    await operation(`Deploy OSS ${config.frontend.bucket}`, () => deployFrontend(clients.oss, config, artifacts.frontendFiles, tls, { dns: clients.dns }));
    await ensureCname(clients.dns, config, config.frontend.domain, `${config.frontend.bucket}.oss-${config.region}.aliyuncs.com`);
    console.log(`Frontend published: https://${config.frontend.domain}`);
  }
  if (account && config.tls.acme?.agreeToTerms) {
    const { registerRenewal } = await import('./renewal.mjs');
    await registerRenewal(path);
  }
  const verification = await verifyApplication(config, { attempts: 12 });
  await saveResources(config, path, { state: verification.ok ? 'verified' : 'verification-failed' });
  console.log(JSON.stringify(verification, null, 2));
  if (!verification.ok) throw new Error('Cloud resources were deployed, but HTTPS acceptance failed. Run diagnose; do not report the application as online.');
  console.log('Deployment verified: HTTPS frontend and backend health passed. Complete the application-specific acceptance before handing it to the user.');
}

main().catch((error) => {
  console.error(JSON.stringify(errorInfo(error)));
  process.exitCode = 1;
});
