const form = document.querySelector('#echo-form');
const send = document.querySelector('#send');
const status = document.querySelector('#status');
const reply = document.querySelector('#reply');
const details = document.querySelector('#details');
let apiOrigin;
try {
  const response = await fetch('./config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('配置文件不可用');
  ({ apiOrigin } = await response.json());
  if (!['http:', 'https:'].includes(new URL(apiOrigin).protocol)) throw new Error('接口地址无效');
  send.disabled = false;
  status.textContent = '等待你的消息';
  const health = document.querySelector('#health-link');
  health.href = `${apiOrigin}/health`;
  health.hidden = false;
} catch {
  status.textContent = '页面配置未就绪';
  reply.textContent = '请重新构建并上传前端产物，确保 config.json 中包含接口地址。';
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = new FormData(form).get('message').trim();
  if (!message || send.disabled) return;
  send.disabled = true;
  status.textContent = '正在等待云端回应';
  details.hidden = true;
  const start = performance.now();
  try {
    const response = await fetch(`${apiOrigin}/api/echo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    if (!response.ok || result.message !== message || !result.time || !result.requestId) throw new Error('接口响应异常');
    reply.textContent = result.message;
    status.textContent = '已收到云端回声';
    document.querySelector('#time').textContent = new Date(result.time).toLocaleString('zh-CN', { hour12: false });
    document.querySelector('#latency').textContent = `${Math.round(performance.now() - start)} ms`;
    document.querySelector('#request-id').textContent = result.requestId;
    details.hidden = false;
  } catch {
    status.textContent = '暂时没有连通';
    reply.textContent = '请重试。若持续失败，请检查接口健康状态、DNS、HTTPS 和跨域配置。';
  } finally { send.disabled = false; }
});
