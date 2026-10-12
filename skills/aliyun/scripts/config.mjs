import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { validateDatabase, databasePlan } from './database-plan.mjs';

const fail = (message) => { throw new Error(message); };
const string = (value, label) => typeof value === 'string' && value.length > 0 || fail(`${label} must be a nonempty string`);
const object = (value, label) => value && typeof value === 'object' && !Array.isArray(value) || fail(`${label} must be an object`);
function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown ${label} field: ${key}`);
}
function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} must be an integer between ${min} and ${max}`);
}
function domain(value, label) {
  string(value, label);
  if (value !== value.toLowerCase() || value.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(value)) fail(`${label} must be a lowercase DNS name without scheme, wildcard or path`);
}
function command(value, label) {
  if (!Array.isArray(value) || !value.length || value.some((part) => typeof part !== 'string' || !part.length)) fail(`${label} must be a nonempty argument array`);
}
function build(value, baseDir, label) {
  if (!value) return;
  keys(value, ['cwd', 'command'], label);
  command(value.command, `${label}.command`);
  value.cwd = resolve(baseDir, value.cwd || '.');
}
function stringMap(value, label) {
  object(value, label);
  for (const [key, val] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`${label} contains an invalid variable name`);
    string(val, `${label}.${key}`);
  }
}

