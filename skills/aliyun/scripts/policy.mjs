import { accountZone } from './account.mjs';

// This is a trusted deployment-management identity: RAM resource-name prefixes
// restrict which policies it can manage, not the permissions those policies grant.
export function deploymentPolicy(profile) {
  const { accountId: account, region } = profile;
  const zone = accountZone(profile);
  const buckets = `pi-aliyun-*-${account}`;
  const instances = `acs:ots:${region}:${account}:instance/pi-app-*`;
  const roles = `acs:ram:*:${account}:role/pi-db-pi-aliyun-*`;
  const policies = `acs:ram:*:${account}:policy/PiDatabase-pi-aliyun-*`;
  const allow = (Action, ...Resource) => ({ Effect: 'Allow', Action, Resource });
  return { Version: '1', Statement: [
    allow(['oss:GetBucketInfo', 'oss:GetBucketTagging', 'oss:PutBucket', 'oss:PutBucketTagging', 'oss:PutBucketAcl', 'oss:PutBucketPublicAccessBlock', 'oss:PutBucketWebsite', 'oss:CreateCnameToken', 'oss:PutCname', 'oss:ListCname', 'oss:GetBucketVersioning', 'oss:ListObjects', 'oss:ListMultipartUploads', 'oss:DeleteBucket'], `acs:oss:*:${account}:${buckets}`),
    allow(['oss:PutObject', 'oss:DeleteObject', 'oss:AbortMultipartUpload'], `acs:oss:*:${account}:${buckets}/*`),
    allow(['alidns:DescribeDomainRecords', 'alidns:AddDomainRecord', 'alidns:UpdateDomainRecord', 'alidns:DeleteDomainRecord'], `acs:alidns::${account}:domain/${zone}`),
    // Some FC deployment APIs require account-level authorization.
    allow(['fc:GetFunction', 'fc:CreateFunction', 'fc:UpdateFunction', 'fc:PutConcurrencyConfig', 'fc:PutScalingConfig', 'fc:GetTrigger', 'fc:CreateTrigger', 'fc:UpdateTrigger', 'fc:GetCustomDomain', 'fc:CreateCustomDomain', 'fc:UpdateCustomDomain'], '*'),
    allow(['fc:DeleteFunction', 'fc:ListTriggers', 'fc:DeleteTrigger', 'fc:ListCustomDomains', 'fc:DeleteConcurrencyConfig', 'fc:DeleteScalingConfig'], '*'),
    allow(['fc:DeleteCustomDomain'], `acs:fc:${region}:${account}:custom-domains/*.${zone}`),
    allow(['yundun-cert:DescribeSSLCertificatePrivateKey', 'yundun-cert:DescribeSSLCertificatePublicKeyDetail', 'yundun-cert:CreateSSLCertificate'], '*'),
    allow(['yundun-cert:ListUserCertificateOrder', 'yundun-cert:ListCloudResources', 'yundun-cert:DeleteUserCertificate'], '*'),
    allow(['ots:ListInstance'], `acs:ots:${region}:${account}:instance/*`),
    allow(['ots:GetInstance', 'ots:InsertInstance', 'ots:DeleteInstance', 'ots:ListTable'], instances),
    allow(['ots:CreateTable', 'ots:DescribeTable', 'ots:DeleteTable'], `${instances}/table/pi_pi_aliyun_*`),
    allow(['ram:ListPolicies'], '*'),
    allow(['ram:GetRole', 'ram:ListPoliciesForRole', 'ram:CreateRole', 'ram:DeleteRole'], roles),
    allow(['ram:GetPolicy', 'ram:GetPolicyVersion', 'ram:CreatePolicy', 'ram:ListEntitiesForPolicy', 'ram:ListPolicyVersions', 'ram:CreatePolicyVersion', 'ram:DeletePolicyVersion', 'ram:DeletePolicy'], policies),
    allow(['ram:AttachPolicyToRole', 'ram:DetachPolicyFromRole'], roles, policies),
    { ...allow(['ram:PassRole'], roles), Condition: { StringEquals: { 'acs:Service': 'fc.aliyuncs.com' } } },
  ] };
}
