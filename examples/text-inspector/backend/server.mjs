import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const port = Number(process.env.PORT || 9000);
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (process.env.LOCAL_TEXT_ORIGIN && request.headers.origin === process.env.LOCAL_TEXT_ORIGIN) {
    response.setHeader('Access-Control-Allow-Origin', process.env.LOCAL_TEXT_ORIGIN);
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Vary', 'Origin');
  }
  const send = (status, data) => { response.writeHead(status); response.end(JSON.stringify(data)); };
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (request.method === 'GET' && path === '/health') {
    send(200, { ok: true, service: 'pi-aliyun-textlab', version: 1 }); return;
  }
  if (request.method !== 'POST' || path !== '/api/analyze') { send(404, { error: '接口不存在' }); return; }
  if (!request.headers['content-type']?.startsWith('application/json')) { send(415, { error: '请发送 JSON' }); return; }
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 65536) { send(413, { error: '内容过长，请缩短后重试' }); return; }
      chunks.push(chunk);
    }
    const { text } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof text !== 'string' || !text.length || text.length > 10000) {
      send(400, { error: '请输入文本，最多 10,000 个字符' }); return;
    }
    send(200, {
      characters: [...segmenter.segment(text)].length,
      nonWhitespace: [...segmenter.segment(text)].filter(({ segment }) => !/^\s+$/u.test(segment)).length,
      lines: text.split(/\r\n|\r|\n/).length,
      bytes: Buffer.byteLength(text, 'utf8'),
      time: new Date().toISOString(), requestId: randomUUID(), service: 'pi-aliyun-textlab',
    });
  } catch { send(400, { error: '请求内容不是有效 JSON' }); }
});
server.listen(port, '0.0.0.0', () => console.log(`Text inspector listening on ${port}`));
process.on('SIGTERM', () => server.close());
