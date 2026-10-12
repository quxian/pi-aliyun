import * as RAM from '@alicloud/ram20150501';
import { isDeepStrictEqual } from 'node:util';
import { databaseAccess } from './database-plan.mjs';

function document(value) {
  if (typeof value !== 'string') throw new Error('RAM returned a missing policy document');
  try { return JSON.parse(value); } catch { return JSON.parse(decodeURIComponent(value)); }
}
function normalizedPolicy(policy) {
  const list = (value) => Array.isArray(value) ? value : [value];
  const statements = list(policy.Statement).map((source) => {
    const statement = { ...source };
    // The RAM console collapses one-element lists; their authorization meaning is unchanged.
    for (const key of ['Action', 'NotAction', 'Resource', 'NotResource']) {
      if (Object.hasOwn(statement, key)) statement[key] = list(statement[key]).sort();
    }
    for (const key of ['Principal', 'NotPrincipal']) {
      if (statement[key] && typeof statement[key] === 'object') {
        statement[key] = Object.fromEntries(Object.entries(statement[key]).map(([type, value]) => [type, list(value).sort()]));
      }
    }
    return statement;
  });
  return { ...policy, Statement: statements };
}
function policyEqual(actual, expected) { return isDeepStrictEqual(normalizedPolicy(document(actual)), normalizedPolicy(expected)); }
export async function verifyDatabaseRole(ram, config) {
  const access = databaseAccess(config);
  const role = (await ram.getRole(new RAM.GetRoleRequest({ roleName: access.roleName }))).body?.role;
  if (!policyEqual(role?.assumeRolePolicyDocument, access.trustPolicy)) throw new Error('Database runtime role trust differs from db-plan; administrator review is required');
  const attached = (await ram.listPoliciesForRole(new RAM.ListPoliciesForRoleRequest({ roleName: access.roleName }))).body?.policies?.policy;
  if (!attached || attached.length !== 1 || attached[0].policyName !== access.policyName || attached[0].policyType !== 'Custom') throw new Error('Database runtime role must have only its project policy from db-plan');
  const policy = (await ram.getPolicy(new RAM.GetPolicyRequest({ policyType: 'Custom', policyName: access.policyName }))).body?.policy;
  const version = (await ram.getPolicyVersion(new RAM.GetPolicyVersionRequest({ policyType: 'Custom', policyName: access.policyName, versionId: policy?.defaultVersion }))).body?.policyVersion;
  if (!policyEqual(version?.policyDocument, access.runtimePolicy)) throw new Error('Database runtime policy differs from the approved project scope');
}

// This command uses a separately authorized administrator identity. It is never called by deploy.
export async function bootstrapDatabaseRole(ram, config) {
  const a = databaseAccess(config);
  const description = `Managed by pi-aliyun: ${config.project}`;
  try {
    const role = (await ram.getRole(new RAM.GetRoleRequest({ roleName: a.roleName }))).body?.role;
    if (role?.description !== description || !policyEqual(role?.assumeRolePolicyDocument, a.trustPolicy)) throw new Error('Existing role is not the expected pi-aliyun project role');
    const existing = (await ram.listPoliciesForRole(new RAM.ListPoliciesForRoleRequest({ roleName: a.roleName }))).body?.policies?.policy || [];
    if (existing.some((policy) => policy.policyName !== a.policyName || policy.policyType !== 'Custom')) throw new Error('Existing role has additional policies; administrator review is required before modifying it');
  } catch (error) {
    if (error.code !== 'EntityNotExist.Role') throw error;
    await ram.createRole(new RAM.CreateRoleRequest({ roleName: a.roleName, description, assumeRolePolicyDocument: JSON.stringify(a.trustPolicy) }));
  }
  try {
    const policy = (await ram.getPolicy(new RAM.GetPolicyRequest({ policyType: 'Custom', policyName: a.policyName }))).body?.policy;
    const version = (await ram.getPolicyVersion(new RAM.GetPolicyVersionRequest({ policyType: 'Custom', policyName: a.policyName, versionId: policy?.defaultVersion }))).body?.policyVersion;
    if (!policyEqual(version?.policyDocument, a.runtimePolicy)) throw new Error('Existing policy differs; refusing to replace permissions');
  } catch (error) {
    if (error.code !== 'EntityNotExist.Policy') throw error;
    await ram.createPolicy(new RAM.CreatePolicyRequest({ policyName: a.policyName, description, policyDocument: JSON.stringify(a.runtimePolicy) }));
  }
  await ram.attachPolicyToRole(new RAM.AttachPolicyToRoleRequest({ roleName: a.roleName, policyType: 'Custom', policyName: a.policyName }));
  await verifyDatabaseRole(ram, config);
  console.log(`Database runtime role ready: ${a.roleName}`);
}

