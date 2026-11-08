// 临时：验证设置页壁纸新卡片 + 当前壁纸接口
const PORT = process.argv[2] || '9333';
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.log('✗ 未找到窗口');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const errors = [];
const send = (m, p = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown')
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.onopen = async () => {
  await send('Runtime.enable');
  await sleep(5000);
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'ERR: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  let bad = 0;
  const check = (ok, label, extra = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
    if (!ok) bad++;
  };

  console.log('【接口】');
  const cur = await ev(`(async()=>{const r=await fetch('/api/wallpaper/current');return JSON.stringify(await r.json())})()`);
  console.log('     当前壁纸:', cur);
  const mons = await ev(`(async()=>{const r=await fetch('/api/wallpaper/monitors');const j=await r.json();return j.count+'/'+JSON.stringify(j.monitors.map(m=>m.width+'x'+m.height))})()`);
  check(String(mons).startsWith('1/'), '显示器接口可用', String(mons));

  // 设置 → 壁纸
  await ev(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('设置')).click()`);
  await sleep(1200);
  await ev(`[...document.querySelectorAll('.settings-nav button, .settings-nav a, .settings-nav div')].find(b=>b.textContent.includes('壁纸'))?.click()`);
  await sleep(1500);
  console.log('\n【设置 → 壁纸】');
  const cards = await ev(`[...document.querySelectorAll('.card h4, .card .card-title')].map(h=>h.textContent.trim())`);
  console.log('     卡片:', JSON.stringify(cards));
  const body = await ev(`document.querySelector('.content').innerText`);
  check(String(body).includes('多屏模式'), '有多屏模式选择');
  check(String(body).includes('检测到 1 个屏幕'), '显示检测到的屏幕数');
  const hotkeyLine = (String(body).match(/换一张壁纸：[^\n]*/) || [''])[0];
  console.log('     快捷键提示:', hotkeyLine.trim());
  check(/换一张壁纸：\s*Ctrl/.test(hotkeyLine), '显示实际生效的快捷键（含备用键回退）');
  check(String(body).includes('智能：高分图片更常出现'), '切换顺序有「智能（评分加权）」');
  check(String(body).includes('最低评分'), '有最低评分过滤');
  check(String(body).includes('收藏当前壁纸') && String(body).includes('不喜欢，换一张'), '有收藏/不喜欢按钮');

  // 试一下「不喜欢，换一张」
  const before = await ev(`(async()=>{const r=await fetch('/api/wallpaper/current');return (await r.json()).imageId})()`);
  await ev(`[...document.querySelectorAll('.btn')].find(b=>b.textContent.trim()==='不喜欢，换一张')?.click()`);
  await sleep(6000);
  const after = await ev(`(async()=>{const r=await fetch('/api/wallpaper/current');return (await r.json()).imageId})()`);
  check(after !== before, '「不喜欢」会立刻换一张', `${before} → ${after}`);
  const exCount = await ev(`(async()=>{const r=await fetch('/api/wallpaper/auto');return ((await r.json()).config.excluded||[]).length})()`);
  check(exCount > 0, '被排除的图已记录', `排除列表 ${exCount} 张`);

  console.log('\n' + (errors.length ? `❌ JS 异常: ${errors.slice(0, 2).join(' | ')}` : '✓ 无 JS 异常'));
  console.log(bad ? `❌ ${bad} 项未通过` : '✓ 设置界面全部通过');
  process.exit(0);
};
ws.onerror = () => process.exit(1);
