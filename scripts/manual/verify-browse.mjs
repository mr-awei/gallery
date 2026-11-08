// 临时：验证浏览体验（缩放/平移/缩略图条/幻灯片/已读标记）
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
  await sleep(5000);
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) errors.push(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  let bad = 0;
  const check = (ok, label, extra = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
    if (!ok) bad++;
  };

  // 进图库
  await ev(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('图库')).click()`);
  await sleep(2200);
  console.log('【筛选栏】');
  check(await ev(`!!document.querySelector('.chip.ghost-chip') || [...document.querySelectorAll('.chip')].some(c=>c.textContent==='未看过')`), '有「未看过 / 已看过」筛选');
  const seenBefore = await ev(`(async()=>{const r=await fetch('/api/images?seen=unseen&pageSize=1');return (await r.json()).total})()`);
  console.log(`     当前未看过：${seenBefore} 张`);

  // 打开大图预览
  await ev(`document.querySelector('.card-img').click()`);
  await sleep(1500);
  const openedId = await ev(`(async()=>{const r=await fetch('/api/images?pageSize=1');const j=await r.json();return j.items[0].id})()`);
  console.log('\n【缩略图条】');
  check(await ev(`document.querySelectorAll('.lightbox-thumbs .lb-thumb').length > 0`), '缩略图条已渲染',
    `共 ${await ev(`document.querySelectorAll('.lightbox-thumbs .lb-thumb').length`)} 个`);
  check(await ev(`!!document.querySelector('.lb-thumb.on')`), '当前图片在缩略图条中高亮');
  const beforeIdx = await ev(`(document.querySelector('.lightbox-top span')||{}).textContent`);
  await ev(`document.querySelectorAll('.lightbox-thumbs .lb-thumb')[2].click()`);
  await sleep(700);
  const afterIdx = await ev(`(document.querySelector('.lightbox-top span')||{}).textContent`);
  check(beforeIdx !== afterIdx, '点缩略图可跳转', `${beforeIdx} → ${afterIdx}`);

  console.log('\n【缩放 / 平移】');
  const rect = await ev(
    `(()=>{const b=document.querySelector('.lightbox-body').getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`
  );
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY: -120, modifiers: 2 });
  await sleep(500);
  const zoomTxt = await ev(`(document.querySelector('.lightbox-zoom span')||{}).textContent`);
  check(!!zoomTxt && zoomTxt !== '100%', 'Ctrl+滚轮缩放', `比例 ${zoomTxt}`);
  const tf1 = await ev(`document.querySelector('.lightbox-body img').style.transform`);
  check(/scale\((?!1\))/.test(tf1), '图片应用了缩放变换', tf1);
  // 拖拽平移
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + 120, y: rect.y + 60, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + 120, y: rect.y + 60, button: 'left', clickCount: 1 });
  await sleep(400);
  const tf2 = await ev(`document.querySelector('.lightbox-body img').style.transform`);
  check(/translate\((?!0px, 0px)/.test(tf2), '拖拽平移生效', tf2.replace(/\s+/g, ' '));
  // 键盘 + 键继续放大
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: '+', code: 'Equal', windowsVirtualKeyCode: 187 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '+', code: 'Equal', windowsVirtualKeyCode: 187 });
  await sleep(400);
  const zoom2 = await ev(`(document.querySelector('.lightbox-zoom span')||{}).textContent`);
  check(parseInt(zoom2) > parseInt(zoomTxt), '「+」键放大', `${zoomTxt} → ${zoom2}`);
  // 0 重置
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: '0', code: 'Digit0', windowsVirtualKeyCode: 48 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '0', code: 'Digit0', windowsVirtualKeyCode: 48 });
  await sleep(400);
  check(!(await ev(`!!document.querySelector('.lightbox-zoom')`)), '「0」键重置缩放');

  console.log('\n【已读标记】');
  const viewedInfo = await ev(
    `[...document.querySelectorAll('.lightbox-info .meta-item')].map(m=>m.textContent).find(t=>t.includes('浏览情况')) || ''`
  );
  check(/看过 [1-9]/.test(viewedInfo), '打开预览即记录已看', viewedInfo);
  const apiCheck = await ev(
    `(async()=>{const r=await fetch('/api/images?pageSize=1');const j=await r.json();const it=j.items[0];return it.viewCount+'/'+it.viewed})()`
  );
  check(apiCheck.startsWith('1/true') || /^[1-9]/.test(apiCheck), '接口返回已看状态', `viewCount/viewed = ${apiCheck}`);
  const unseenNow = await ev(`(async()=>{const r=await fetch('/api/images?seen=unseen&pageSize=1');return (await r.json()).total})()`);
  check(unseenNow === seenBefore - 1, '「未看过」总数递减', `${seenBefore} → ${unseenNow}`);

  console.log('\n【幻灯片】');
  await ev(`[...document.querySelectorAll('.lightbox-top .btn')].find(b=>b.textContent.includes('幻灯片')).click()`);
  await sleep(600);
  check(await ev(`document.querySelector('.lightbox').className.includes('playing')`), '进入播放状态');
  await sleep(3200);
  check(await ev(`document.querySelector('.lightbox').className.includes('hide-chrome')`), '播放时自动隐藏界面');
  const i1 = await ev(`(document.querySelector('.lightbox-top span')||{}).textContent`);
  await ev(`document.querySelector('.lightbox').dispatchEvent(new MouseEvent('mousemove',{bubbles:true}))`);
  await sleep(200);
  check(!(await ev(`document.querySelector('.lightbox').className.includes('hide-chrome')`)), '鼠标移动唤出界面');
  await sleep(9000); // 等 2 个间隔（默认 5 秒）
  const i2 = await ev(`(document.querySelector('.lightbox-top span')||{}).textContent`);
  check(i1 !== i2, '自动切到下一张', `${i1} → ${i2}`);
  await ev(`[...document.querySelectorAll('.lightbox-top .btn')].find(b=>b.textContent.includes('暂停')).click()`);
  await sleep(400);
  check(!(await ev(`document.querySelector('.lightbox').className.includes('playing')`)), '可暂停');

  // 关闭后未看角标应消失
  await ev(`[...document.querySelectorAll('.lightbox-top .btn')].find(b=>b.textContent.includes('关闭')).click()`);
  await sleep(1200);
  console.log('\n' + (errors.length ? `❌ JS 异常: ${errors.slice(0, 3).join(' | ')}` : '✓ 无 JS 异常'));
  console.log(bad ? `\n❌ ${bad} 项未通过` : '\n✓ 浏览体验全部通过');
  console.log('（刚看过的图片 id=' + openedId + '）');
  process.exit(0);
};
ws.onerror = () => process.exit(1);
