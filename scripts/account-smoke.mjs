import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAccount, loadAccount, defaultAccountPath, checkAccountProject, checkPersistentProject, initProject } from '../skills/aliyun/scripts/account.mjs';
import { deploymentPolicy } from '../skills/aliyun/scripts/policy.mjs';
import { databaseNames } from '../skills/aliyun/scripts/database-plan.mjs';

const root = await mkdtemp(join(tmpdir(), 'pi-aliyun-account-'));
try {
  const p = validateAccount({ version: 1, accountId: '1234567890123456', region: 'cn-beijing', zone: 'example.com', projectRoot: join(root, 'projects'), acmeEmail: 'operator@example.com' });
  assert.equal(defaultAccountPath(), join(homedir(), '.config/pi-aliyun/account.json'));
  assert.throws(() => validateAccount({ ...p, secret: 'not-a-profile-field' }), /fields/);
  assert.throws(() => validateAccount({ ...p, version: 2 }), /version/);
  assert.throws(() => validateAccount({ ...p, projectRoot: '/' }), /persistent/);
  assert.throws(() => validateAccount({ ...p, acmeProxyUrl: 'http://user:password@localhost:7890' }), /proxy/);
  const authorization = 'The operator approves ongoing independent application deployments and the agreed pay-as-you-go usage.';
  assert.equal(validateAccount({ ...p, authorization }).authorization, authorization);
  assert.throws(() => validateAccount({ ...p, authorization: '' }), /authorization/);
  await writeFile(join(root, 'account.json'), JSON.stringify(p));
  assert.deepEqual(await loadAccount(join(root, 'account.json')), p);
  assert.equal(await loadAccount(join(root, 'missing.json'), { optional: true }), undefined);
  await assert.rejects(loadAccount(join(root, 'missing.json')), /ENOENT/);

  const policy = deploymentPolicy(p);
  const text = JSON.stringify(policy);
  const actions = policy.Statement.flatMap(statement => statement.Action);
  for (const action of ['oss:PutBucket', 'oss:PutObject', 'fc:CreateFunction', 'fc:UpdateCustomDomain', 'alidns:AddDomainRecord', 'yundun-cert:CreateSSLCertificate', 'ots:InsertInstance', 'ots:CreateTable', 'ram:CreateRole', 'ram:CreatePolicy', 'ram:CreatePolicyVersion', 'ram:DeletePolicyVersion', 'ram:AttachPolicyToRole', 'ram:PassRole']) assert(actions.includes(action), action);
  assert(text.includes(`pi-aliyun-*-${p.accountId}`) && text.includes(`domain/${p.zone}`));
  assert(text.includes('instance/pi-app-*') && text.includes('role/pi-db-pi-aliyun-*') && text.includes('policy/PiDatabase-pi-aliyun-*'));
  assert(!actions.includes('fc:InvokeFunction') && !actions.includes('ots:GetRow'));
  assert(policy.Statement.every(statement => statement.Effect === 'Allow'));
  assert.equal(policy.Statement.find(statement => statement.Action.includes('ram:PassRole')).Condition.StringEquals['acs:Service'], 'fc.aliyuncs.com');

  await initProject(p, 'pi-aliyun-one');
  const config = JSON.parse(await readFile(join(p.projectRoot, 'pi-aliyun-one/aliyun.json')));
  assert.equal(config.frontend.domain, 'one.example.com');
  assert.equal(config.backend.domain, 'one-api.example.com');
  assert.equal(config.backend.maxInstances, 1);
  assert.equal(config.tls.acme.email, p.acmeEmail);
  assert.equal(config.tls.acme.agreeToTerms, false);
  checkAccountProject(p, config);
  await assert.rejects(initProject(p, 'pi-aliyun-one'), /EEXIST/);
  await assert.rejects(initProject(p, '../escape'), /matching/);
  const existing = join(root, 'existing');
  await mkdir(existing);
  await writeFile(join(existing, '.gitignore'), 'custom-build/\n');
  await initProject({ ...p, acmeTermsAccepted: true }, 'pi-aliyun-existing', join(existing, 'aliyun.json'));
  const adopted = JSON.parse(await readFile(join(existing, 'aliyun.json')));
  assert.equal(adopted.region, p.region);
  assert.equal(adopted.backend.cpu, config.backend.cpu);
  assert.equal(adopted.tls.acme.agreeToTerms, true);
  assert.match(await readFile(join(existing, '.gitignore'), 'utf8'), /custom-build/);
  assert.throws(() => checkAccountProject(p, { ...config, region: 'cn-hangzhou' }), /differs/);
  assert.throws(() => checkAccountProject(p, { ...config, frontend: { ...config.frontend, bucket: 'another-application' } }), /bucket/);
  assert.throws(() => checkAccountProject(p, { ...config, backend: { ...config.backend, functionName: 'another-application' } }), /functionName/);

  const one = databaseNames(config);
  const two = databaseNames({ ...config, project: 'pi-aliyun-two' });
  assert.notEqual(one.instanceName, two.instanceName);
  assert.notEqual(one.prefix, two.prefix);
  assert.notEqual(one.roleName, two.roleName);
  checkAccountProject(p, { ...config, database: { instance: one.instanceName, clusterType: 'SSD' } });
  checkAccountProject(p, { ...config, database: { instance: one.instanceName, clusterType: 'HYBRID' } });
  assert.throws(() => checkAccountProject(p, { ...config, database: { instance: two.instanceName, clusterType: 'SSD' } }), /own instance/);
  const shared = { ownerProject: 'pi-aliyun-two', reason: 'The operator explicitly requested common data for this system' };
  const consumer = { ...config, database: { shared, instance: two.instanceName, clusterType: 'SSD' } };
  checkAccountProject(p, consumer);
  assert.equal(databaseNames(consumer).prefix, two.prefix);
  assert.equal(databaseNames(consumer).roleName, one.roleName);
  assert.throws(() => checkAccountProject(p, { ...consumer, database: { ...consumer.database, shared: { ...shared, reason: '' } } }), /reason/);
  assert.throws(() => checkAccountProject(p, { ...consumer, database: { ...consumer.database, shared: { ...shared, ownerProject: 'other-owner' } } }), /namespace/);

  // projectRoot is an initialization default; deployment can use any persistent source directory.
  await checkPersistentProject(p, fileURLToPath(new URL('../../outside-application.json', import.meta.url)));
  await assert.rejects(checkPersistentProject(p, join(root, 'aliyun.json')), /persistent/);
  await mkdir(join(root, 'links'));
  await symlink(fileURLToPath(new URL('../', import.meta.url)), join(root, 'links/package'));
  await assert.rejects(checkPersistentProject(p, join(root, 'links/package/aliyun.json')), /installation/);
  console.log('Account smoke passed: account configuration, complete direct deployment policy, independent resources, explicit sharing, project initialization and persistent source paths. No cloud APIs called.');
} finally { await rm(root, { recursive: true, force: true }); }
