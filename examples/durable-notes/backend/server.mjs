import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { databaseForRequest } from './tablestore-runtime.mjs';

const token = process.env.NOTES_TOKEN;
if (!token || token.length < 32) throw new Error('Set a random NOTES_TOKEN with at least 32 characters through backend.envFrom');
const digest = (value) => createHash('sha256').update(value).digest();
const expectedToken = digest(`Bearer ${token}`);
const server = createServer(async (req, res) => {
  const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (req.url === '/health' && req.method === 'GET') return reply(200, { ok: true, storage: 'tablestore' });
  if (!timingSafeEqual(digest(req.headers.authorization || ''), expectedToken)) return reply(401, { error: 'Authentication required' });
  if (req.url !== '/note' || !['GET', 'PUT'].includes(req.method)) return reply(404, { error: 'Not found' });
  try {
    const db = databaseForRequest(req);
    const primaryKey = [{ owner: 'example' }, { id: 'note' }];
    if (req.method === 'GET') {
      const result = await db.call('getRow', { tableName: db.tables.notes, primaryKey, maxVersions: 1 });
      const text = result.row?.attributes?.find((column) => column.columnName === 'text')?.columnValue || '';
      return reply(200, { text });
    }
    const chunks = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 8192) { reply(413, { error: 'Note too long' }); return; }
      chunks.push(chunk);
    }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: 'Invalid JSON' }); }
    if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 4096) return reply(400, { error: 'Use a note of at most 4096 bytes' });
    await db.call('putRow', { tableName: db.tables.notes, primaryKey,
      condition: new db.TableStore.Condition(db.TableStore.RowExistenceExpectation.IGNORE, null), attributeColumns: [{ text: input.text }] });
    reply(200, { saved: true });
  } catch (error) {
    // Neither SDK errors nor request headers belong in public responses/logs.
    console.error('Note operation failed', /^[A-Za-z0-9_.-]+$/.test(error.code || '') ? error.code : 'ApplicationError');
    reply(503, { error: 'Storage unavailable' });
  }
});
server.listen(Number(process.env.PORT || 9000), '0.0.0.0');
