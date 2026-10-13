import assert from 'node:assert/strict';
import { inspectServiceAccess } from '../skills/aliyun/scripts/connection-checks.mjs';
import { errorInfo, fcOAuthCompatibilityMessage, fcOAuthCompatibilityHint, operation } from '../skills/aliyun/scripts/errors.mjs';

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

const tokenError = { code: 'AccessDenied', data: { Message: 'missing parameter SecurityToken', RequestId: 'fc-request-123', Authorization: 'secret-header' } };
const compatibility = await inspectServiceAccess({ identityType: 'Account' }, [
  { service: 'fc', action: 'fc:ListFunctions', run: failed(tokenError.code, tokenError) },
  { service: 'oss', action: 'oss:ListBuckets', run: async () => {} },
  { service: 'ram', action: 'ram:ListPolicies', run: failed(tokenError.code, tokenError) },
  { service: 'fc', action: 'fc:ListFunctions', run: failed('AccessDenied', { data: { Message: 'missing parameter SecurityToken secret' } }) },
]);
assert.deepEqual(compatibility.serviceChecks.map(({ status }) => status), ['unavailable', 'ok', 'denied', 'denied']);
assert.equal(compatibility.serviceChecks[0].message, fcOAuthCompatibilityMessage + fcOAuthCompatibilityHint);
assert.equal(compatibility.serviceChecks[0].requestId, 'fc-request-123');
assert.equal(compatibility.permissions.status, 'account-owner');
assert(!JSON.stringify(compatibility).includes('secret'));
assert(!JSON.stringify(compatibility).includes('missing parameter SecurityToken'));

const connectionFile = process.env.PI_ALIYUN_CONNECTION_FILE;
try {
  delete process.env.PI_ALIYUN_CONNECTION_FILE;
  assert.doesNotMatch(errorInfo(tokenError).message, /OAuth/);
  process.env.PI_ALIYUN_CONNECTION_FILE = '/unused-smoke-oauth-connection.json';
  const failure = errorInfo(tokenError);
  assert.equal(failure.message, fcOAuthCompatibilityMessage);
  assert.equal(failure.hint, fcOAuthCompatibilityHint);
  assert.equal(failure.requestId, 'fc-request-123');
  assert(!JSON.stringify(failure).includes('secret'));
  await assert.rejects(() => operation('Deploy FC smoke', failed(tokenError.code, tokenError)), error => {
    const output = errorInfo(error);
    assert.match(output.message, /OAuth/);
    assert.match(output.message, /无需追加 RAM 权限或重新授权/);
    assert(!JSON.stringify(output).includes('secret'));
    return true;
  });
} finally {
  if (connectionFile === undefined) delete process.env.PI_ALIYUN_CONNECTION_FILE;
  else process.env.PI_ALIYUN_CONNECTION_FILE = connectionFile;
}
console.log('Connection smoke passed: independent read checks, honest permissions, FC OAuth compatibility diagnostics and safe deployment errors. No cloud APIs called.');
