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
import { ensureCname, deployFrontend, deployBackend, bindBackendDomain, cacheControl, websiteXml, functionInput } from '../skills/aliyun/scripts/cloud.mjs';
import { uploadPrivateKey } from '../skills/aliyun/scripts/tls.mjs';

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
    createCustomDomain: async (value) => { value.validate(); domainExists = true; calls.push('createDomain'); },
    updateCustomDomain: async (_name, value) => { value.validate(); calls.push('updateDomain'); },
  };
  const tls = { certificate: 'mock certificate', privateKey: 'mock private key' };
  await deployBackend(fc, config, artifacts.backendArchive, artifacts.environment);
  await deployBackend(fc, config, artifacts.backendArchive, artifacts.environment);
  await bindBackendDomain(fc, config, tls);
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
  await ensureCname(dns, config, 'app.example.com', 'new-target.aliyuncs.com');
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
  console.log('Smoke passed: local CLI/build/archive, SDK models, FC create/update, OSS publication order/ownership, DNS idempotence/conflicts. No cloud APIs called.');
} finally {
  delete process.env.PI_ALIYUN_SMOKE_DATABASE;
  await rm(temp, { recursive: true, force: true });
}
