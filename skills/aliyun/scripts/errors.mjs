export const fcOAuthCompatibilityMessage = '函数计算当前的 OAuth 请求存在阿里云兼容问题，暂不可用；其他服务仍可独立使用。';
export const fcOAuthCompatibilityHint = '无需追加 RAM 权限或重新授权；请查看连接页面的服务检查结果。';

export function isMissingSecurityToken(error) {
  return error?.code === 'AccessDenied' && error?.data?.Message === 'missing parameter SecurityToken';
}

// Never serialize an SDK error: it may contain Authorization, environment or PEM data.
export function errorInfo(error) {
  const safe = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(value) ? value : undefined;
  const code = safe(error.code) || safe(error.cause?.code) || 'Error';
  const requestId = safe(error.requestId || error.data?.RequestId || error.data?.requestId);
  const action = safe(error.data?.AccessDeniedDetail?.AuthAction);
  // Client Pi connection files select OAuth profiles; this upstream failure is not a RAM denial.
  if (process.env.PI_ALIYUN_CONNECTION_FILE && isMissingSecurityToken(error)) {
    return { code, ...(requestId ? { requestId } : {}), message: fcOAuthCompatibilityMessage, hint: fcOAuthCompatibilityHint };
  }
  const remote = Boolean(error.data || error.requestId || error.statusCode || error.status || error.params);
  const hint = /Forbidden|AccessDenied|NoPermission|AuthFailed/i.test(code)
    ? 'Check the account deployment policy for this operation; an already-approved application does not need another spending approval.'
    : /NotFound|NoSuch|NotExist/i.test(code) ? 'Resource is absent; inspect any partial deployment before retrying.'
      : /ENOTFOUND|EAI_AGAIN|DomainNameNotResolved/i.test(code) ? 'Check DNS records and propagation from the deployment host.'
        : /CERT|TLS|SSL/.test(code) ? 'Check the domain certificate, expiry and renewal registration.'
          : 'Run diagnose for this application; use the requestId in Alibaba Cloud support or audit logs.';
  return { code, ...(requestId ? { requestId } : {}), ...(action ? { action } : {}), message: remote ? 'Cloud operation failed' : String(error.message || code).slice(0, 700), hint };
}

export async function operation(name, run) {
  try { return await run(); }
  catch (error) { throw Object.assign(new Error(`${name}: ${JSON.stringify(errorInfo(error))}`), { code: 'OperationFailed' }); }
}
