import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { validatePlatform, projectConfig, platformPlan, checkPlatformProject, checkPersistentProject, initProject, ensureProjectRole } from '../skills/aliyun/scripts/platform.mjs';
import { authorize } from '../skills/aliyun/scripts/authorizer-handler.mjs';
import { databaseAccess } from '../skills/aliyun/scripts/database-plan.mjs';

const root = await mkdtemp(join(tmpdir(), 'pi-aliyun-platform-'));
try {
  const p = validatePlatform({ version: 1, accountId: '1234567890123456', region: 'cn-beijing', zone: 'example.com', instance: 'pi-data-ssd', projectRoot: join(root, 'projects'), authorizerFunction: 'pi-aliyun-authorizer', deployerRole: 'pi-aliyun-deployer' });
  await mkdir(p.projectRoot);
  const plan = platformPlan(p);
  const text = JSON.stringify(plan.deploymentPolicy);
  assert(!text.includes('ram:CreateRole') && !text.includes('ram:CreatePolicy'));
  assert(plan.deploymentPolicy.Statement.some(s => s.Effect === 'Deny' && s.Action.includes('fc:UpdateFunction')));
  assert(plan.deploymentPolicy.Statement.some(s => s.Effect === 'Deny' && s.Action.includes('ram:PassRole')));
  assert(!JSON.stringify(plan.authorizerPolicy).includes('CreatePolicyVersion'));
  assert.throws(() => projectConfig(p, '../escape'), /namespace|matching/);
  assert.throws(() => projectConfig(p, p.authorizerFunction), /excluding/);
  assert.throws(() => validatePlatform({ ...p, secret: 'do-not-accept' }), /fields/);
  await initProject(p, 'pi-aliyun-example');
  const config = JSON.parse(await readFile(join(p.projectRoot, 'pi-aliyun-example/aliyun.json')));
  assert.equal(config.frontend.domain, 'example.example.com');
  checkPlatformProject(p, config);
  assert.throws(() => checkPlatformProject(p, { ...config, backend: { ...config.backend, functionName: p.authorizerFunction } }), /functionName/);
  await checkPersistentProject(p, join(p.projectRoot, 'pi-aliyun-example/aliyun.json'));
  await assert.rejects(checkPersistentProject(p, join(root, 'aliyun.json')), /persistent|projectRoot/);
  await symlink(root, join(p.projectRoot, 'escape'));
  await assert.rejects(checkPersistentProject(p, join(p.projectRoot, 'escape/aliyun.json')), /projectRoot/);
  await assert.rejects(initProject(p, 'pi-aliyun-example'), /EEXIST/);

  const roles = new Map(), policies = new Map(), attached = new Map(); let writes = 0;
  const missing = code => Object.assign(new Error('missing'), { code });
  const ram = {
    getRole: async r => { if (!roles.has(r.roleName)) throw missing('EntityNotExist.Role'); return { body: { role: roles.get(r.roleName) } }; },
    createRole: async r => { writes++; roles.set(r.roleName, { description: r.description, assumeRolePolicyDocument: r.assumeRolePolicyDocument }); },
    listPoliciesForRole: async r => ({ body: { policies: { policy: attached.get(r.roleName) || [] } } }),
    getPolicy: async r => { if (!policies.has(r.policyName)) throw missing('EntityNotExist.Policy'); return { body: { policy: { defaultVersion: 'v1' } } }; },
    getPolicyVersion: async r => ({ body: { policyVersion: { policyDocument: policies.get(r.policyName) } } }),
    createPolicy: async r => { writes++; policies.set(r.policyName, r.policyDocument); },
    attachPolicyToRole: async r => { writes++; attached.set(r.roleName, [{ policyName: r.policyName, policyType: r.policyType }]); },
  };
  for (const input of [
    { version: 1, operation: 'ensure', project: 'pi-aliyun-safe', policy: { Action: '*' } },
    { version: 1, operation: 'ensure', project: p.authorizerFunction },
    { version: 1, operation: 'ensure', project: 'pi-aliyun-*' },
    { version: 1, operation: 'delete', project: 'pi-aliyun-safe' },
    { version: 1, operation: 'ensure', project: 'pi-aliyun-safe', accountId: '999999' },
  ]) await assert.rejects(authorize(input, p, ram));
  assert.equal(writes, 0);
  const first = await authorize({ version: 1, operation: 'ensure', project: 'pi-aliyun-one' }, p, ram);
  const second = await authorize({ version: 1, operation: 'ensure', project: 'pi-aliyun-two' }, p, ram);
  assert.notEqual(first.roleArn, second.roleArn);
  const one = databaseAccess(projectConfig(p, 'pi-aliyun-one')), two = databaseAccess(projectConfig(p, 'pi-aliyun-two'));
  assert(!policies.get(one.policyName).includes(two.prefix));
  assert(policies.get(one.policyName).includes(one.prefix));
  await authorize({ version: 1, operation: 'ensure', project: 'pi-aliyun-one' }, p, ram);
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
  attached.set(one.roleName, [{ policyName: 'AdministratorAccess', policyType: 'System' }]);
  const previous = writes;
  await assert.rejects(authorize({ version: 1, operation: 'ensure', project: 'pi-aliyun-one' }, p, ram), /additional/);
  assert.equal(writes, previous);
  console.log('Platform smoke passed: fixed-template input rejection, project isolation, interrupted/idempotent provisioning, protected authorizer policy, persistent project paths, and deployment integration. No cloud APIs called.');
} finally { await rm(root, { recursive: true, force: true }); }