export function validateConfig(raw, baseDir) {
  const config = structuredClone(raw);
  keys(config, ['version', 'project', 'region', 'accountId', 'frontend', 'backend', 'dns', 'tls', 'database'], 'config');
  if (config.version !== 1) fail('config.version must be 1');
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(config.project || '')) fail('project must be a lowercase name');
  if (!/^[a-z]{2}-[a-z0-9-]+$/.test(config.region || '')) fail('region must be an Alibaba Cloud region ID');
  if (!/^\d{6,20}$/.test(config.accountId || '')) fail('accountId must be the Alibaba Cloud account ID as a string');
  if (!config.frontend && !config.backend) fail('Configure frontend, backend, or both');
  keys(config.dns, ['zone', 'ttl'], 'dns');
  domain(config.dns.zone, 'dns.zone');
  config.dns.ttl ??= 600;
  integer(config.dns.ttl, 600, 86400, 'dns.ttl');
  if (config.frontend) {
    const f = config.frontend;
    keys(f, ['bucket', 'dir', 'build', 'domain', 'spa'], 'frontend');
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(f.bucket || '')) fail('frontend.bucket must be a valid OSS bucket name');
    string(f.dir, 'frontend.dir');
    f.dir = resolve(baseDir, f.dir);
    f.spa ??= true;
    if (typeof f.spa !== 'boolean') fail('frontend.spa must be boolean');
    build(f.build, baseDir, 'frontend.build');
  }
  if (config.backend) {
    const b = config.backend;
    keys(b, ['functionName', 'codeDir', 'build', 'domain', 'runtime', 'command', 'port', 'cpu', 'memorySize', 'timeout', 'instanceConcurrency', 'maxInstances', 'environment', 'envFrom', 'role', 'vpcConfig'], 'backend');
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(b.functionName || '')) fail('backend.functionName is invalid');
    string(b.codeDir, 'backend.codeDir');
    b.codeDir = resolve(baseDir, b.codeDir);
    b.runtime ??= 'custom.debian10';
    if (!['custom.debian12', 'custom.debian11', 'custom.debian10', 'custom'].includes(b.runtime)) fail('backend.runtime must be a supported FC custom runtime');
    command(b.command, 'backend.command');
    b.port ??= 9000; b.cpu ??= 0.35; b.memorySize ??= 512; b.timeout ??= 60; b.instanceConcurrency ??= 10; b.maxInstances ??= 5;
    integer(b.port, 1, 65535, 'backend.port');
    integer(b.memorySize, 128, 32768, 'backend.memorySize');
    if (b.memorySize % 64 !== 0) fail('backend.memorySize must be a multiple of 64 MiB');
    integer(b.timeout, 1, 86400, 'backend.timeout');
    integer(b.instanceConcurrency, 1, 200, 'backend.instanceConcurrency');
    integer(b.maxInstances, 1, 1000, 'backend.maxInstances');
    if (typeof b.cpu !== 'number' || b.cpu < 0.05 || b.cpu > 16 || Math.abs(b.cpu * 20 - Math.round(b.cpu * 20)) > 1e-8 || b.memorySize / 1024 < b.cpu || b.memorySize / 1024 > b.cpu * 4) fail('backend cpu must be in 0.05 steps; memory in GB must be between cpu and 4 × cpu');
    b.environment ??= {}; b.envFrom ??= {};
    stringMap(b.environment, 'backend.environment'); stringMap(b.envFrom, 'backend.envFrom');
    for (const [name, source] of Object.entries(b.envFrom)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(source)) fail(`backend.envFrom.${name} must name an environment variable`);
      if (name in b.environment) fail(`Variable ${name} appears in both environment and envFrom`);
      if (/^(ALIBABA_CLOUD|ALICLOUD|OSS)_/.test(source)) fail('Do not forward deployment credentials into the function; use backend.role');
    }
    if (b.role && !/^acs:ram::\d+:role\/[A-Za-z0-9._/-]+$/.test(b.role)) fail('backend.role must be a RAM role ARN');
    if (b.vpcConfig) {
      keys(b.vpcConfig, ['vpcId', 'vSwitchIds', 'securityGroupId'], 'backend.vpcConfig');
      for (const key of ['vpcId', 'securityGroupId']) string(b.vpcConfig[key], `backend.vpcConfig.${key}`);
      command(b.vpcConfig.vSwitchIds, 'backend.vpcConfig.vSwitchIds');
    }
    build(b.build, baseDir, 'backend.build');
  }
  const domains = [config.frontend?.domain, config.backend?.domain].filter(Boolean);
  if (domains.length !== Number(Boolean(config.frontend)) + Number(Boolean(config.backend))) fail('Each configured frontend/backend needs its own domain');
  for (const name of domains) {
    domain(name, 'domain');
    if (!name.endsWith(`.${config.dns.zone}`)) fail('Use a subdomain within dns.zone; apex CNAME is intentionally unsupported');
  }
  if (new Set(domains).size !== domains.length) fail('Frontend and backend domains must be different');
  keys(config.tls, ['certFile', 'keyFile', 'acme'], 'tls');
  for (const key of ['certFile', 'keyFile']) {
    string(config.tls[key], `tls.${key}`);
    config.tls[key] = resolve(baseDir, config.tls[key]);
  }
  if (config.tls.acme) {
    const a = config.tls.acme;
    keys(a, ['email', 'directoryUrl', 'accountKeyFile', 'renewBeforeDays', 'agreeToTerms', 'proxyUrl'], 'tls.acme');
    string(a.email, 'tls.acme.email'); string(a.accountKeyFile, 'tls.acme.accountKeyFile');
    a.accountKeyFile = resolve(baseDir, a.accountKeyFile);
    if (a.directoryUrl && !a.directoryUrl.startsWith('https://')) fail('ACME directoryUrl must use HTTPS');
    if (a.proxyUrl !== undefined) {
      let proxy;
      try { proxy = new URL(a.proxyUrl); } catch { fail('ACME proxyUrl must be a valid HTTP(S) proxy origin'); }
      if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) fail('ACME proxyUrl must be an HTTP(S) proxy origin without credentials or a path');
    }
    a.renewBeforeDays ??= 30;
    integer(a.renewBeforeDays, 1, 60, 'tls.acme.renewBeforeDays');
    if (a.agreeToTerms !== undefined && typeof a.agreeToTerms !== 'boolean') fail('tls.acme.agreeToTerms must be boolean');
  }
  const paths = [config.tls.certFile, config.tls.keyFile, config.tls.acme?.accountKeyFile].filter(Boolean);
  if (new Set(paths).size !== paths.length) fail('TLS certificate, private key and account key need separate paths');
  validateDatabase(config);
  return config;
}

