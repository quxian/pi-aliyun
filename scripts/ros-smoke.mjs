import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { backendTemplate, backendNames, deployBackend, renewBackendCertificate, waitForStack, inspectCodeBucket } from '../skills/aliyun/scripts/ros.mjs';
import { validateConfig } from '../skills/aliyun/scripts/config.mjs';

const directory = await mkdtemp(join(tmpdir(), 'pi-aliyun-ros-'));
try {
  const raw = JSON.parse(await readFile(new URL('../skills/aliyun/assets/aliyun.example.json', import.meta.url), 'utf8'));
  const config = validateConfig(raw, directory);
  const certificates = [];
  for (const serial of [1, 2]) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=example.com', '-days', '2', '-set_serial', String(serial), '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
    certificates.push({ certificate: await readFile(join(directory, 'cert.pem'), 'utf8'), privateKey: await readFile(join(directory, 'key.pem'), 'utf8') });
  }
  const secret = 'business-secret-not-for-template';
  const generated = backendTemplate(config, 'code/a.zip', { APP_SECRET: secret }, certificates[0]);
  const serialized = JSON.stringify(generated.template);
  assert(!serialized.includes(secret) && !serialized.includes('BEGIN'));
  assert(generated.parameters.some(p => p.parameterValue === secret));
  assert(Object.values(generated.template.Parameters).every(p => p.NoEcho));
  assert.deepEqual(generated.template.Resources.Concurrency.Properties.FunctionName, { 'Fn::GetAtt': ['Function', 'FunctionName'] });
  assert.equal(generated.template.Resources.HttpTrigger.Properties.TriggerConfig.disableURLInternet, true);
  assert.equal(generated.template.Resources.Domain.Properties.Protocol, 'HTTPS');

  let stack, template, calls = [], parameters;
  const ros = {
    listStacks: async req => { req.validate(); return { body: { stacks: stack ? [stack] : [] } }; },
    getStack: async req => { req.validate(); return { body: structuredClone(stack) }; },
    getTemplate: async req => { req.validate(); return { body: { templateBody: JSON.stringify(template) } }; },
    createStack: async req => {
      req.validate(); calls.push('create'); template = JSON.parse(req.templateBody); parameters = req.parameters;
      stack = { stackName: req.stackName, stackId: 'stack-123', tags: req.tags, status: 'CREATE_COMPLETE', updateTime: '1' };
      return { body: { stackId: stack.stackId } };
    },
    updateStack: async req => {
      req.validate(); calls.push('update'); template = JSON.parse(req.templateBody); parameters = req.parameters;
      assert.equal(req.usePreviousParameters, true);
      stack = { ...stack, status: 'UPDATE_COMPLETE', updateTime: String(Number(stack.updateTime) + 1) };
      return { body: { stackId: stack.stackId } };
    },
  };
  let bucket = false, acl = 'private';
  const codeOss = {
    getBucketInfo: async () => { if (!bucket) throw Object.assign(new Error(), { code: 'NoSuchBucket' }); return { bucket: { Owner: { ID: config.accountId }, Location: config.region } }; },
    getBucketTags: async () => ({ tag: { 'pi-aliyun-project': config.project, 'pi-aliyun-purpose': 'backend-code' } }),
    getBucketACL: async () => ({ acl }),
    putBucket: async (_name, options) => { assert.equal(options.acl, 'private'); bucket = true; },
    putBucketTags: async () => {},
    put: async key => { assert.match(key, /^code\/[a-f0-9]{64}\.zip$/); },
  };
  await deployBackend({ ros, codeOss }, config, Buffer.from('archive'), { APP_SECRET: secret }, certificates[0]);
  await deployBackend({ ros, codeOss }, config, Buffer.from('new archive'), { APP_SECRET: secret }, certificates[0]);
  assert.deepEqual(calls, ['create', 'update']);
  const update = ros.updateStack;
  ros.updateStack = async () => { throw Object.assign(new Error('do not log'), { code: 'NotSupported', data: { message: 'Update the completely same stack pi-aliyun-smoke is not supported.' } }); };
  await deployBackend({ ros, codeOss }, config, Buffer.from('new archive'), { APP_SECRET: secret }, certificates[0]);
  ros.updateStack = update;
  await renewBackendCertificate(ros, config, certificates[0]);
  assert.equal(calls.length, 2);
  const codeBefore = structuredClone(template.Resources.Function.Properties.Code);
  await renewBackendCertificate(ros, config, certificates[1]);
  assert.deepEqual(parameters.map(p => p.parameterKey), ['Certificate', 'PrivateKey']);
  assert.deepEqual(template.Resources.Function.Properties.Code, codeBefore);
  assert(!JSON.stringify(template).includes(secret));
  acl = 'public-read';
  await assert.rejects(inspectCodeBucket(codeOss, config), /private/);
  acl = 'private';
  stack.tags = [{ key: 'pi-aliyun-project', value: 'other-project' }];
  await assert.rejects(deployBackend({ ros, codeOss }, config, Buffer.from('x'), {}, certificates[0]), /not managed/);
  assert.equal(calls.length, 3);

  let count = 0;
  const prior = { status: 'UPDATE_COMPLETE', updateTime: 'old' };
  await waitForStack({ getStack: async () => ({ body: ++count < 3 ? prior : { status: 'UPDATE_COMPLETE', updateTime: 'new' } }) }, config, 'stack-123', 'UPDATE_COMPLETE', { previousStack: prior, attempts: 3, wait: async () => {} });
  assert.equal(count, 3, 'must not accept stale completion from the previous update');
  await assert.rejects(waitForStack({ getStack: async () => ({ body: { status: 'CREATE_ROLLBACK_COMPLETE' } }), listStackEvents: async () => ({ body: { events: [{ statusReason: secret + ' AccessDenied' }] } }) }, config, 'stack-123', 'CREATE_COMPLETE'), error => error.code === 'AccessDenied' && !error.message.includes(secret));
  assert.equal(backendNames(config).codeBucket.length <= 63, true);
  console.log('ROS smoke passed: private code storage, hidden secrets, create/update, certificate-only renewal, ownership refusal, asynchronous status and safe failures. No cloud APIs called.');
} finally { await rm(directory, { recursive: true, force: true }); }
