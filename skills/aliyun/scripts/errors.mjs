// Never serialize an SDK error: it may contain Authorization, environment or PEM data.
export function errorInfo(error) {
  const safe = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(value) ? value : undefined;
  const code = safe(error.code) || safe(error.cause?.code) || 'Error';
  const requestId = safe(error.requestId || error.data?.RequestId || error.data?.requestId);
  const remote = Boolean(error.data || error.requestId || error.statusCode || error.status || error.params);
  const hint = /Forbidden|AccessDenied|NoPermission|AuthFailed/i.test(code)
    ? 'Check the account deployment policy for this operation; an already-approved application does not need another spending approval.'
    : /NotFound|NoSuch|NotExist/i.test(code) ? 'Resource is absent; inspect any partial deployment before retrying.'
      : /ENOTFOUND|EAI_AGAIN|DomainNameNotResolved/i.test(code) ? 'Check DNS records and propagation from the deployment host.'
        : /CERT|TLS|SSL/.test(code) ? 'Check the domain certificate, expiry and renewal registration.'
          : 'Run diagnose for this application; use the requestId in Alibaba Cloud support or audit logs.';
  return { code, ...(requestId ? { requestId } : {}), message: remote ? 'Cloud operation failed' : String(error.message || code).slice(0, 700), hint };
}

export async function operation(name, run) {
  try { return await run(); }
  catch (error) { throw Object.assign(new Error(`${name}: ${JSON.stringify(errorInfo(error))}`), { code: 'OperationFailed' }); }
}
