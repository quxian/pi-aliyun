import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const config = JSON.parse(await readFile(new URL('./aliyun.json', import.meta.url), 'utf8'));
await mkdir(new URL('./dist', import.meta.url), { recursive: true });
const html = await readFile(new URL('./frontend/index.html', import.meta.url), 'utf8');
await writeFile(new URL('./dist/index.html', import.meta.url), html.replace('__API_ORIGIN__', `https://${config.backend.domain}`));
// Copy from the installed package when preparing a standalone project (see README).
console.log(`Frontend built in ${fileURLToPath(new URL('./dist', import.meta.url))}`);
