// An administrator applies this policy; deployment credentials never receive RAM administration permissions.
export function deploymentPolicy(config) {
  const account = config.accountId;
  const buckets = `pi-aliyun-*-${account}`;
  if (config.frontend && (!config.frontend.bucket.startsWith('pi-aliyun-') || !config.frontend.bucket.endsWith(`-${account}`))) {
    throw new Error(`This cross-project policy requires website bucket names matching ${buckets}`);
  }
  const allow = (Action, Resource) => ({ Effect: 'Allow', Action, Resource: [Resource] });
  return { Version: '1', Statement: [
    allow(['oss:GetBucketInfo', 'oss:GetBucketTagging', 'oss:PutBucket', 'oss:PutBucketTagging', 'oss:PutBucketAcl', 'oss:PutBucketPublicAccessBlock', 'oss:PutBucketWebsite', 'oss:CreateCnameToken', 'oss:PutCname'], `acs:oss:*:${account}:${buckets}`),
    allow(['oss:PutObject'], `acs:oss:*:${account}:${buckets}/*`),
    allow(['alidns:DescribeDomainRecords', 'alidns:AddDomainRecord', 'alidns:UpdateDomainRecord', 'alidns:DeleteDomainRecord'], `acs:alidns::${account}:domain/${config.dns.zone}`),
    // These FC operations include APIs that require account-level authorization.
    allow(['fc:GetFunction', 'fc:CreateFunction', 'fc:UpdateFunction', 'fc:PutConcurrencyConfig', 'fc:PutScalingConfig', 'fc:GetTrigger', 'fc:CreateTrigger', 'fc:UpdateTrigger', 'fc:GetCustomDomain', 'fc:CreateCustomDomain', 'fc:UpdateCustomDomain'], '*'),
    allow(['yundun-cert:DescribeSSLCertificatePrivateKey', 'yundun-cert:DescribeSSLCertificatePublicKeyDetail', 'yundun-cert:CreateSSLCertificate'], '*'),
  ] };
}
