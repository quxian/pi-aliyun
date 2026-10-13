import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import CredentialModule from '@alicloud/credentials';
import STSModule from '@alicloud/sts20150401';
import DNSModule, * as DNS from '@alicloud/alidns20150109';
import FCModule, * as FC from '@alicloud/fc20230330';
import CASModule, * as CAS from '@alicloud/cas20200407';
import OTSModule, * as OTS from '@alicloud/tablestore20201209';
import RAMModule, * as RAM from '@alicloud/ram20150501';
import OSS from 'ali-oss';
import { inspectServiceAccess } from './connection-checks.mjs';

const Client = module => module.default || module;
const Credential = Client(CredentialModule);

async function withProfileLock(profile, run) {
  const directory = join(homedir(), '.aliyun');
  const lock = join(directory, `.client-pi-${createHash('sha256').update(profile).digest('hex').slice(0, 16)}.lock`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 120000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(await readFile(join(lock, 'pid'), 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (processError) { if (processError.code === 'ESRCH') { await rm(lock, { recursive: true, force: true }); continue; } }
        }
      } catch (readError) {
        // A process can exit between mkdir and recording its PID.
        if (readError.code === 'ENOENT' && Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 10000) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      }
      if (Date.now() > deadline) throw new Error('Another Alibaba Cloud credential refresh did not finish; retry shortly');
      await delay(100);
    }
  }
  try { return await run(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export async function createCredential(selection) {
  if (!selection && process.env.PI_ALIYUN_CONNECTION_FILE) {
    try { selection = JSON.parse(await readFile(process.env.PI_ALIYUN_CONNECTION_FILE, 'utf8')); }
    catch { throw new Error('Cannot read the Client Pi Alibaba Cloud connection; reconnect in Client Pi settings'); }
  }
  if (!selection) return new Credential();
  let provider;
  switch (selection.mode) {
    case 'cliProfile': {
      if (typeof selection.profile !== 'string' || !selection.profile) throw new Error('Alibaba Cloud CLI profile is required');
      // OAuth refresh tokens rotate. Re-read the official profile under a host lock
      // so concurrent Agent processes never refresh the same old token together.
      provider = {
        getProviderName: () => 'cli_profile',
        getCredentials: () => withProfileLock(selection.profile, async () => {
          const config = JSON.parse(await readFile(join(homedir(), '.aliyun/config.json'), 'utf8'));
          const profile = config.profiles?.find(item => item.name === selection.profile);
          if (profile?.mode !== 'OAuth') throw new Error('The Client Pi Alibaba Cloud OAuth profile is missing; reconnect in Client Pi settings');
          if (profile.sts_expiration > Date.now() / 1000 + 60 && profile.access_key_id && profile.access_key_secret && profile.sts_token) {
            return CredentialModule.StaticSTSCredentialsProvider.builder().withAccessKeyId(profile.access_key_id).withAccessKeySecret(profile.access_key_secret).withSecurityToken(profile.sts_token).build().getCredentials();
          }
          return CredentialModule.CLIProfileCredentialsProvider.builder().withProfileName(selection.profile).build().getCredentials();
        }),
      };
      break;
    }
    default: throw new Error('Unsupported Client Pi Alibaba Cloud credential source');
  }
  return new Credential(null, provider);
}

export async function inspectConnection({ selection, region = 'cn-hangzhou' } = {}) {
  if (typeof region !== 'string' || !/^[a-z]{2}-[a-z0-9-]+$/.test(region)) throw new Error('Choose a valid Alibaba Cloud region for the connection checks');
  const credential = await createCredential(selection);
  let identity;
  try {
    await credential.getCredential();
    const sts = new (Client(STSModule))({ credential, endpoint: 'sts.cn-hangzhou.aliyuncs.com', protocol: 'https', connectTimeout: 10000, readTimeout: 15000 });
    identity = (await sts.getCallerIdentity()).body;
  } catch {
    // Credential resolution errors may include file contents or upstream HTTP headers.
    throw new Error('Could not verify Alibaba Cloud credentials; reconnect or check the host credential configuration and network');
  }
  if (!/^\d{6,20}$/.test(identity?.accountId || '')) throw new Error('Alibaba Cloud returned an invalid account identity');
  const domains = [];
  const options = { credential, protocol: 'https', connectTimeout: 10000, readTimeout: 15000 };
  const dns = new (Client(DNSModule))({ ...options, endpoint: 'alidns.cn-hangzhou.aliyuncs.com' });
  const fc = new (Client(FCModule))({ ...options, regionId: region, endpoint: `fcv3.${region}.aliyuncs.com` });
  const ots = new (Client(OTSModule))({ ...options, regionId: region, endpoint: `tablestore.${region}.aliyuncs.com` });
  const cas = new (Client(CASModule))({ ...options, endpoint: 'cas.aliyuncs.com' });
  const ram = new (Client(RAMModule))({ ...options, endpoint: 'ram.aliyuncs.com' });
  const checks = await inspectServiceAccess(identity, [
    { service: 'alidns', action: 'alidns:DescribeDomains', run: async () => {
      for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
        const response = (await dns.describeDomains(new DNS.DescribeDomainsRequest({ pageNumber, pageSize: 100 }))).body;
        domains.push(...(response?.domains?.domain || []).map(domain => domain.domainName).filter(value => typeof value === 'string'));
        if (pageNumber * 100 >= (response?.totalCount || 0)) break;
      }
    } },
    { service: 'oss', action: 'oss:ListBuckets', run: async () => {
      const key = await credential.getCredential();
      const oss = new OSS({ accessKeyId: key.accessKeyId, accessKeySecret: key.accessKeySecret, stsToken: key.securityToken,
        region: `oss-${region}`, secure: true, authorizationV4: true, timeout: 15000 });
      await oss.listBuckets({ 'max-keys': 1 });
    } },
    { service: 'fc', action: 'fc:ListFunctions', run: () => fc.listFunctions(new FC.ListFunctionsRequest({ limit: 1 })) },
    { service: 'ots', action: 'ots:ListInstance', run: () => ots.listInstances(new OTS.ListInstancesRequest({ maxResults: 1 })) },
    { service: 'cas', action: 'yundun-cert:ListUserCertificateOrder', run: () => cas.listUserCertificateOrder(new CAS.ListUserCertificateOrderRequest({ currentPage: 1, showSize: 1 })) },
    { service: 'ram', action: 'ram:ListPolicies', run: () => ram.listPolicies(new RAM.ListPoliciesRequest({ policyType: 'Custom', maxItems: 1 })) },
  ]);
  return { accountId: identity.accountId, identity: identity.arn || identity.userId || identity.accountId,
    identityType: identity.identityType, principalId: identity.principalId,
    domains: [...new Set(domains)].sort(), domainsUnavailable: checks.serviceChecks.find(check => check.service === 'alidns').status !== 'ok',
    ...checks, ...(selection ? { source: selection } : {}) };
}
