// 临时：验证图库新筛选栏（下拉面板 + 激活 chips + 色盘精确颜色搜索）
const PORT = process.argv[2] || '9334';
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && /localhost:517\d/.test(t.url));
if (!page) {
  console.log('✗ 未找到页面目标:', targets.map((t) => `${t.type} ${t.url}`).join(' | '));
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
  await send('Page.enable');
  await send('Page.bringToFront'); // 后台标签页会被 Edge 抑制输入事件，必须置前
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
  const mouse = (type, x, y, extra = {}) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseMoved' ? 1 : 0, clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0, pointerType: 'mouse', ...extra });

  await sleep(2500);
  await send('Page.reload', { ignoreCache: true });
  /* ① 图库筛选栏：下拉入口化（轮询等待应用加载完成并切到图库） */
  let onGallery = false;
  for (let i = 0; i < 30 && !onGallery; i++) {
    await sleep(500);
    onGallery = !!(await ev(`(()=>{const b=[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('图库')); if(!b) return false; if(!document.querySelector('.fdrop-btn')) b.click(); return !!document.querySelector('.fdrop-btn')})()`));
  }
  check(onGallery, '进入图库（筛选栏渲染）');
  const drops = await ev(`[...document.querySelectorAll('.fdrop-btn')].map(b=>b.textContent.trim()).join(' / ')`);
  check(/^收藏▾ \/ 来源▾ \/ 画幅▾ \/ 浏览▾ \/ 星级▾ \/ 分辨率▾ \/ 颜色▾$/.test(drops), '筛选入口收敛为一行下拉', drops);
  const barDots = await ev(`document.querySelector('.toolbar .hue-dot') === null`);
  check(barDots, '主筛选栏不再平铺色系圆点');
  const total0 = await ev(`(async()=>{const r=await fetch('/api/images?pageSize=1');return (await r.json()).total})()`);
  console.log(`     图库共 ${total0} 张`);

  /* ② 颜色面板：紧凑色盘 + 停下即搜 */
  await ev(`[...document.querySelectorAll('.fdrop-btn')].find(b=>b.textContent.includes('颜色'))?.click()`);
  await sleep(500);
  check(await ev(`!!document.querySelector('.fdrop-panel .cpad-sv')`), '颜色面板内嵌紧凑色盘');
  const rect = await ev(`(()=>{const r=document.querySelector('.fdrop-panel .cpad-sv').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
  const sx = rect.x + rect.w * 0.5, sy = rect.y + rect.h * 0.5;
  const ex = rect.x + rect.w * 0.9, ey = rect.y + rect.h * 0.12;
  await mouse('mousePressed', sx, sy);
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', sx + ((ex - sx) * i) / 6, sy + ((ey - sy) * i) / 6);
    await sleep(18);
  }
  const t0 = Date.now(); // 鼠标停下
  let chips = '', total1 = -1;
  while (Date.now() - t0 < 2500) {
    await sleep(50);
    chips = String(await ev(`document.querySelector('.active-chips')?.textContent || ''`));
    if (Date.now() - t0 > 250 && /#[0-9A-F]{6}/i.test(chips)) {
      total1 = await ev(`(async()=>{const r=await fetch('/api/images?pageSize=1&colorHex='+encodeURIComponent(document.querySelector('.chip-swatch')?document.querySelector('.chip-active').textContent.replace('×','').trim():''));return 1})()`);
      break;
    }
  }
  await mouse('mouseReleased', ex, ey);
  check(/#[0-9A-F]{6}/i.test(chips), '拖动色盘停下后出现激活颜色 chip', chips.trim().slice(0, 40));
  const hexChip = (chips.match(/#[0-9A-Fa-f]{6}/) || [''])[0];
  // 颜色筛选生效：/api/images 带 colorHex 的结果与 /api/search/color 首个 id 一致（按相似度排序）
  const cmp = await ev(`(async()=>{
    const q = encodeURIComponent('${hexChip}');
    const a = await fetch('/api/images?pageSize=5&colorHex='+q+'&colorTol=48').then(r=>r.json());
    const b = await fetch('/api/search/color?hex='+q+'&tol=48&limit=5').then(r=>r.json());
    return JSON.stringify({list: a.items.map(i=>i.id).slice(0,3), color: b.items.map(i=>i.id).slice(0,3), total: a.total});
  })()`);
  const cmpObj = JSON.parse(cmp);
  check(
    JSON.stringify(cmpObj.list) === JSON.stringify(cmpObj.color) && cmpObj.list.length > 0,
    '/api/images 颜色筛选与颜色搜索排序一致',
    `images=${cmpObj.list} search=${cmpObj.color} total=${cmpObj.total}`
  );

  /* ③ 多选筛选徽标 + chips 移除 + 清空 */
  await ev(`[...document.querySelectorAll('.fdrop-btn')].find(b=>b.textContent.includes('来源'))?.click()`);
  await sleep(400);
  await ev(`[...document.querySelectorAll('.fdrop-panel .chip')].find(c=>c.textContent.trim()==='必应')?.click()`);
  await sleep(300);
  await ev(`[...document.querySelectorAll('.fdrop-panel .chip')].find(c=>c.textContent.trim()==='百度')?.click()`);
  await sleep(500);
  const badge = await ev(`[...document.querySelectorAll('.fdrop-btn')].find(b=>b.textContent.includes('来源'))?.querySelector('.fdrop-badge')?.textContent`);
  check(badge === '2', '来源多选显示徽标 ×2', String(badge));
  const chipCount = await ev(`document.querySelectorAll('.active-chips .chip-active').length`);
  check(chipCount >= 3, '激活筛选以 chips 呈现', `${chipCount} 个`);
  await ev(`document.querySelector('.active-chips .chip-active')?.click()`);
  await sleep(400);
  const chipAfter = await ev(`document.querySelectorAll('.active-chips .chip-active').length`);
  check(chipAfter === chipCount - 1, '点击 chip 可移除单个筛选', `${chipCount} → ${chipAfter}`);
  await ev(`[...document.querySelectorAll('.chip')].find(c=>c.textContent.includes('清空全部筛选'))?.click()`);
  await sleep(600);
  check(await ev(`!document.querySelector('.active-chips')`), '清空全部筛选后 chips 行消失');
  const totalReset = await ev(`(async()=>{const r=await fetch('/api/images?pageSize=1');return (await r.json()).total})()`);
  check(totalReset === total0, '清空后结果恢复', `${totalReset}/${total0}`);

  /* ④ 截图（带打开的颜色面板） */
  await ev(`[...document.querySelectorAll('.fdrop-btn')].find(b=>b.textContent.includes('颜色'))?.click()`);
  await sleep(600);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync('E:/gemvault/filterbar-test.png', Buffer.from(shot.data, 'base64'));
  console.log('  📸 截图: E:/gemvault/filterbar-test.png');

  console.log('\n' + (errors.length ? `❌ JS 异常: ${errors.slice(0, 2).join(' | ')}` : '✓ 无 JS 异常'));
  console.log(bad ? `❌ ${bad} 项未通过` : '✓ 新筛选栏全部通过');
  process.exit(0);
};
ws.onerror = () => process.exit(1);
