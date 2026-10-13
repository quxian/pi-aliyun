import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.PORT || 9000);
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (process.env.APP_ORIGIN && request.headers.origin === process.env.APP_ORIGIN) {
    response.setHeader('Access-Control-Allow-Origin', process.env.APP_ORIGIN);
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    response.setHeader('Vary', 'Origin');
  }
  const send = (status, data) => { response.writeHead(status); response.end(JSON.stringify(data)); };
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (request.method === 'GET' && path === '/health') {
    send(200, { ok: true, service: 'pi-aliyun-demo', version: 1 });
    return;
  }
  if (request.method !== 'POST' || path !== '/api/echo') { send(404, { error: '接口不存在' }); return; }
  if (!request.headers['content-type']?.startsWith('application/json')) { send(415, { error: '请发送 JSON' }); return; }
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 2048) { send(413, { error: '消息过长' }); return; }
      chunks.push(chunk);
    }
    const { message } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof message !== 'string' || !message.trim() || message.length > 200) {
      send(400, { error: '请输入 1–200 个字符' }); return;
    }
    send(200, { message: message.trim(), time: new Date().toISOString(), requestId: randomUUID(), service: 'pi-aliyun-demo' });
  } catch { send(400, { error: '请求内容不是有效 JSON' }); }
});
server.listen(port, '0.0.0.0', () => console.log(`Cloud echo listening on ${port}`));
process.on('SIGTERM', () => server.close());
