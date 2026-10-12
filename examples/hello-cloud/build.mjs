import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
let apiOrigin = process.env.DEMO_API_ORIGIN;
if (!apiOrigin) {
  try { apiOrigin = `https://${JSON.parse(await readFile(join(root, 'aliyun.json'), 'utf8')).backend.domain}`; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
apiOrigin ||= 'http://127.0.0.1:9000';
const url = new URL(apiOrigin);
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('DEMO_API_ORIGIN must be an HTTP(S) origin');
const output = join(root, 'dist');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, 'frontend'), join(output, 'frontend'), { recursive: true });
await cp(join(root, 'backend'), join(output, 'backend'), { recursive: true });
await writeFile(join(output, 'frontend/config.json'), JSON.stringify({ apiOrigin: url.origin }) + '\n');
console.log(`Built cloud echo for ${url.origin}`);
