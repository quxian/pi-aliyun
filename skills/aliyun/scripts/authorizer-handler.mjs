import RAMModule from '@alicloud/ram20150501';
import { bootstrapDatabaseRole } from './database-role.mjs';
import { databaseNames } from './database-plan.mjs';
import { readFile } from 'node:fs/promises';

// The administrator packs this file; callers cannot supply credentials, policies, trust or endpoints.
export async function authorize(input, settings, ram) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['version', 'operation', 'project'].includes(k)) || input.version !== 1 || !['ensure', 'inspect'].includes(input.operation)) throw new Error('Invalid authorization request');
  if (!/^pi-aliyun-[a-z0-9][a-z0-9-]{0,21}$/.test(input.project || '') || input.project === settings.authorizerFunction) throw new Error('Project is outside the approved namespace');
  const config = { accountId: settings.accountId, region: settings.region, project: input.project, database: { instance: settings.instance } };
  const { roleArn } = databaseNames(config);
  if (input.operation === 'inspect') return { status: 'available', roleArn };
  await bootstrapDatabaseRole(ram, config);
  return { status: 'ready', roleArn };
}
export async function handler(event, context) {
  try {
    if (event.length > 1024) throw new Error('Request too large');
    const settings = JSON.parse(await readFile(new URL('./settings.json', import.meta.url), 'utf8'));
    if (String(context.accountId) !== settings.accountId || context.region !== settings.region || context.function.name !== settings.authorizerFunction) throw new Error('Authorizer environment mismatch');
    const keys = context.credentials;
    if (!keys?.accessKeyId || !keys.accessKeySecret || !keys.securityToken) throw new Error('Authorizer runtime credentials missing');
    const Client = RAMModule.default || RAMModule;
    const ram = new Client({ accessKeyId: keys.accessKeyId, accessKeySecret: keys.accessKeySecret, securityToken: keys.securityToken, endpoint: 'ram.aliyuncs.com', protocol: 'https', connectTimeout: 10000, readTimeout: 20000 });
    return await authorize(JSON.parse(event.toString()), settings, ram);
  } catch (error) {
    // Never return SDK request objects or runtime credentials to callers.
    const code = /^[A-Za-z0-9_.-]+$/.test(error.code || '') ? error.code : 'AuthorizationRejected';
    console.error(JSON.stringify({ requestId: context.requestId, code }));
    return { status: 'error', code };
  }
}
