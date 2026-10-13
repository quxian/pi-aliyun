import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import CredentialModule from '@alicloud/credentials';
import STSModule from '@alicloud/sts20150401';
import DNSModule, * as DNS from '@alicloud/alidns20150109';

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

export async function inspectConnection({ selection } = {}) {
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
  let domainsUnavailable = false;
  try {
    const dns = new (Client(DNSModule))({ credential, endpoint: 'alidns.cn-hangzhou.aliyuncs.com', protocol: 'https', connectTimeout: 10000, readTimeout: 15000 });
    for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
      const response = (await dns.describeDomains(new DNS.DescribeDomainsRequest({ pageNumber, pageSize: 100 }))).body;
      domains.push(...(response?.domains?.domain || []).map(domain => domain.domainName).filter(value => typeof value === 'string'));
      if (pageNumber * 100 >= (response?.totalCount || 0)) break;
    }
  } catch { domainsUnavailable = true; }
  return { accountId: identity.accountId, identity: identity.arn || identity.userId || identity.accountId, domains: [...new Set(domains)].sort(), domainsUnavailable, ...(selection ? { source: selection } : {}) };
}
