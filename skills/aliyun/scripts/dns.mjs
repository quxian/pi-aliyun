import * as DNS from '@alicloud/alidns20150109';

export async function domainRecords(dns, config, RR) {
  const records = [];
  for (let pageNumber = 1; ; pageNumber++) {
    const response = await dns.describeDomainRecords(new DNS.DescribeDomainRecordsRequest({ domainName: config.dns.zone, RRKeyWord: RR, searchMode: 'EXACT', pageNumber, pageSize: 500 }));
    const batch = response.body?.domainRecords?.record || [];
    records.push(...batch.filter((item) => item.RR === RR));
    if (pageNumber * 500 >= (response.body?.totalCount || 0)) break;
  }
  return records;
}


export const dnsTargets = config => [
  config.frontend && { logicalId: 'FrontendDns', domain: config.frontend.domain, value: `${config.frontend.bucket}.oss-${config.region}.aliyuncs.com` },
  config.backend && { logicalId: 'BackendDns', domain: config.backend.domain, value: `${config.accountId}.${config.region}.fc.aliyuncs.com` },
].filter(Boolean);

export function dnsResources(config) {
  return Object.fromEntries(dnsTargets(config).map(target => [target.logicalId, {
    Type: 'ALIYUN::DNS::DomainRecord', Properties: {
      DomainName: config.dns.zone, RR: target.domain.slice(0, -(config.dns.zone.length + 1)),
      Type: 'CNAME', Value: target.value, TTL: config.dns.ttl, Line: 'default',
    },
  }]));
}

export async function inspectDnsRecord(dns, config, target, resource) {
  const records = await domainRecords(dns, config, target.domain.slice(0, -(config.dns.zone.length + 1)));
  const ownedId = resource?.status !== 'DELETE_COMPLETE' ? resource?.physicalResourceId : undefined;
  // FC domains share a CNAME target: matching values alone cannot establish ownership.
  if (records.some(record => !ownedId || String(record.recordId) !== String(ownedId))) {
    throw new Error(`DNS ${target.domain} has records outside this application's ROS stack; no records were changed`);
  }
  if (records.some(record => record.type !== 'CNAME' || record.value.replace(/\.$/, '') !== target.value || record.line !== 'default')) {
    throw new Error(`DNS ${target.domain} differs from this application's ROS configuration`);
  }
  return { domain: target.domain, managedBy: 'ROS', exists: records.length > 0,
    ok: records.length === 1 && records[0].status === 'ENABLE' && records[0].TTL === config.dns.ttl,
    ownedId, records: records.map(({ recordId, RR, type, value, status, TTL }) => ({ recordId, RR, type, value, status, TTL })) };
}
