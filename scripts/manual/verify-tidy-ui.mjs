// 临时：验证整理页 + 图库星级/色系筛选 + 大图星级评分
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
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(6500);
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

  /* ① 整理页 */
  console.log('【整理页】');
  await ev(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('整理')).click()`);
  await sleep(6000);
  const g1 = await ev(`document.querySelectorAll('.similar-item').length`);
  check(g1 > 0, '相似图分组已渲染', `${g1} 张候选图`);
  check(await ev(`!!document.querySelector('.similar-item.on')`), '默认选中推荐保留项');
  check(await ev(`!!document.querySelector('.similar-item input[type=radio]')`), '组内有单选按钮');
  const maint = await ev(`document.querySelector('.content').innerText.includes('素材维护')`);
  check(maint, '有「素材维护」卡片');
  const statsLine = await ev(`(document.querySelector('.content').innerText.match(/缺主色：[^\\n]*/)||[''])[0]`);
  console.log('     ' + statsLine.trim());
  check(
    await ev(`[...document.querySelectorAll('.btn')].some(b=>b.textContent.includes('补算主色'))`),
    '有「补算主色」按钮'
  );
  check(
    await ev(`[...document.querySelectorAll('.btn')].some(b=>b.textContent.includes('批量 AI 打标'))`),
    '有「批量 AI 打标」按钮'
  );

  /* ② 图库筛选栏 */
  console.log('\n【图库筛选】');
  await ev(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('图库')).click()`);
  await sleep(2500);
  const chips = await ev(`[...document.querySelectorAll('.chip')].map(c=>c.textContent.trim())`);
  check(chips.includes('★★★+'), '有星级筛选', chips.filter((c) => c.includes('★')).join(' / '));
  const dots = await ev(`document.querySelectorAll('.hue-dot').length`);
  check(dots === 12, '有 12 个色系圆点', `实际 ${dots} 个`);
  check(chips.includes('黑白'), '有黑白（无彩色）筛选');
  // 点一个色系 → 列表应只剩同色系
  const totalBefore = await ev(`(async()=>{const r=await fetch('/api/images?pageSize=1');return (await r.json()).total})()`);
  await ev(`document.querySelectorAll('.hue-dot')[0].click()`);
  await sleep(2200);
  const filtered = await ev(
    `(async()=>{const r=await fetch('/api/images?hue=0&pageSize=1');return (await r.json()).total})()`
  );
  const shown = await ev(`(document.querySelector('.toolbar span:last-child')||{}).textContent || ''`);
  check(filtered < totalBefore, '按色系筛选生效', `全部 ${totalBefore} → 色系0 ${filtered}（界面：${shown.trim()}）`);
  await ev(`[...document.querySelectorAll('.chip.ghost-chip')].find(c=>c.textContent.includes('清空色系'))?.click()`);
  await sleep(1500);

  /* ③ 大图里的星级 / 备注 / 主色 / AI */
  console.log('\n【大图整理字段】');
  await ev(`document.querySelector('.card-img').click()`);
  await sleep(1500);
  const info = await ev(`document.querySelector('.lightbox-info').innerText`);
  check(String(info).includes('我的星级'), '有星级');
  check(String(info).includes('我的备注'), '有备注输入框');
  check(String(info).includes('主色系'), '有主色系');
  check(String(info).includes('AI 识图'), '有 AI 识图');
  check(await ev(`!!document.querySelector('.color-chip')`), '有主色色块');
  if (await ev(`!!document.querySelector('.lightbox-zoom')`)) await ev(`document.querySelector('.lightbox-zoom button').click()`);

  const idBefore = await ev(`(async()=>{const r=await fetch('/api/images?pageSize=1');return (await r.json()).items[0].id})()`);
  await ev(`document.querySelectorAll('.lightbox-info .star')[2].click()`);
  await sleep(1200);
  const rating = await ev(`(async()=>{const r=await fetch('/api/images/${idBefore}');return (await r.json()).rating})()`);
  check(rating === 3, '点第 3 颗星后保存为 3 星', `rating=${rating}`);
  check(await ev(`document.querySelectorAll('.lightbox-info .star.on').length`) === 3, '界面显示 3 颗实心星');
  // 备注
  await ev(`(()=>{const el=document.querySelector('.lightbox-info input[placeholder*="记点什么"]');el.focus();el.value='UI 测试备注';el.dispatchEvent(new Event('input',{bubbles:true}));el.blur();return document.activeElement===el;})()`);
  await sleep(1200);
  const note = await ev(`(async()=>{const r=await fetch('/api/images?pageSize=1');return (await r.json()).items[0].note})()`);
  check(note === 'UI 测试备注', '备注已保存', note);
  // 复位
  await ev(`(async()=>{await fetch('/api/images/${idBefore}',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({rating:0,note:''})})})()`);
  await sleep(600);

  console.log('\n' + (errors.length ? `❌ JS 异常: ${errors.slice(0, 2).join(' | ')}` : '✓ 无 JS 异常'));
  console.log(bad ? `❌ ${bad} 项未通过` : '✓ 整理 UI 全部通过');
  process.exit(0);
};
ws.onerror = () => process.exit(1);
