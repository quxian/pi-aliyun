import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { validatePlatform, projectConfig, platformPlan, checkPlatformProject, checkPersistentProject, initProject, ensureProjectRole } from '../skills/aliyun/scripts/platform.mjs';
import { ensurePlatformPolicy, bootstrapPlatform } from '../skills/aliyun/scripts/platform-admin.mjs';
import { authorize } from '../skills/aliyun/scripts/authorizer-handler.mjs';
import { databaseAccess } from '../skills/aliyun/scripts/database-plan.mjs';

const root = await mkdtemp(join(tmpdir(), 'pi-aliyun-platform-'));
try {
  const p = validatePlatform({ version: 2, accountId: '1234567890123456', region: 'cn-beijing', zone: 'example.com', projectRoot: join(root, 'projects'), authorizerFunction: 'pi-aliyun-authorizer', deployerRole: 'pi-aliyun-deployer' });
  await mkdir(p.projectRoot);
  const plan = platformPlan(p);
  const text = JSON.stringify(plan.deploymentPolicy);
  assert(!text.includes('ram:CreateRole') && !text.includes('ram:CreatePolicy'));
  assert(plan.deploymentPolicy.Statement.some(s => s.Effect === 'Deny' && s.Action.includes('fc:UpdateFunction')));
  assert(plan.deploymentPolicy.Statement.some(s => s.Effect === 'Deny' && s.Action.includes('ram:PassRole')));
  assert(JSON.stringify(plan.authorizerPolicy).includes('CreatePolicyVersion'));
  assert(text.includes('ots:InsertInstance') && text.includes('instance/pi-app-*'));
  for (const action of ['oss:PutBucket', 'oss:PutObject', 'fc:CreateFunction', 'alidns:AddDomainRecord', 'yundun-cert:CreateSSLCertificate']) assert(text.includes(action));
  assert(text.includes(`pi-aliyun-*-${p.accountId}`) && text.includes(`domain/${p.zone}`));
  assert(!text.includes('pi-data-ssd') && !text.includes('ots:GetRow'));
  assert.throws(() => projectConfig(p, '../escape'), /namespace|matching/);
  assert.throws(() => projectConfig(p, p.authorizerFunction), /excluding/);
  assert.throws(() => validatePlatform({ ...p, secret: 'do-not-accept' }), /fields/);
  assert.throws(() => validatePlatform({ ...p, version: 999 }), /version/);
  const authorization = 'Operator confirmed ongoing deployment within this account, region, zone and the agreed usage budget.';
  assert.equal(validatePlatform({ ...p, authorization }).authorization, authorization);
  assert.throws(() => validatePlatform({ ...p, authorization: '' }), /authorization/);
  await initProject(p, 'pi-aliyun-example');
  const config = JSON.parse(await readFile(join(p.projectRoot, 'pi-aliyun-example/aliyun.json')));
  assert.equal(config.frontend.domain, 'example.example.com');
  checkPlatformProject(p, config);
  assert.throws(() => checkPlatformProject(p, { ...config, backend: { ...config.backend, functionName: p.authorizerFunction } }), /functionName/);
  // The configured projectRoot is an init default, not a deployment-path restriction.
  await checkPersistentProject(p, fileURLToPath(new URL('../../outside-application.json', import.meta.url)));
  await assert.rejects(checkPersistentProject(p, join(root, 'aliyun.json')), /persistent/);
  await symlink(fileURLToPath(new URL('../', import.meta.url)), join(p.projectRoot, 'package'));
  await assert.rejects(checkPersistentProject(p, join(p.projectRoot, 'package/aliyun.json')), /installation/);
  await assert.rejects(initProject(p, 'pi-aliyun-example'), /EEXIST/);

  const roles = new Map(), policies = new Map(), attached = new Map(); let writes = 0;
  const policyDocument = name => { const p = policies.get(name); return p.versions.get(p.defaultVersion).policyDocument; };
  const missing = code => Object.assign(new Error('missing'), { code });
  const ram = {
    getRole: async r => { if (!roles.has(r.roleName)) throw missing('EntityNotExist.Role'); return { body: { role: roles.get(r.roleName) } }; },
    createRole: async r => { writes++; roles.set(r.roleName, { description: r.description, assumeRolePolicyDocument: r.assumeRolePolicyDocument }); },
    listPoliciesForRole: async r => ({ body: { policies: { policy: attached.get(r.roleName) || [] } } }),
    getPolicy: async r => { if (!policies.has(r.policyName)) throw missing('EntityNotExist.Policy'); return { body: { policy: policies.get(r.policyName) } }; },
    getPolicyVersion: async r => ({ body: { policyVersion: policies.get(r.policyName).versions.get(r.versionId) } }),
    listEntitiesForPolicy: async r => ({ body: { roles: { role: [...attached].filter(([, ps]) => ps.some(p => p.policyName === r.policyName)).map(([roleName]) => ({ roleName })) } } }),
    listPolicyVersions: async r => { const p = policies.get(r.policyName); return { body: { policyVersions: { policyVersion: [...p.versions].map(([versionId, v]) => ({ ...v, versionId, isDefaultVersion: versionId === p.defaultVersion })) } } }; },
    createPolicy: async r => { writes++; policies.set(r.policyName, { description: r.description, defaultVersion: 'v1', sequence: 1, versions: new Map([['v1', { policyDocument: r.policyDocument, createDate: '2026-10-01T00:00:01Z' }]]) }); },
    createPolicyVersion: async r => { writes++; const p = policies.get(r.policyName), id = `v${++p.sequence}`; assert(p.versions.size < 5); p.versions.set(id, { policyDocument: r.policyDocument, createDate: `2026-10-01T00:00:0${p.sequence}Z` }); if (r.setAsDefault) p.defaultVersion = id; },
    deletePolicyVersion: async r => { writes++; const p = policies.get(r.policyName); assert.notEqual(p.defaultVersion, r.versionId); p.versions.delete(r.versionId); },
    attachPolicyToRole: async r => { writes++; attached.set(r.roleName, [{ policyName: r.policyName, policyType: r.policyType }]); },
  };
  await assert.rejects(bootstrapPlatform(p, { ram, fc: new Proxy({}, { get: () => { throw new Error('FC must not be called before the deployment role exists'); } }) }, Buffer.from('unused archive'), plan.fingerprint), /Configured deployment role .* does not exist/);
  assert.equal(writes, 0);
  assert.equal(roles.size, 0);
  assert.equal(policies.size, 0);
  for (const input of [
    { version: 2, operation: 'ensure', project: 'pi-aliyun-safe', policy: { Action: '*' } },
    { version: 2, operation: 'ensure', project: p.authorizerFunction },
    { version: 2, operation: 'ensure', project: 'pi-aliyun-*' },
    { version: 2, operation: 'delete', project: 'pi-aliyun-safe' },
    { version: 2, operation: 'ensure', project: 'pi-aliyun-safe', accountId: '999999' },
    { version: 2, operation: 'ensure', project: 'pi-aliyun-safe', instance: 'foreign-instance' },
    { version: 2, operation: 'ensure', project: 'pi-aliyun-safe', shared: { ownerProject: 'pi-aliyun-owner', reason: 'same system', endpoint: 'https://foreign.example.com' } },
    { version: 2, operation: 'ensure', project: 'pi-aliyun-safe', shared: { ownerProject: 'pi-aliyun-owner', reason: ' ' } },
    { version: 2, operation: 'ensure', project: 'pi-aliyun-safe', shared: { ownerProject: 'unmanaged-owner', reason: 'same system' } },
  ]) await assert.rejects(authorize(input, p, ram));
  assert.equal(writes, 0);
  const first = await authorize({ version: 2, operation: 'ensure', project: 'pi-aliyun-one' }, p, ram);
  const second = await authorize({ version: 2, operation: 'ensure', project: 'pi-aliyun-two' }, p, ram);
  assert.notEqual(first.roleArn, second.roleArn);
  const one = databaseAccess(projectConfig(p, 'pi-aliyun-one')), two = databaseAccess(projectConfig(p, 'pi-aliyun-two'));
  assert.notEqual(one.instanceName, two.instanceName);
  assert(!policyDocument(one.policyName).includes(two.prefix));
  assert(!policyDocument(one.policyName).includes(two.instanceName));
  assert(policyDocument(one.policyName).includes(one.prefix));
  const beforeRepeat = writes;
  await authorize({ version: 2, operation: 'ensure', project: 'pi-aliyun-one' }, p, ram);
  assert.equal(writes, beforeRepeat);
  const shared = { ownerProject: 'pi-aliyun-one', reason: 'Explicitly share the same system data' };
  const consumer = projectConfig(p, 'pi-aliyun-consumer', shared), consumerAccess = databaseAccess(consumer);
  assert.equal(consumerAccess.instanceName, one.instanceName);
  assert.equal(consumerAccess.prefix, one.prefix);
  assert.notEqual(consumerAccess.roleName, one.roleName);
  await authorize({ version: 2, operation: 'ensure', project: consumer.project, shared }, p, ram);
  assert(policyDocument(consumerAccess.policyName).includes(one.instanceName));
  assert.throws(() => checkPlatformProject(p, { ...config, database: { instance: 'pi-data-ssd', clusterType: 'SSD' } }), /application-owned/);
  checkPlatformProject(p, { ...config, database: { ...projectConfig(p, config.project, shared).database, clusterType: 'SSD' } });
  const runtime = projectConfig(p, 'pi-aliyun-three');
  let invokes = 0;
  const fc = { invokeFunction: async (name, request) => {
    invokes++; assert.equal(name, p.authorizerFunction);
    const chunks = []; for await (const b of request.body) chunks.push(b);
    // The FC SDK concatenates byte chunks before signing the request.
    const body = Buffer.concat(chunks).toString();
    return { body: Readable.from([JSON.stringify(await authorize(JSON.parse(body), p, ram))]) };
  } };
  await ensureProjectRole(fc, ram, runtime, p);
  await ensureProjectRole(fc, ram, runtime, p);
  assert.equal(invokes, 1);
  const runtimeShared = projectConfig(p, runtime.project, shared);
  await ensureProjectRole(fc, ram, runtimeShared, p);
  assert.equal(invokes, 2);
  assert(policyDocument(databaseAccess(runtimeShared).policyName).includes(one.instanceName));
  attached.set(one.roleName, [{ policyName: 'AdministratorAccess', policyType: 'System' }]);
  const previous = writes;
  await assert.rejects(authorize({ version: 2, operation: 'ensure', project: 'pi-aliyun-one' }, p, ram), /additional/);
  assert.equal(writes, previous);
  const policyName = plan.deploymentPolicyName;
  await ensurePlatformPolicy(ram, policyName, plan.deploymentPolicy, p.deployerRole);
  for (let n = 0; n < 4; n++) await ram.createPolicyVersion({ policyName, policyDocument: JSON.stringify({ Version: '1', Statement: [] }), setAsDefault: true });
  const oldDefault = policies.get(policyName).defaultVersion;
  await ensurePlatformPolicy(ram, policyName, plan.deploymentPolicy, p.deployerRole);
  assert.equal(policies.get(policyName).versions.size, 5);
  assert(policies.get(policyName).versions.has(oldDefault));
  assert(!policies.get(policyName).versions.has('v1'));
  assert.deepEqual(JSON.parse(policyDocument(policyName)), plan.deploymentPolicy);
  const noMoreWrites = writes;
  const unchangedPlan = JSON.stringify(plan);
  await ensurePlatformPolicy(ram, policyName, plan.deploymentPolicy, p.deployerRole);
  assert.equal(writes, noMoreWrites);
  assert.equal(JSON.stringify(plan), unchangedPlan);
  attached.set('unrelated-role', [{ policyName, policyType: 'Custom' }]);
  await assert.rejects(ensurePlatformPolicy(ram, policyName, plan.deploymentPolicy, p.deployerRole), /unrelated attachments/);
  assert.equal(writes, noMoreWrites);
  console.log('Platform smoke passed: independent instances, explicit sharing, fixed-template input rejection, managed policy upgrades, protected authorizer, persistent source paths and deployment integration. No cloud APIs called.');
} finally { await rm(root, { recursive: true, force: true }); }