export async function loadConfig(path = 'aliyun.json') {
  const absolute = resolve(path);
  let raw;
  try { raw = JSON.parse(await readFile(absolute, 'utf8')); }
  catch { fail(`Cannot read valid JSON configuration: ${absolute}`); }
  return validateConfig(raw, dirname(absolute));
}

export async function doctor(config) {
  const checks = [];
  for (const [name, value] of [['frontend', config.frontend], ['backend', config.backend]]) {
    if (!value) continue;
    const directory = value.dir || value.codeDir;
    try { await access(directory); checks.push(`${name} output directory exists`); }
    catch { checks.push(`${name} output directory missing; ${value.build ? 'configured build must produce it' : 'create it before deploy'}`); }
    if (value.build) {
      await access(value.build.cwd).catch(() => fail(`${name}.build.cwd does not exist`));
      checks.push(`${name} build configured (not executed)`);
    }
  }
  const missing = Object.values(config.backend?.envFrom || {}).filter((key) => !Object.hasOwn(process.env, key));
  if (missing.length) checks.push(`Missing deployment environment variables: ${missing.join(', ')}`);
  const credentialNames = ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_SECURITY_TOKEN', 'ALIBABA_CLOUD_ECS_METADATA', 'ALIBABA_CLOUD_ROLE_ARN', 'ALIBABA_CLOUD_OIDC_TOKEN_FILE', 'ALIBABA_CLOUD_CREDENTIALS_URI', 'ALIBABA_CLOUD_CREDENTIALS_FILE'];
  checks.push(`Credential environment names present: ${credentialNames.filter((key) => Object.hasOwn(process.env, key)).join(', ') || 'none; SDK may use its default credential file/instance chain'}`);
  checks.push('Credentials were not resolved; cloud permissions and ownership were not checked');
  if (config.database) checks.push('Managed database configured; db-plan and db-inspect show its ownership, cost assumptions and required access; reuse existing authorization within its scope');
  if (config.tls.acme) checks.push('ACME configured; deploy/renew may contact CA and temporarily change DNS TXT records');
  else for (const path of [config.tls.certFile, config.tls.keyFile]) await access(path).catch(() => fail('Configured TLS files must exist before deploy'));
  return checks;
}

export function plan(config) {
  return {
    mode: 'Local desired state only; no cloud query, build, credential lookup, or mutation',
    project: config.project, accountId: config.accountId, region: config.region,
    frontend: config.frontend ? { bucket: config.frontend.bucket, action: 'Create if absent; only reuse this project-tagged bucket; disable bucket-level public access block, configure public-read website, upload files, bind HTTPS domain; retain old files', directory: config.frontend.dir, domain: config.frontend.domain, spa: config.frontend.spa, build: Boolean(config.frontend.build) } : undefined,
    backend: config.backend ? { functionName: config.backend.functionName, action: 'Create/update LATEST code and declared settings; anonymous HTTP trigger; min instances 0; replace owned domain route', directory: config.backend.codeDir, domain: config.backend.domain, build: Boolean(config.backend.build), cpu: config.backend.cpu, memorySize: config.backend.memorySize, maxInstances: config.backend.maxInstances, environmentNames: [...Object.keys(config.backend.environment), ...Object.keys(config.backend.envFrom)], vpc: Boolean(config.backend.vpcConfig) } : undefined,
    dns: { zone: config.dns.zone, action: 'Create or update one default-line CNAME per domain; create and clean up owned TXT records for OSS domain verification when needed; conflicting record types stop deployment' },
    tls: { mode: config.tls.acme ? 'Reuse valid certificate or ACME DNS-01 issuance/renewal; creates and cleans up its own TXT records' : 'Upload supplied PEM certificate and private key', domains: [config.frontend?.domain, config.backend?.domain].filter(Boolean) },
    database: databasePlan(config),
  };
}
