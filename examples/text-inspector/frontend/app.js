const form = document.querySelector('#form');
const input = document.querySelector('#text');
const button = form.querySelector('button');
const status = document.querySelector('#status');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  status.className = '';
  status.textContent = '正在统计…';
  try {
    const configResponse = await fetch('config.json');
    if (!configResponse.ok) throw new Error('无法读取接口地址');
    const { apiOrigin } = await configResponse.json();
    const response = await fetch(new URL('/api/analyze', apiOrigin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: input.value }), signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '统计失败，请稍后重试');
    for (const key of ['characters', 'nonWhitespace', 'lines', 'bytes']) document.getElementById(key).textContent = data[key].toLocaleString('zh-CN');
    status.textContent = '统计完成 · 文本未保存';
    document.querySelector('#receipt').textContent = `完成于 ${new Date(data.time).toLocaleTimeString('zh-CN')} · ${data.requestId.slice(0, 8)}`;
  } catch (error) {
    status.className = 'error';
    status.textContent = error.name === 'TimeoutError' ? '请求超时，请再试一次' : error.message;
  } finally { button.disabled = false; }
});
