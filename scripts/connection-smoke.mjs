import assert from 'node:assert/strict';
import { inspectServiceAccess } from '../skills/aliyun/scripts/connection-checks.mjs';
import { errorInfo } from '../skills/aliyun/scripts/errors.mjs';

const failed = (code, extra = {}) => async () => { throw Object.assign(new Error('secret-response-must-not-leak'), { code, ...extra }); };
const checks = [
  { service: 'oss', action: 'oss:ListBuckets', run: async () => ({ privateResource: 'must-not-leak' }) },
  { service: 'fc', action: 'fc:ListFunctions', run: failed('NoPermission', { data: { RequestId: 'request-123', Authorization: 'secret-header' } }) },
  { service: 'ots', action: 'ots:ListInstance', run: failed('ServiceNotActivated') },
  { service: 'cas', action: 'yundun-cert:ListUserCertificateOrder', run: failed('ETIMEDOUT') },
  { service: 'ram', action: 'ram:ListPolicies', run: failed('Forbidden', { data: { AccessDeniedDetail: { NoPermissionType: 'ExplicitDeny' } } }) },
  { service: 'alidns', action: 'alidns:DescribeDomains', run: failed('Forbidden') },
];
const report = await inspectServiceAccess({ identityType: 'RAMUser' }, checks);
assert.equal(report.permissions.status, 'unverified');
assert(Number.isFinite(Date.parse(report.permissions.checkedAt)));
assert.deepEqual(report.serviceChecks.map(({ status }) => status), ['ok', 'denied', 'unavailable', 'unavailable', 'denied', 'unavailable']);
assert.equal(report.serviceChecks[1].requestId, 'request-123');
assert.match(report.serviceChecks[2].message, /尚未开通/);
assert(!JSON.stringify(report).includes('secret'));
assert(!JSON.stringify(report).includes('must-not-leak'));
assert.equal((await inspectServiceAccess({ identityType: 'AssumedRoleUser' }, checks.slice(0, 1))).permissions.status, 'unverified');
assert.equal((await inspectServiceAccess({ identityType: 'Account' }, checks)).permissions.status, 'account-owner');
const unsafe = await inspectServiceAccess({}, [{ service: 'ram', action: 'ram:ListPolicies', run: failed('secret\nheader', { requestId: 'secret\nrequest' }) }]);
assert.equal(unsafe.serviceChecks[0].code, 'Error');
assert.equal(unsafe.serviceChecks[0].requestId, undefined);
const diagnostic = errorInfo({ code: 'NoPermission', data: { AccessDeniedDetail: { AuthAction: 'ram:CreateRole', Authorization: 'secret' } } });
assert.equal(diagnostic.action, 'ram:CreateRole');
assert(!JSON.stringify(diagnostic).includes('secret'));
console.log('Connection smoke passed: independent read checks, permission/activation/network distinction, honest RAM status and safe diagnostics. No cloud APIs called.');
