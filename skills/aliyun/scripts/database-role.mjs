import * as RAM from '@alicloud/ram20150501';
import { isDeepStrictEqual } from 'node:util';
import { databaseAccess } from './database-plan.mjs';

function document(value) {
  if (typeof value !== 'string') throw new Error('RAM returned a missing policy document');
  try { return JSON.parse(value); } catch { return JSON.parse(decodeURIComponent(value)); }
}
function normalizedPolicy(policy) {
  const list = (value) => Array.isArray(value) ? [...value] : [value];
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
const descriptionFor = (config) => `Managed by pi-aliyun: ${config.project}`;
export async function verifyDatabaseRole(ram, config) {
  const access = databaseAccess(config);
  const role = (await ram.getRole(new RAM.GetRoleRequest({ roleName: access.roleName }))).body?.role;
  if (role?.description !== descriptionFor(config)) throw new Error('Database runtime role is not owned by this pi-aliyun application');
  if (!policyEqual(role?.assumeRolePolicyDocument, access.trustPolicy)) throw new Error('Database runtime role trust differs from db-plan; administrator review is required');
  const attached = (await ram.listPoliciesForRole(new RAM.ListPoliciesForRoleRequest({ roleName: access.roleName }))).body?.policies?.policy;
  if (!attached || attached.length !== 1 || attached[0].policyName !== access.policyName || attached[0].policyType !== 'Custom') throw new Error('Database runtime role must have only its project policy from db-plan');
  const policy = (await ram.getPolicy(new RAM.GetPolicyRequest({ policyType: 'Custom', policyName: access.policyName }))).body?.policy;
  if (policy?.description !== descriptionFor(config)) throw new Error('Database runtime policy is not owned by this pi-aliyun application');
  const version = (await ram.getPolicyVersion(new RAM.GetPolicyVersionRequest({ policyType: 'Custom', policyName: access.policyName, versionId: policy?.defaultVersion }))).body?.policyVersion;
  if (!policyEqual(version?.policyDocument, access.runtimePolicy)) throw new Error('Database runtime policy differs from the approved project scope');
}

// The deployment identity or platform authorizer needs the corresponding scoped RAM permissions.
export async function bootstrapDatabaseRole(ram, config) {
  const a = databaseAccess(config);
  const description = descriptionFor(config);
  let role; let policy; let policyVersion; let attached = [];
  try { role = (await ram.getRole(new RAM.GetRoleRequest({ roleName: a.roleName }))).body?.role; }
  catch (error) { if (error.code !== 'EntityNotExist.Role') throw error; }
  if (role) {
    if (role.description !== description || !policyEqual(role.assumeRolePolicyDocument, a.trustPolicy)) throw new Error('Existing role is not the expected pi-aliyun application role');
    attached = (await ram.listPoliciesForRole(new RAM.ListPoliciesForRoleRequest({ roleName: a.roleName }))).body?.policies?.policy || [];
    if (attached.some((item) => item.policyName !== a.policyName || item.policyType !== 'Custom')) throw new Error('Existing role has additional policies; refusing to modify it');
  }
  try { policy = (await ram.getPolicy(new RAM.GetPolicyRequest({ policyType: 'Custom', policyName: a.policyName }))).body?.policy; }
  catch (error) { if (error.code !== 'EntityNotExist.Policy') throw error; }
  if (policy) {
    if (policy.description !== description) throw new Error('Existing policy is not owned by this pi-aliyun application');
    const entities = (await ram.listEntitiesForPolicy(new RAM.ListEntitiesForPolicyRequest({ policyType: 'Custom', policyName: a.policyName }))).body;
    if (!entities || entities.users?.user?.length || entities.groups?.group?.length || entities.roles?.role?.some((item) => item.roleName !== a.roleName)) {
      throw new Error('Existing policy has additional bindings; refusing to modify it');
    }
    policyVersion = (await ram.getPolicyVersion(new RAM.GetPolicyVersionRequest({ policyType: 'Custom', policyName: a.policyName, versionId: policy.defaultVersion }))).body?.policyVersion;
  }
  // Check both resource owners before creating or changing either resource.
  if (!role) await ram.createRole(new RAM.CreateRoleRequest({ roleName: a.roleName, description, assumeRolePolicyDocument: JSON.stringify(a.trustPolicy) }));
  if (!policy) {
    await ram.createPolicy(new RAM.CreatePolicyRequest({ policyName: a.policyName, description, policyDocument: JSON.stringify(a.runtimePolicy) }));
  } else if (!policyEqual(policyVersion?.policyDocument, a.runtimePolicy)) {
    const versions = (await ram.listPolicyVersions(new RAM.ListPolicyVersionsRequest({ policyType: 'Custom', policyName: a.policyName }))).body?.policyVersions?.policyVersion;
    if (!Array.isArray(versions) || !versions.length) throw new Error('RAM returned no policy versions; refusing to rotate an unknown policy');
    // RAM keeps at most five versions. Retain the active version for rollback and remove only old, explicitly nondefault versions.
    const removable = versions.filter((item) => item.isDefaultVersion === false && item.versionId !== policy.defaultVersion)
      .sort((left, right) => (left.createDate || '').localeCompare(right.createDate || '') || Number(left.versionId?.slice(1)) - Number(right.versionId?.slice(1)));
    const toDelete = Math.max(0, versions.length - 4);
    if (removable.length < toDelete) throw new Error('No safe nondefault policy version is available to rotate');
    for (const version of removable.slice(0, toDelete)) {
      await ram.deletePolicyVersion(new RAM.DeletePolicyVersionRequest({ policyName: a.policyName, versionId: version.versionId }));
    }
    await ram.createPolicyVersion(new RAM.CreatePolicyVersionRequest({ policyName: a.policyName, policyDocument: JSON.stringify(a.runtimePolicy), setAsDefault: true }));
  }
  if (!attached.length) await ram.attachPolicyToRole(new RAM.AttachPolicyToRoleRequest({ roleName: a.roleName, policyType: 'Custom', policyName: a.policyName }));
  await verifyDatabaseRole(ram, config);
  console.log(`Database runtime role ready: ${a.roleName}`);
}
