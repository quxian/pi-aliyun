import * as CAS from '@alicloud/cas20200407';
import { readFile } from 'node:fs/promises';
import { certificateIdentity } from './resources.mjs';

export async function applicationCertificates(cas, config, inventory) {
  const domains = [config.frontend?.domain, config.backend?.domain].filter(Boolean);
  const identities = [...(inventory?.tls?.certificates || [])];
  try { identities.push(certificateIdentity(await readFile(config.tls.certFile))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const certificates = new Map();
  // Omitting status only lists valid certificates; also include expired/revoked uploads.
  for (const status of [undefined, 'EXPIRED', 'REVOKED']) {
    for (let currentPage = 1; ; currentPage++) {
      const { body } = await cas.listUserCertificateOrder(new CAS.ListUserCertificateOrderRequest({ orderType: 'UPLOAD', keyword: domains[0], status, currentPage, showSize: 100 }));
      for (const item of body.certificateOrderList || []) {
        const sans = [...new Set([item.commonName, ...(item.sans || '').split(',')].map(x => x?.trim()).filter(Boolean))];
        if (!sans.some(name => domains.includes(name))) continue;
        const normalize = value => (value || '').replaceAll(':', '').toLowerCase();
        // CAS Sha2 is the SPKI public-key digest; Fingerprint is the certificate SHA-1.
        // Match both plus serial number so a reused key alone cannot claim another certificate.
        const owned = sans.length > 0 && sans.every(name => domains.includes(name)) && identities.some(identity =>
          identity.fingerprint === normalize(item.fingerprint) && identity.publicKeySha256 === normalize(item.sha2) && identity.serialNumber === normalize(item.serialNo));
        certificates.set(item.certificateId, { id: item.certificateId, domains: sans, expires: item.endDate, owned });
      }
      if (!Number.isInteger(body.totalCount)) throw new Error('CAS returned an invalid certificate count');
      if (currentPage * 100 >= body.totalCount) break;
    }
  }
  return [...certificates.values()];
}

export async function checkCertificateBindings(cas, certificates, config) {
  const domains = [config.frontend?.domain, config.backend?.domain].filter(Boolean);
  for (const cert of certificates.filter(item => item.owned)) {
    for (let currentPage = 1; ; currentPage++) {
      const { body } = await cas.listCloudResources(new CAS.ListCloudResourcesRequest({ certIds: [cert.id], cloudName: 'aliyun', currentPage, showSize: 100 }));
      for (const item of body.data || []) {
        if (!['FC', 'OSS'].includes(item.cloudProduct) || !domains.includes(item.domain)) throw new Error(`Certificate ${cert.id} is also deployed outside this application's domains; remove that dependency explicitly first`);
      }
      if (!Number.isInteger(body.total)) throw new Error('CAS returned an invalid cloud resource count');
      if (currentPage * 100 >= body.total) break;
    }
  }
}
