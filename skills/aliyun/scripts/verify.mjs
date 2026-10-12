import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { errorInfo } from './errors.mjs';

export function probeHttps(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 15000, headers: { 'User-Agent': 'pi-aliyun-verify' } }, response => {
      const certificate = response.socket.getPeerCertificate();
      const result = { url, status: response.statusCode, certificateExpires: certificate.valid_to };
      // Status and TLS are sufficient here. Never print business response bodies or cookies.
      response.destroy();
      resolve(result);
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('HTTPS probe timed out'), { code: 'ETIMEDOUT' })));
    request.on('error', reject);
  });
}

export async function verifyApplication(config, { probe = probeHttps, attempts = 1, wait = () => delay(5000) } = {}) {
  const targets = [config.frontend && { component: 'frontend', url: `https://${config.frontend.domain}/` },
    config.backend && { component: 'backend', url: `https://${config.backend.domain}${config.backend.healthPath || '/health'}` }].filter(Boolean);
  let checks;
  for (let attempt = 0; attempt < attempts; attempt++) {
    checks = await Promise.all(targets.map(async target => {
      try {
        const result = await probe(target.url);
        return { ...target, ...result, ok: result.status >= 200 && result.status < 300,
          ...(result.status >= 200 && result.status < 300 ? {} : { hint: target.component === 'backend' ? 'Check backend.healthPath and the FC process; the health route must return 2xx without business authentication.' : 'Check index.html, bucket website/ACL and the domain binding.' }) };
      } catch (error) { return { ...target, ok: false, ...errorInfo(error) }; }
    }));
    if (checks.every(check => check.ok)) break;
    if (attempt < attempts - 1) await wait();
  }
  return { ok: checks.every(check => check.ok), checks, businessAcceptance: 'HTTPS and HTTP health only. The Agent must separately verify actual application behavior and persistence.' };
}
