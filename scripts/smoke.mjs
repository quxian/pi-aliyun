import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPublicKey, sign, verify } from 'node:crypto';
import acme from 'acme-client';
import * as FC from '@alicloud/fc20230330';
import { validateConfig, plan } from '../skills/aliyun/scripts/config.mjs';
import { collectFiles, createArchive, buildArtifacts } from '../skills/aliyun/scripts/artifacts.mjs';
import { ensureCname, deployFrontend, deployBackend, bindFrontendDomain, bindBackendDomain, cacheControl, websiteXml, functionInput } from '../skills/aliyun/scripts/cloud.mjs';
import { uploadPrivateKey } from '../skills/aliyun/scripts/tls.mjs';
import { deploymentPolicy } from '../skills/aliyun/scripts/policy.mjs';
import { registerRenewal, renewRegistered, renewalUnits } from '../skills/aliyun/scripts/renewal.mjs';
import { resourceManifest, saveResources } from '../skills/aliyun/scripts/resources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'pi-aliyun-smoke-'));
const missing = (code) => Object.assign(new Error('not found'), { code });
try {
  const acmeKey = await acme.crypto.createPrivateKey();
  const cloudKey = uploadPrivateKey(acmeKey);
  assert.match(cloudKey, /^-----BEGIN RSA PRIVATE KEY-----/);
  const challenge = Buffer.from('FC certificate key encoding regression');
  assert(verify('sha256', challenge, createPublicKey(acmeKey), sign('sha256', challenge, cloudKey)));
  assert.equal(uploadPrivateKey(cloudKey), cloudKey);
  const cli = join(root, 'skills/aliyun/scripts/cli.mjs');
  const run = (command) => execFileSync(process.execPath, [cli, command], { cwd: temp, encoding: 'utf8', env: { ...process.env, ALIBABA_CLOUD_ACCESS_KEY_ID: 'smoke-do-not-use', ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'smoke-secret-do-not-print', ALIBABA_CLOUD_CREDENTIALS_URI: 'https://invalid.invalid' } });
  run('init');
  const raw = JSON.parse(await readFile(join(temp, 'aliyun.json'), 'utf8'));
  delete raw.frontend.build; delete raw.backend.build;
  raw.frontend.dir = 'static'; raw.backend.codeDir = 'server';
  raw.backend.envFrom = { DATABASE_URL: 'PI_ALIYUN_SMOKE_DATABASE' };
  process.env.PI_ALIYUN_SMOKE_DATABASE = 'not-a-real-database-secret';
  await writeFile(join(temp, 'aliyun.json'), JSON.stringify(raw));
  await mkdir(join(temp, 'static/assets'), { recursive: true });
  await mkdir(join(temp, 'server'), { recursive: true });
  await writeFile(join(temp, 'static/index.html'), '<h1>smoke</h1>');
  await writeFile(join(temp, 'static/assets/app-1234abcd.js'), 'console.log("ok")');
  await writeFile(join(temp, 'static/.env'), 'must-not-upload');
  await writeFile(join(temp, 'server/server.mjs'), 'console.log("server")');
  const config = validateConfig(raw, temp);
  const manifest = resourceManifest(config);
  assert.equal(manifest.frontend.bucket, config.frontend.bucket);
  assert.equal(manifest.backend.functionName, config.backend.functionName);
  assert(!JSON.stringify(manifest).includes('PI_ALIYUN_SMOKE_DATABASE'));
  await saveResources(config, join(temp, 'aliyun.json'));
  const savedManifest = JSON.parse(await readFile(join(temp, '.aliyun/resources.json'), 'utf8'));
  assert(savedManifest.deployedAt);
  assert.equal(savedManifest.project, config.project);
  assert(!JSON.stringify(savedManifest).includes('not-a-real-database-secret'));
  assert.equal(config.frontend.dir, join(temp, 'static'));
  assert.equal(config.backend.runtime, 'custom.debian10');
  assert(!JSON.stringify(plan(config)).includes('not-a-real-database-secret'));
  assert(!run('plan').includes('smoke-secret-do-not-print'));
  assert(run('build').includes('Local artifacts ready'));
  assert.throws(() => validateConfig({ ...raw, accountId: 'oops' }, temp));
  assert.throws(() => validateConfig({ ...raw, frontend: { ...raw.frontend, domain: 'example.com' } }, temp));
  assert.throws(() => validateConfig({ ...raw, backend: { ...raw.backend, memorySize: 500 } }, temp));
  const artifacts = await buildArtifacts(config);
  assert.equal(artifacts.frontendFiles.length, 2);
  assert.equal(artifacts.environment.DATABASE_URL, 'not-a-real-database-secret');
  const archiveAgain = await createArchive(await collectFiles(config.backend.codeDir));
  assert(artifacts.backendArchive.equals(archiveAgain));
  assert.equal(archiveAgain.readUInt32LE(0), 0x04034b50);
  await symlink(join(temp, 'server/server.mjs'), join(temp, 'static/leak'));
  await assert.rejects(collectFiles(config.frontend.dir), /symlink/);
  await rm(join(temp, 'static/leak'));
  assert.equal(cacheControl('assets/my-application.js'), 'no-cache');
  assert.match(cacheControl('assets/app-1234abcd.js'), /immutable/);
  assert.match(websiteXml(true), /<HttpStatus>200<\/HttpStatus>/);
  assert(!websiteXml(false).includes('ErrorDocument'));
  const input = functionInput(config, artifacts.backendArchive, artifacts.environment);
  const request = new FC.CreateFunctionRequest({ body: new FC.CreateFunctionInput(input) });
  request.validate();
  assert.deepEqual(input.customRuntimeConfig.command, ['/var/fc/lang/nodejs20/bin/node']);
  assert.deepEqual(input.customRuntimeConfig.args, ['server.mjs']);

  const calls = [];
  let functionExists = false;
  let triggerExists = false;
  let domainExists = false;
  let domainAttempts = 0;
  const fc = {
    getFunction: async () => { if (!functionExists) throw missing('FunctionNotFound'); return { body: { description: input.description } }; },
    createFunction: async (value) => { value.validate(); functionExists = true; calls.push('createFunction'); },
    updateFunction: async (_name, value) => { value.validate(); calls.push('updateFunction'); },
    putConcurrencyConfig: async (_name, value) => { assert.equal(value.body.reservedConcurrency, 5); },
    putScalingConfig: async (_name, value) => { assert.equal(value.body.minInstances, 0); },
    getTrigger: async () => { if (!triggerExists) throw missing('TriggerNotFound'); },
    createTrigger: async (_name, value) => { triggerExists = true; assert.equal(JSON.parse(value.body.triggerConfig).disableURLInternet, true); calls.push('createTrigger'); },
    updateTrigger: async () => calls.push('updateTrigger'),
    getCustomDomain: async () => { if (!domainExists) throw missing('DomainNameNotFound'); return { body: { routeConfig: { routes: [{ functionName: config.backend.functionName, path: '/*' }] } } }; },
    createCustomDomain: async (value) => { value.validate(); if (++domainAttempts === 1) throw missing('DomainNameNotResolved'); domainExists = true; calls.push('createDomain'); },
    updateCustomDomain: async (_name, value) => { value.validate(); calls.push('updateDomain'); },
  };
  const tls = { certificate: 'mock certificate', privateKey: 'mock private key' };
  await deployBackend(fc, config, artifacts.backendArchive, artifacts.environment);
  await deployBackend(fc, config, artifacts.backendArchive, artifacts.environment);
  await bindBackendDomain(fc, config, tls, { wait: async () => {} });
  assert.equal(domainAttempts, 2);
  await bindBackendDomain(fc, config, tls, { existingOnly: true });
  assert.deepEqual(calls, ['createFunction', 'createTrigger', 'updateFunction', 'updateTrigger', 'createDomain', 'updateDomain']);
  await assert.rejects(deployBackend({ ...fc, getFunction: async () => ({ body: { description: 'another project' } }) }, config, archiveAgain, {}), /not managed/);

  const records = [];
  let dnsWrites = 0;
  const dns = {
    describeDomainRecords: async () => ({ body: { totalCount: records.length, domainRecords: { record: records } } }),
    addDomainRecord: async (value) => { dnsWrites++; records.push({ ...value, recordId: '1', status: 'ENABLE' }); },
    updateDomainRecord: async (value) => { dnsWrites++; Object.assign(records[0], value); },
  };
  await ensureCname(dns, config, 'app.example.com', 'target.aliyuncs.com');
  await ensureCname(dns, config, 'app.example.com', 'target.aliyuncs.com');
  assert.equal(dnsWrites, 1);
  await assert.rejects(ensureCname(dns, config, 'app.example.com', 'new-target.aliyuncs.com'), /another resource/);
  assert.equal(dnsWrites, 1);
  records[0].TTL = config.dns.ttl + 60;
  await ensureCname(dns, config, 'app.example.com', 'target.aliyuncs.com');
  assert.equal(dnsWrites, 2);
  records.push({ RR: 'app', type: 'TXT', line: 'default' });
  await assert.rejects(ensureCname(dns, config, 'app.example.com', 'new-target.aliyuncs.com'), /conflicting/);

  let bucketExists = false;
  let blockPublicAccess = true;
  let tags = {};
  const uploads = [];
  const oss = {
    getBucketInfo: async () => { if (!bucketExists) throw missing('NoSuchBucket'); return { bucket: { Owner: { ID: config.accountId }, Location: `oss-${config.region}` } }; },
    putBucket: async (_name, options) => { assert.equal(options.acl, 'private'); bucketExists = true; },
    putBucketTags: async (_name, value) => { tags = value; },
    getBucketTags: async () => ({ tag: tags }),
    putBucketACL: async (_name, acl) => { assert.equal(blockPublicAccess, false); assert.equal(acl, 'public-read'); },
    request: async (value) => {
      assert([200].includes(value.successStatuses[0]));
      if (value.subres === 'publicAccessBlock') {
        assert.equal(value.bucket, config.frontend.bucket);
        assert.match(value.content, /<BlockPublicAccess>false<\/BlockPublicAccess>/);
        blockPublicAccess = false;
      }
    },
    put: async (key) => uploads.push(key),
  };
  await deployFrontend(oss, config, artifacts.frontendFiles, tls);
  assert.deepEqual(uploads, ['assets/app-1234abcd.js', 'index.html']);
  await deployFrontend(oss, config, artifacts.frontendFiles, tls);
  tags = {};
  blockPublicAccess = true;
  await assert.rejects(deployFrontend(oss, config, artifacts.frontendFiles, tls), /not managed/);
  assert.equal(blockPublicAccess, true);

  const verificationRecords = [{ RR: '_dnsauth.app', type: 'TXT', value: 'another-service', status: 'ENABLE', recordId: 'unrelated' }];
  let verifyAttempts = 0;
  const verificationDns = {
    describeDomainRecords: async () => ({ body: { totalCount: verificationRecords.length, domainRecords: { record: verificationRecords } } }),
    addDomainRecord: async (value) => { verificationRecords.push({ ...value, recordId: 'created-here', status: 'ENABLE' }); return { body: { recordId: 'created-here' } }; },
    deleteDomainRecord: async (value) => { assert.equal(value.recordId, 'created-here'); verificationRecords.splice(verificationRecords.findIndex((record) => record.recordId === value.recordId), 1); },
  };
  const verificationOss = {
    getBucketTags: async () => ({ tag: { 'pi-aliyun-project': config.project } }),
    request: async ({ subres }) => {
      if (subres.comp === 'token') return { data: { Bucket: config.frontend.bucket, Cname: config.frontend.domain, Token: 'verification-only' } };
      verifyAttempts++;
      if (verifyAttempts <= 2) throw missing('NeedVerifyDomainOwnership');
      assert(verificationRecords.some((record) => record.value === 'verification-only'));
    },
  };
  await bindFrontendDomain(verificationOss, config, tls, { dns: verificationDns, wait: async () => {} });
  assert.equal(verifyAttempts, 3);
  assert.deepEqual(verificationRecords.map((record) => record.recordId), ['unrelated']);
  const neverVerified = { ...verificationOss, request: async (value) => {
    if (value.subres.comp === 'token') return verificationOss.request(value);
    throw missing('NeedVerifyDomainOwnership');
  } };
  await assert.rejects(bindFrontendDomain(neverVerified, config, tls, { dns: verificationDns, attempts: 2, wait: async () => {} }), /timed out/);
  assert.deepEqual(verificationRecords.map((record) => record.recordId), ['unrelated']);
  verificationRecords.push({ RR: '_dnsauth.app', type: 'TXT', value: 'verification-only', status: 'ENABLE', recordId: 'preexisting' });
  verifyAttempts = 0;
  await bindFrontendDomain(verificationOss, config, tls, { dns: verificationDns, wait: async () => {} });
  assert.equal(verificationRecords.length, 2);

  const policyConfig = { accountId: config.accountId, region: config.region, zone: config.dns.zone };
  const policy = deploymentPolicy(policyConfig);
  assert(policy.Statement[0].Action.includes('oss:CreateCnameToken'));
  assert.equal(policy.Statement[0].Resource[0], `acs:oss:*:${config.accountId}:pi-aliyun-*-${config.accountId}`);
  assert(JSON.stringify(policy).includes('ram:CreateRole'));

  raw.tls.acme = { email: 'smoke@example.com', accountKeyFile: '.aliyun/tls/account-key.pem', agreeToTerms: true };
  assert.throws(() => validateConfig({ ...raw, tls: { ...raw.tls, acme: { ...raw.tls.acme, proxyUrl: 'http://user:secret@localhost:7890' } } }, temp), /without credentials/);
  assert.equal(validateConfig({ ...raw, tls: { ...raw.tls, acme: { ...raw.tls.acme, proxyUrl: 'http://127.0.0.1:7890' } } }, temp).tls.acme.proxyUrl, 'http://127.0.0.1:7890');
  const registry = join(temp, 'renewal/registry.json');
  const otherConfig = join(temp, 'other.json');
  await writeFile(join(temp, 'aliyun.json'), JSON.stringify(raw));
  await writeFile(otherConfig, JSON.stringify({ ...raw, project: 'other' }));
  await registerRenewal(join(temp, 'aliyun.json'), registry);
  await registerRenewal(join(temp, 'aliyun.json'), registry);
  await registerRenewal(otherConfig, registry);
  const renewed = [];
  await assert.rejects(renewRegistered(registry, { run: async (path) => { renewed.push(path); if (renewed.length === 1) throw new Error('simulated failure'); } }), /1 certificate/);
  assert.deepEqual(renewed, [join(temp, 'aliyun.json'), otherConfig]);
  const units = renewalUnits({ user: 'iceberg-client', registryPath: registry });
  assert.match(units['pi-aliyun-renew.service'], /User=iceberg-client/);
  assert.match(units['pi-aliyun-renew.service'], /renew-all --registry/);
  assert.match(units['pi-aliyun-renew.timer'], /Persistent=true/);
  assert.throws(() => renewalUnits({ user: 'root', registryPath: registry }), /non-root/);
  console.log('Smoke passed: local CLI/build/archive, SDK models, FC create/update, OSS publication/ownership verification, DNS conflicts/cleanup, cross-project policy and renewal registry/units. No cloud APIs called.');
} finally {
  delete process.env.PI_ALIYUN_SMOKE_DATABASE;
  await rm(temp, { recursive: true, force: true });
}
