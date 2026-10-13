// These checks report only the named read operation. They never simulate deployment.
export async function inspectServiceAccess(identity, checks) {
  const checkedAt = new Date().toISOString();
  const serviceChecks = await Promise.all(checks.map(async ({ service, action, run, message }) => {
    try {
      await run();
      return { service, action, status: 'ok', message: message || '读取检查通过；尚未执行部署写操作。' };
    } catch (error) {
      // SDK errors can contain credentials, request headers and arbitrary remote text.
      const safe = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(value) ? value : undefined;
      const code = safe(error?.code) || safe(error?.cause?.code) || 'Error';
      const requestId = safe(error?.requestId || error?.data?.RequestId || error?.data?.requestId);
      const detail = error?.data?.AccessDeniedDetail;
      const denied = /NoPermission|AccessDenied|PermissionDenied|UnauthorizedOperation|Forbidden\.RAM/i.test(code)
        || ['ExplicitDeny', 'ImplicitDeny'].includes(detail?.NoPermissionType);
      const notEnabled = /ServiceNot(?:Enabled|Activated|Open|Subscribed)|Not(?:Activated|Subscribed)|Service\.NotOpen/i.test(code);
      const message = notEnabled ? '阿里云提示该服务尚未开通，使用此服务前需要完成开通。'
        : /Arrears|Overdue|Debt|Account.*(?:Suspend|Frozen)/i.test(code) ? '阿里云提示账号欠费或服务被冻结，请处理账号状态。'
          : denied ? '当前身份不能执行这项读取检查；这不代表所有部署操作均无权限。'
            : '暂时无法完成读取检查，请重试；可凭错误码和请求编号定位问题。';
      return { service, action, status: denied && !notEnabled ? 'denied' : 'unavailable', code, ...(requestId ? { requestId } : {}), message };
    }
  }));
  return {
    permissions: { status: identity.identityType === 'Account' ? 'account-owner' : 'unverified', checkedAt },
    serviceChecks,
  };
}
