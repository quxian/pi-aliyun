import { X509Certificate, createPrivateKey } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import acme from 'acme-client'
import { AddDomainRecordRequest, DeleteDomainRecordRequest } from '@alicloud/alidns20150109'
import { createClients } from './cloud.mjs'

export function validateCertificate(certificate, privateKey, domains, remainingDays = 0) {
  const leaf = new X509Certificate(certificate)
  if (!leaf.checkPrivateKey(createPrivateKey(privateKey))) throw new Error('TLS 证书与私钥不匹配。')
  for (const domain of domains) {
    if (!leaf.checkHost(domain)) throw new Error(`TLS 证书未覆盖域名 ${domain}。`)
  }
  if (Date.parse(leaf.validFrom) > Date.now()) throw new Error('TLS 证书尚未生效。')
  return Date.parse(leaf.validTo) > Date.now() + remainingDays * 86_400_000
}

export function uploadPrivateKey(privateKey) {
  const key = createPrivateKey(privateKey)
  // FC rejects PKCS#8 RSA keys produced by acme.crypto; preserve the key and change only its encoding.
  return key.asymmetricKeyType === 'rsa'
    ? key.export({ type: 'pkcs1', format: 'pem' }).toString()
    : privateKey.toString()
}

async function readOptional(path) {
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function writePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function issueCertificate(config, domains, existingKey) {
  const settings = config.tls.acme
  if (settings.agreeToTerms !== true) throw new Error('使用 ACME 前需阅读证书服务条款，并在 tls.acme.agreeToTerms 中确认。')
  if (!settings.accountKeyFile) throw new Error('ACME 需要 accountKeyFile。')
  const zone = config.dns?.zone
  if (!zone || domains.some((domain) => domain !== zone && !domain.endsWith(`.${zone}`))) {
    throw new Error('ACME 域名必须属于 dns.zone 配置的阿里云 DNS 区域。')
  }
  let accountKey = await readOptional(settings.accountKeyFile)
  if (!accountKey) {
    accountKey = await acme.crypto.createPrivateKey()
    await writePrivate(settings.accountKeyFile, accountKey)
  }
  const client = new acme.Client({
    directoryUrl: settings.directoryUrl ?? acme.directory.letsencrypt.production,
    accountKey,
  })
  // Some deployment hosts need a proxy for external CAs; keep Alibaba SDK traffic separate.
  const proxy = settings.proxyUrl ? new URL(settings.proxyUrl) : undefined
  acme.axios.defaults.proxy = proxy ? { protocol: proxy.protocol.slice(0, -1), host: proxy.hostname, port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)) } : undefined
  acme.axios.defaults.timeout = 30_000
  // Reuse the certificate key so an interrupted certificate replacement cannot leave a mismatched pair.
  const [privateKey, csr] = await acme.crypto.createCsr({ commonName: domains[0], altNames: domains }, existingKey)
  if (!existingKey) await writePrivate(config.tls.keyFile, privateKey)
  const { dns } = await createClients(config, { services: ['dns'] })
  const created = new Map()
  const removeRecord = async (challengeUrl) => {
    const recordId = created.get(challengeUrl)
    if (!recordId) return
    await dns.deleteDomainRecord(new DeleteDomainRecordRequest({ recordId }))
    created.delete(challengeUrl)
  }
  try {
    console.log(`Requesting ACME certificate for: ${domains.join(', ')}`)
    const certificate = await client.auto({
      csr,
      email: settings.email,
      termsOfServiceAgreed: true,
      challengePriority: ['dns-01'],
      challengeCreateFn: async (authorization, challenge, keyAuthorization) => {
        if (challenge.type !== 'dns-01') throw new Error('仅支持 ACME DNS-01 验证。')
        const name = `_acme-challenge.${authorization.identifier.value.replace(/^\*\./, '')}`
        if (!name.endsWith(`.${zone}`)) throw new Error('ACME 验证记录不属于配置的 DNS 区域。')
        const rr = name.slice(0, -(zone.length + 1))
        const response = await dns.addDomainRecord(new AddDomainRecordRequest({
          domainName: zone, RR: rr, type: 'TXT', value: keyAuthorization, TTL: 600,
        }))
        const recordId = response.body?.recordId
        if (!recordId) throw new Error('阿里云 DNS 未返回验证记录 ID。')
        created.set(challenge.url, recordId)
        // acme-client verifies DNS propagation with retries and authoritative DNS fallback.
      },
      challengeRemoveFn: async (_authorization, challenge) => removeRecord(challenge.url),
    })
    if (!validateCertificate(certificate, privateKey, domains)) throw new Error('ACME 返回了过期证书。')
    await writePrivate(config.tls.certFile, certificate)
    console.log(`ACME certificate saved; expires ${new X509Certificate(certificate).validTo}`)
    return { certificate, privateKey: uploadPrivateKey(privateKey) }
  } finally {
    // Delete only record IDs created by this invocation; unrelated TXT records must survive.
    for (const [url, recordId] of created) {
      try { await removeRecord(url) } catch {
        console.error(`ACME 验证记录清理失败，请检查 DNS 记录 ${recordId}（${zone}）。`)
      }
    }
  }
}

export async function prepareTls(config) {
  if (!config.tls) return undefined
  const domains = [...new Set([config.frontend?.domain, config.backend?.domain].filter(Boolean))]
  if (!domains.length) throw new Error('TLS 配置需要至少一个前端或后端域名。')
  const { certFile, keyFile, acme: settings } = config.tls
  if (!certFile || !keyFile || certFile === keyFile) throw new Error('TLS 需要不同的 certFile 与 keyFile。')
  if (settings && [certFile, keyFile].includes(settings.accountKeyFile)) throw new Error('ACME 账号密钥文件需与证书及证书私钥分开。')
  const certificate = await readOptional(certFile)
  const privateKey = await readOptional(keyFile)
  const days = settings?.renewBeforeDays ?? 30
  if (!Number.isFinite(days) || days < 1 || days > 60) throw new Error('renewBeforeDays 应为 1–60 天。')
  if (certificate && privateKey) {
    const valid = validateCertificate(certificate, privateKey, settings ? [] : domains, settings ? days : 0)
    const coversDomains = domains.every((domain) => new X509Certificate(certificate).checkHost(domain))
    if (valid && coversDomains) return { certificate, privateKey: uploadPrivateKey(privateKey) }
    if (!settings) throw new Error('TLS 证书已过期，请替换证书文件或配置 ACME 续期。')
  } else if (!settings) {
    throw new Error('找不到 TLS 证书或私钥，请提供证书文件或配置 ACME。')
  }
  await mkdir(dirname(certFile), { recursive: true, mode: 0o700 })
  const lock = `${certFile}.lock`
  try { await mkdir(lock) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`证书签发正在执行，或上次中断留下锁：${lock}。确认无签发进程后再删除此锁目录。`)
    throw error
  }
  try { return await issueCertificate(config, domains, privateKey) } finally { await rm(lock, { recursive: true, force: true }) }
}
