import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { applicationTemplate, applicationNames, deployApplicationStack, renewBackendCertificate, waitForStack, inspectCodeBucket, deleteApplicationStack, inspectApplicationStack, checkApplicationDns } from '../skills/aliyun/scripts/ros.mjs';
import { dnsResources, dnsTargets } from '../skills/aliyun/scripts/dns.mjs';
import { saveResources, readResources } from '../skills/aliyun/scripts/resources.mjs';
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
  const generated = applicationTemplate(config, 'code/a.zip', { APP_SECRET: secret }, certificates[0]);
  const serialized = JSON.stringify(generated.template);
  assert(!serialized.includes(secret) && !serialized.includes('BEGIN'));
  assert(generated.parameters.some(p => p.parameterValue === secret));
  assert(Object.values(generated.template.Parameters).every(p => p.NoEcho));
  assert.deepEqual(generated.template.Resources.Concurrency.Properties.FunctionName, { 'Fn::GetAtt': ['Function', 'FunctionName'] });
  assert.equal(generated.template.Resources.HttpTrigger.Properties.TriggerConfig.disableURLInternet, true);
  assert.equal(generated.template.Resources.Domain.Properties.Protocol, 'HTTPS');
  assert.deepEqual(generated.template.Resources.Domain.DependsOn, ['HttpTrigger', 'BackendDns']);
  assert.deepEqual(generated.template.Resources.FrontendDns, dnsResources(config).FrontendDns);
  assert.deepEqual(generated.template.Resources.BackendDns, dnsResources(config).BackendDns);

  let stack, template, calls = [], parameters;
  const records = [];
  const dns = { describeDomainRecords: async req => ({ body: { totalCount: records.length, domainRecords: { record: records.filter(record => record.RR === req.RRKeyWord) } } }) };
  const syncRecords = () => {
    records.splice(0, records.length, ...Object.entries(template.Resources).filter(([, r]) => r.Type === 'ALIYUN::DNS::DomainRecord').map(([id, r]) => ({ recordId: id, RR: r.Properties.RR, type: r.Properties.Type, value: r.Properties.Value, TTL: r.Properties.TTL, line: r.Properties.Line, status: 'ENABLE' })));
  };
  const ros = {
    listStacks: async req => { req.validate(); return { body: { stacks: stack ? [stack] : [] } }; },
    getStack: async req => { req.validate(); return { body: structuredClone(stack) }; },
    listStackResources: async req => { req.validate(); return { body: { resources: records.map(record => ({ logicalResourceId: record.recordId, physicalResourceId: record.recordId, resourceType: 'ALIYUN::DNS::DomainRecord', status: 'CREATE_COMPLETE' })) } }; },
    deleteStack: async req => { req.validate(); calls.push('delete'); records.length = 0; stack = { ...stack, status: 'DELETE_COMPLETE' }; },
    getTemplate: async req => { req.validate(); return { body: { templateBody: JSON.stringify(template) } }; },
    createStack: async req => {
      req.validate(); calls.push('create'); template = JSON.parse(req.templateBody); parameters = req.parameters; syncRecords();
      stack = { stackName: req.stackName, stackId: 'stack-123', tags: req.tags, status: 'CREATE_COMPLETE', updateTime: '1' };
      return { body: { stackId: stack.stackId } };
    },
    updateStack: async req => {
      req.validate(); calls.push('update'); template = JSON.parse(req.templateBody); parameters = req.parameters; syncRecords();
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
  records.push({ recordId: 'foreign', RR: dnsResources(config).BackendDns.Properties.RR, type: 'CNAME', value: dnsTargets(config)[1].value, line: 'default', status: 'ENABLE' });
  await assert.rejects(checkApplicationDns({ ros, dns }, config), /outside/);
  assert.equal(calls.length, 0); records.length = 0;
  await deployApplicationStack({ ros, codeOss, dns }, config, Buffer.from('archive'), { APP_SECRET: secret }, certificates[0]);
  await deployApplicationStack({ ros, codeOss, dns }, config, Buffer.from('new archive'), { APP_SECRET: secret }, certificates[0]);
  assert.deepEqual(calls, ['create', 'update']);
  assert.equal((await inspectApplicationStack(ros, config)).dnsResources.BackendDns.physicalResourceId, 'BackendDns');
  config.dns.ttl += 60;
  await deployApplicationStack({ ros, codeOss, dns }, config, Buffer.from('new archive'), { APP_SECRET: secret }, certificates[0]);
  assert.equal(records[0].TTL, config.dns.ttl);
  const update = ros.updateStack;
  ros.updateStack = async () => { throw Object.assign(new Error('do not log'), { code: 'NotSupported', data: { message: 'Update the completely same stack pi-aliyun-smoke is not supported.' } }); };
  await deployApplicationStack({ ros, codeOss, dns }, config, Buffer.from('new archive'), { APP_SECRET: secret }, certificates[0]);
  ros.updateStack = update;
  await renewBackendCertificate(ros, config, certificates[0]);
  assert.equal(calls.length, 3);
  const codeBefore = structuredClone(template.Resources.Function.Properties.Code);
  await renewBackendCertificate(ros, config, certificates[1]);
  assert.deepEqual(parameters.map(p => p.parameterKey), ['Certificate', 'PrivateKey']);
  assert.deepEqual(template.Resources.Function.Properties.Code, codeBefore);
  assert(!JSON.stringify(template).includes(secret));
  acl = 'public-read';
  await assert.rejects(inspectCodeBucket(codeOss, config), /private/);
  acl = 'private';
  stack.tags = [{ key: 'pi-aliyun-project', value: 'other-project' }];
  await assert.rejects(deployApplicationStack({ ros, codeOss, dns }, config, Buffer.from('x'), {}, certificates[0]), /not managed/);
  assert.equal(calls.length, 4);
  stack.tags = [{ key: 'pi-aliyun-project', value: config.project }];
  await deleteApplicationStack(ros, config);
  assert.equal(records.length, 0, 'ROS owns DNS teardown');
  stack = undefined;
  const frontendOnly = { ...config, backend: undefined, rosIdentity: { stackName: 'pi-aliyun-site-1234567890abcdef' } };
  await deployApplicationStack({ ros, dns }, frontendOnly, undefined, {}, certificates[0]);
  assert.deepEqual(Object.keys(template.Resources), ['FrontendDns']);
  assert.deepEqual(template.Parameters, {});
  await saveResources(frontendOnly, join(directory, 'aliyun.json'));
  const siteStackId = stack.stackId;
  const siteStackName = stack.stackName;
  const siteRecord = records[0].recordId;
  const expanded = validateConfig(raw, directory);
  await readResources(expanded, join(directory, 'aliyun.json'));
  assert.equal(applicationNames(expanded).stackName, siteStackName);
  const beforeExpansion = calls.length;
  await deployApplicationStack({ ros, dns, codeOss }, expanded, Buffer.from('added backend'), { APP_SECRET: secret }, certificates[0]);
  assert.deepEqual(calls.slice(beforeExpansion), ['update']);
  assert.equal(stack.stackId, siteStackId);
  assert.equal(records.find(record => record.recordId === siteRecord).recordId, siteRecord);
  assert(template.Resources.Function && template.Resources.BackendDns);
  await assert.rejects(deployApplicationStack({ ros, dns }, frontendOnly, undefined, {}, certificates[0]), /ownership/);
  await saveResources(expanded, join(directory, 'aliyun.json'));
  await assert.rejects(readResources(frontendOnly, join(directory, 'aliyun.json')), /Existing backend/);
  await deleteApplicationStack(ros, expanded);
  stack = undefined;
  const backendOnly = { ...config, frontend: undefined };
  await deployApplicationStack({ ros, dns, codeOss }, backendOnly, Buffer.from('api'), {}, certificates[0]);
  assert(!template.Resources.FrontendDns);
  await deployApplicationStack({ ros, dns, codeOss }, config, Buffer.from('add frontend'), {}, certificates[0]);
  assert(template.Resources.FrontendDns);
  await deleteApplicationStack(ros, config);

  let count = 0;
  const prior = { status: 'UPDATE_COMPLETE', updateTime: 'old' };
  await waitForStack({ getStack: async () => ({ body: ++count < 3 ? prior : { status: 'UPDATE_COMPLETE', updateTime: 'new' } }) }, config, 'stack-123', 'UPDATE_COMPLETE', { previousStack: prior, attempts: 3, wait: async () => {} });
  assert.equal(count, 3, 'must not accept stale completion from the previous update');
  await assert.rejects(waitForStack({ getStack: async () => ({ body: { status: 'CREATE_ROLLBACK_COMPLETE' } }), listStackEvents: async () => ({ body: { events: [{ statusReason: secret + ' AccessDenied' }] } }) }, config, 'stack-123', 'CREATE_COMPLETE'), error => error.code === 'AccessDenied' && !error.message.includes(secret));
  assert.equal(applicationNames(config).codeBucket.length <= 63, true);
  console.log('ROS smoke passed: private code storage, hidden secrets, frontend/backend DNS ownership and lifecycle, TTL update, certificate-only renewal, ownership refusal, asynchronous status and safe failures. No cloud APIs called.');
} finally { await rm(directory, { recursive: true, force: true }); }
