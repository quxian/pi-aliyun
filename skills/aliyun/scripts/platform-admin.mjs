import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import RAMModule, * as RAM from '@alicloud/ram20150501';
import * as FC from '@alicloud/fc20230330';
import { isDeepStrictEqual } from 'node:util';
import { platformPlan } from './platform.mjs';
import { collectFiles, createArchive } from './artifacts.mjs';

const marker = 'Managed by pi-aliyun platform';
async function ramDependencies() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const seen = new Set(), files = [];
  async function visit(name, parent) {
    const require = createRequire(join(parent, 'package.json'));
    let entry;
    try { entry = require.resolve(`${name}/package.json`); }
    catch { entry = require.resolve(name); }
    let directory = dirname(entry);
    let pkg;
    for (;;) {
      try { pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); } catch { pkg = undefined; }
      if (pkg?.name === name) break;
      const next = dirname(directory);
      if (next === directory) throw new Error(`Cannot locate installed dependency ${name}`);
      directory = next;
    }
    if (seen.has(directory)) return;
    const prefix = relative(root, directory).split(sep).join('/');
    if (!prefix.startsWith('node_modules/')) throw new Error('Authorizer dependency must be installed within the package');
    seen.add(directory);
    files.push(...(await collectFiles(directory)).map(f => ({ ...f, key: `${prefix}/${f.key}` })));
    for (const dependency of Object.keys(pkg.dependencies || {})) await visit(dependency, directory);
  }
  await visit('@alicloud/ram20150501', root);
  return [...new Map(files.map(f => [f.key, f])).values()];
}
export async function preparePlatformBundle(profile, output) {
  const plan = platformPlan(profile);
  await mkdir(output, { recursive: true });
  const temp = await mkdtemp(join(tmpdir(), 'pi-aliyun-platform-'));
  try {
    await writeFile(join(temp, 'settings.json'), JSON.stringify({ accountId: profile.accountId, region: profile.region, instance: profile.instance, authorizerFunction: profile.authorizerFunction }));
    const source = fileURLToPath(new URL('.', import.meta.url));
    const files = [
      { path: join(source, 'authorizer-handler.mjs'), key: 'index.mjs' },
      ...['database-plan.mjs', 'database-role.mjs'].map(key => ({ path: join(source, key), key })),
      { path: join(temp, 'settings.json'), key: 'settings.json' },
      ...await ramDependencies(),
    ];
    const archive = await createArchive(files);
    await writeFile(join(output, 'authorizer.zip'), archive, { mode: 0o600 });
    for (const [name, value] of Object.entries({ 'platform-plan': plan, 'authorizer-trust': plan.trust, 'authorizer-policy': plan.authorizerPolicy, 'deployment-policy': plan.deploymentPolicy })) {
      await writeFile(join(output, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    }
    console.log(`Prepared administrator bundle: ${output}; ZIP ${archive.length} bytes; fingerprint ${plan.fingerprint}`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
function parse(value) { try { return JSON.parse(value); } catch { return JSON.parse(decodeURIComponent(value)); } }
// RAM's console may collapse singleton lists; compare their meanings, not formatting.
function normalize(policy) {
  const list = v => Array.isArray(v) ? v : [v];
  return { ...policy, Statement: list(policy.Statement).map(s => ({ ...s,
    ...(s.Action ? { Action: list(s.Action).sort() } : {}), ...(s.Resource ? { Resource: list(s.Resource).sort() } : {}),
    ...(s.Principal ? { Principal: Object.fromEntries(Object.entries(s.Principal).map(([k,v]) => [k,list(v).sort()])) } : {}),
  })) };
}
async function ensurePolicy(ram, name, expected) {
  try {
    const p = (await ram.getPolicy(new RAM.GetPolicyRequest({ policyName: name, policyType: 'Custom' }))).body.policy;
    const v = (await ram.getPolicyVersion(new RAM.GetPolicyVersionRequest({ policyName: name, policyType: 'Custom', versionId: p.defaultVersion }))).body.policyVersion;
    if (p.description !== marker || !isDeepStrictEqual(normalize(parse(v.policyDocument)), normalize(expected))) throw new Error(`Existing platform policy differs: ${name}; administrator review required`);
  } catch (error) {
    if (error.code !== 'EntityNotExist.Policy') throw error;
    await ram.createPolicy(new RAM.CreatePolicyRequest({ policyName: name, description: marker, policyDocument: JSON.stringify(expected) }));
  }
}
export async function bootstrapPlatform(profile, clients, archive, fingerprint) {
  const plan = platformPlan(profile);
  if (fingerprint !== plan.fingerprint) throw new Error('platform-bootstrap requires the exact user-approved platform-plan fingerprint');
  const Client = RAMModule.default || RAMModule;
  const ram = new Client({ credential: clients.credential, endpoint: 'ram.aliyuncs.com', protocol: 'https' });
  // This entire command requires a separate administrator identity. Never use the deployment role.
  try {
    const r = (await ram.getRole(new RAM.GetRoleRequest({ roleName: plan.authorizerRole }))).body.role;
    if (r.description !== marker || !isDeepStrictEqual(normalize(parse(r.assumeRolePolicyDocument)), normalize(plan.trust))) throw new Error('Existing authorizer role differs');
  } catch (error) {
    if (error.code !== 'EntityNotExist.Role') throw error;
    await ram.createRole(new RAM.CreateRoleRequest({ roleName: plan.authorizerRole, description: marker, assumeRolePolicyDocument: JSON.stringify(plan.trust) }));
  }
  const attached = (await ram.listPoliciesForRole(new RAM.ListPoliciesForRoleRequest({ roleName: plan.authorizerRole }))).body?.policies?.policy || [];
  if (attached.some(p => p.policyName !== plan.authorizerPolicyName || p.policyType !== 'Custom')) throw new Error('Authorizer role has unrelated policies');
  await ensurePolicy(ram, plan.authorizerPolicyName, plan.authorizerPolicy);
  await ram.attachPolicyToRole(new RAM.AttachPolicyToRoleRequest({ roleName: plan.authorizerRole, policyName: plan.authorizerPolicyName, policyType: 'Custom' }));
  const values = { functionName: profile.authorizerFunction, description: marker, runtime: 'nodejs20', handler: 'index.handler', code: { zipFile: archive.toString('base64') },
    cpu: 0.1, memorySize: 256, timeout: 60, instanceConcurrency: 1, diskSize: 512, internetAccess: true, role: `acs:ram::${profile.accountId}:role/${plan.authorizerRole}` };
  try {
    const current = (await clients.fc.getFunction(profile.authorizerFunction, new FC.GetFunctionRequest({}))).body;
    if (current.description !== marker || current.role !== values.role) throw new Error('Existing authorizer function is not managed by this platform');
    const { functionName, ...updates } = values;
    await clients.fc.updateFunction(functionName, new FC.UpdateFunctionRequest({ body: new FC.UpdateFunctionInput(updates) }));
  } catch (error) {
    if (error.code !== 'FunctionNotFound') throw error;
    await clients.fc.createFunction(new FC.CreateFunctionRequest({ body: new FC.CreateFunctionInput(values) }));
  }
  await clients.fc.putConcurrencyConfig(profile.authorizerFunction, new FC.PutConcurrencyConfigRequest({ body: new FC.PutConcurrencyInput({ reservedConcurrency: 1 }) }));
  await clients.fc.putScalingConfig(profile.authorizerFunction, new FC.PutScalingConfigRequest({ qualifier: 'LATEST', body: new FC.PutScalingConfigInput({ minInstances: 0, enableOnDemandScaling: true, horizontalScalingPolicies: [], scheduledPolicies: [] }) }));
  // Attach a dedicated additive policy: no rewrite of existing project permissions.
  await ensurePolicy(ram, plan.deploymentPolicyName, plan.deploymentPolicy);
  await ram.attachPolicyToRole(new RAM.AttachPolicyToRoleRequest({ roleName: profile.deployerRole, policyName: plan.deploymentPolicyName, policyType: 'Custom' }));
  console.log('Platform installed. Verify that the deployment identity cannot update the authorizer or pass its role before accepting projects.');
}
