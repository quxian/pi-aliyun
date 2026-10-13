import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRenewal, unregisterRenewal, renewRegistered } from '../skills/aliyun/scripts/renewal.mjs';

if (process.argv[2] === 'worker') {
  process.once('message', async () => {
    try {
      await (process.argv[3] === 'register' ? registerRenewal : unregisterRenewal)(process.argv[4], process.argv[5]);
      process.disconnect();
    } catch { process.exit(1); }
  });
  process.send('ready');
} else {
  const directory = await mkdtemp(join(tmpdir(), 'pi-aliyun-renewal-'));
  try {
    const raw = JSON.parse(await readFile(new URL('../skills/aliyun/assets/aliyun.example.json', import.meta.url)));
    raw.tls.acme = { accountKeyFile: '.aliyun/account.key', agreeToTerms: true };
    const paths = Array.from({ length: 12 }, (_, i) => join(directory, `project-${i}.json`));
    for (const [i, path] of paths.entries()) await writeFile(path, JSON.stringify({ ...raw, project: `pi-aliyun-smoke-${i}` }));
    const registry = join(directory, 'renewal.json');
    const environment = { ...process.env };
    delete environment.PI_ALIYUN_CONNECTION_FILE;
    delete environment.PI_ALIYUN_ACCOUNT_FILE;
    async function concurrent(operations) {
      const workers = operations.map(([operation, path]) => fork(new URL(import.meta.url), ['worker', operation, path, registry], { env: environment, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
      const finished = workers.map(worker => new Promise((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`)));
      }));
      await Promise.all(workers.map(worker => new Promise(resolve => worker.once('message', resolve))));
      for (const worker of workers) worker.send('start');
      await Promise.all(finished);
    }
    await concurrent(paths.slice(0, 8).map(path => ['register', path]));
    assert.deepEqual(new Set(JSON.parse(await readFile(registry)).projects), new Set(paths.slice(0, 8)));
    await concurrent([...paths.slice(0, 4).map(path => ['remove', path]), ...paths.slice(8).map(path => ['register', path])]);
    assert.deepEqual(new Set(JSON.parse(await readFile(registry)).projects), new Set(paths.slice(4)));
    await mkdir(`${registry}.lock`);
    const old = new Date(Date.now() - 60_000);
    await utimes(`${registry}.lock`, old, old);
    await registerRenewal(paths[4], registry);
    let count = 0;
    const result = await renewRegistered(registry, { run: async path => {
      count++;
      if (count === 1) throw Object.assign(new Error('sensitive upstream text'), { code: 'AccessDenied', data: { RequestId: 'request-123' } });
      return { configPath: path, status: 'ok', expiresAt: '2030-01-01T00:00:00.000Z' };
    } });
    assert.equal(count, 8);
    assert.equal(result.ok, false);
    assert.equal(result.projects[0].error.code, 'AccessDenied');
    assert.equal(result.projects[0].error.requestId, 'request-123');
    assert(result.projects[0].project && result.projects[0].domains.length);
    assert(!JSON.stringify(result).includes('sensitive upstream text'));
    assert.equal(result.projects[1].expiresAt, '2030-01-01T00:00:00.000Z');
    assert.equal((await renewRegistered(join(directory, 'absent.json'))).projects.length, 0);
    console.log('Renewal smoke passed: concurrent register/remove, stale lock recovery, per-project failures and expiry, safe errors and empty registry. No cloud APIs called.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
