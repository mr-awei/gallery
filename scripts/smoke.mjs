#!/usr/bin/env node
/**
 * 服务端冒烟测试（零依赖）：
 *  - 用临时用户目录 + 随机端口启动真实服务（真实 SQLite 迁移、鉴权、静态托管）
 *  - 校验：健康检查 / 鉴权 401 / 带 token 200 / 首页含 CSP / SSE 事件流 / settings 脱敏
 * 用法：npm run smoke（先 build web 亦可，dist 不存在时跳过首页 CSP 校验）
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 38790 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tmpUser = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-smoke-'));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/**
 * 冒烟用的测试图：一条高斯亮带（位置由 seed 决定，seed % 3 决定竖/横）+ 满幅噪点兜体积。
 * 别用纯噪点：缩到 640 缩略图后噪点会被平均成一片灰，pHash 只剩抖动的低位比特，
 * 场景一多就会撞进查重阈值（阈值是 8/64）—— 上传直接 400「图库里已有相同内容」。
 * 亮带位置不同 → 32×32 的低频结构明显不同，实测 12 张两两最小距离 22，稳稳超过阈值。
 */
function testPixels(w, h, seed = 0) {
  const buf = randomBytes(w * h * 3);
  const band = 0.1 + ((seed * 0.137) % 1) * 0.8;
  const horiz = seed % 3 === 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const t = horiz ? y / h : x / w;
      const d = t - band;
      const k = Math.max(0, 1 - (d * d) / 0.02);
      const base = 15 + 240 * k;
      buf[i] = Math.min(255, (buf[i] * 0.35 + base * 0.75) | 0);
      buf[i + 1] = Math.min(255, (buf[i + 1] * 0.35 + base * 0.6) | 0);
      buf[i + 2] = Math.min(255, (buf[i + 2] * 0.35 + base * 0.5) | 0);
    }
  }
  return buf;
}

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    // 用户数据目录故意带点（.app）：真实库的缩略图就长在 <素材目录>/.tuku/… 下，而
    // Express 的 send 默认把点开头的路径段当隐藏文件回 404 —— 那会让所有缩略图一直转圈。
    TUKU_USER_DATA: path.join(tmpUser, '.app'),
    TUKU_DATA_DIR: path.join(tmpUser, '.app', 'data'),
    TUKU_DEFAULT_STORAGE_DIR: path.join(tmpUser, '.app', 'storage'),
    // 关掉 CLIP：不然入库查重要看「模型加载完没」——CI 上模型就绪了会把噪点图判成重复，
    // 本地没加载又通过，同一份代码两种结论。这里只测接口行为，不需要深度特征。
    TUKU_CLIP: 'off',
    // 开放 API 的只读令牌：冒烟要真的验证「有 scope 但写不了」的 403，而不是只测接口能通
    TUKU_API_SCOPE_TOKENS: JSON.stringify({ 'smoke-readonly-token-1234': ['read'] }),
    NO_COLOR: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(deadlineMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.status < 500) return true; // 服务已应答即就绪（health 可能要求鉴权）
    } catch {
      /* not yet */
    }
    await sleep(300);
  }
  return false;
}

try {
  // 采集结果校验纯函数回归：曾经误写成自递归导致必应/搜狗等源全部
  // "Maximum call stack size exceeded"（v1.0.0 线上 bug），此处守护不再复发
  const { sanitizeResults } = await import('../server/sanitize.js');
  check('sanitize 空输入立即返回', Array.isArray(sanitizeResults([])) && sanitizeResults([]).length === 0);
  check(
    'sanitize 去重/过滤/封顶',
    (() => {
      const dup = { url: 'https://a.com/x.jpg', source: 't' };
      const input = [
        dup,
        { ...dup },
        { url: 'ftp://bad/x', source: 't' },
        { url: 'https://b.com/'.padEnd(2100, 'a'), source: 't' },
        { url: 'https://c.com/y.jpg', source: 't' },
        ...Array.from({ length: 300 }, (_, i) => ({ url: `https://d.com/${i}`, source: 't' })),
      ];
      const out = sanitizeResults(input);
      return out.length === 240 && out[0].url === 'https://a.com/x.jpg' && out[1].url === 'https://c.com/y.jpg';
    })()
  );

  check('服务启动', await waitReady());

  // 读自动生成的 API token（wx 独占创建）
  const tokenFile = path.join(tmpUser, '.app', '.api-token');
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  check('API token 自动生成', token.length >= 20);

  // 鉴权：无 token → 401；带 token → 200
  const noAuth = await fetch(`${BASE}/api/stats`);
  check('无令牌访问被拒绝 (401)', noAuth.status === 401);
  const withAuth = await fetch(`${BASE}/api/stats`, { headers: { Authorization: `Bearer ${token}` } });
  check('带令牌访问 (200)', withAuth.status === 200);
  // 详情面板的「所属资源库」不允许为空：图片记录不带库字段，只能靠这里下发
  {
    const statsBody = await withAuth.json();
    const lib = statsBody?.library;
    check('所属资源库永不缺失', !!(lib && lib.name && lib.path), JSON.stringify(lib));
  }

  // settings 脱敏：weiboCookie 永不回传
  const settings = await (await fetch(`${BASE}/api/settings`, { headers: { Authorization: `Bearer ${token}` } })).json();
  check('settings 脱敏（无 weiboCookie 明文）', !settings.weiboCookie && 'hasWeiboCookie' in settings);
  check('教程开关默认为 false', settings.tourDone === false);
  check('水印预设默认为空数组', Array.isArray(settings.watermarkPresets) && settings.watermarkPresets.length === 0);

  // 数组型设置必须整体替换：以前按对象合并，存进去会变成 {"0":…,"1":…} 的怪东西，
  // 水印预设（settings.watermarkPresets）就是靠这一条才能存下来
  {
    const auth = { Authorization: `Bearer ${token}` };
    const one = {
      id: 'preset-smoke',
      name: '冒烟预设',
      params: { style: 'corner-br', frame: 'none', fields: ['camera'], logo: true, brand: 'canon', model: 'EOS R5' },
      at: 1,
    };
    const put = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ watermarkPresets: [one] }),
    });
    const after = await (await fetch(`${BASE}/api/settings`, { headers: auth })).json();
    check(
      '水印预设：数组写入后原样读回',
      put.ok && Array.isArray(after.watermarkPresets) && after.watermarkPresets[0]?.id === 'preset-smoke',
      `${put.status} ${JSON.stringify(after.watermarkPresets).slice(0, 80)}`
    );
    // 脏数据也要能存（前端 sanitize，这里只保证不炸）
    const put2 = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ watermarkPresets: [] }),
    });
    check('水印预设：可以清空', put2.ok);
  }

  // 插件采集：格式广度与质量门槛的边界
  // 用户拖来的是一张 GIF/AVIF/TIFF 或者 512px 的 AI 预览图时，以前一律判「格式不支持 / 分辨率太低」，
  // 而 Eagle 拖什么存什么 —— 门槛只该拦爬虫，不该拦用户自己挑的图。
  {
    const sharp = (await import('sharp')).default;
    // 结构化噪点：尺寸/低频形状都不同，既压不小（能过最小体积门槛）又不会撞 pHash 被当成重复
    const noise = (w, h, seed) => sharp(testPixels(w, h, seed), { raw: { width: w, height: h, channels: 3 } });
    const pngA = await noise(900, 900, 0).png().toBuffer();
    const avif = await noise(900, 900, 1).avif({ quality: 60 }).toBuffer();
    const gif = await noise(900, 900, 2).gif().toBuffer();
    const tif = await noise(900, 900, 3).tiff().toBuffer();
    const tiny = await noise(320, 320, 4).png().toBuffer();
    const asUrl = (b, mime) => `data:${mime};base64,${b.toString('base64')}`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const post = (dataUrls, extra = {}) =>
      fetch(`${BASE}/api/extension/ingest`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ dataUrls, pageUrl: 'https://example.com/', keyword: '格式冒烟', ...extra }),
      }).then((r) => r.json());

    const wide = await post(
      [asUrl(pngA, 'image/png'), asUrl(avif, 'image/avif'), asUrl(gif, 'image/gif'), asUrl(tif, 'image/tiff'), asUrl(tiny, 'image/png')],
      { skipQuality: true }
    );
    check(
      '插件采集支持 png/avif/gif/tiff 与小尺寸预览图',
      wide.saved === 5,
      `saved=${wide.saved}/${wide.total} ${JSON.stringify((wide.results || []).map((r) => r.reason || 'ok'))}`
    );

    const strict = await post([asUrl(tiny, 'image/png')]);
    check(
      '爬虫的质量门槛仍然生效（低于 800px 被拦）',
      strict.saved === 0 && strict.results?.[0]?.reason === 'lowres',
      JSON.stringify(strict.results?.[0] || {})
    );

    // ---- 缩略图张冠李戴回归 ----
    // 缩略图/预览图按 id 命名，而 id 会随建库、清库、恢复备份从头再来。磁盘上「上一辈子
    // 同一个 id」的缩略图如果被直接认领，列表显示的就是别人的图，点开灯箱又是对的
    // （预览图刚生成）—— 用户看到的就是「缩略图和大图不是一张」。
    const thumbsRoot = path.join(tmpUser, '.app', 'storage', 'thumbs');
    const listIds = async () =>
      ((await (await fetch(`${BASE}/api/images?limit=200`, { headers })).json()).items || []).map((i) => i.id);
    const bucketedOf = (id) => path.join(thumbsRoot, (id % 256).toString(16).padStart(2, '0'), `${id}.jpg`);
    const legacyOf = (id) => path.join(thumbsRoot, `${id}.jpg`);
    const nextId = Math.max(0, ...(await listIds())) + 1;
    // 预览图预取/文件监听都是异步的，入库时拿到的 id 未必正好是「当前最大 + 1」。
    // 给后面几个 id 都埋上旧缩略图，别让用例输在竞态上（真正的断言用接口返回的 id）。
    const candidates = [nextId, nextId + 1, nextId + 2, nextId + 3];
    // 冒充旧行留下的竖版缩略图（640x960、深蓝纯色），mtime 设到 2020 年
    const staleJpeg = await sharp({
      create: { width: 640, height: 960, channels: 3, background: '#204060' },
    })
      .jpeg()
      .toBuffer();
    for (const id of candidates) {
      for (const p of [bucketedOf(id), legacyOf(id)]) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, staleJpeg);
        const old = new Date('2020-01-01T00:00:00Z');
        fs.utimesSync(p, old, old);
      }
    }
    // 新图：横构图浅底 + 红块，和那张深蓝竖图完全不像
    const freshPng = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#f5e6c8' } })
      .composite([
        { input: { create: { width: 320, height: 220, channels: 3, background: '#c0392b' } }, left: 40, top: 40 },
      ])
      .png()
      .toBuffer();
    const ingested = await post([asUrl(freshPng, 'image/png')], { skipQuality: true });
    const newId = Number(ingested.results?.[0]?.id) || Math.max(0, ...(await listIds()));
    const thumbSig = async (input) =>
      sharp(input, { failOn: 'none' }).resize(16, 16, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    const sa = await thumbSig(freshPng);
    const newThumb = bucketedOf(newId);
    const sb = fs.existsSync(newThumb) ? await thumbSig(newThumb) : null;
    let diff = -1;
    if (sb) {
      diff = 0;
      for (let i = 0; i < sa.length; i++) diff += Math.abs(sa[i] - sb[i]);
      diff /= sa.length;
    }
    check(
      '新入库的图不会继承旧 id 的缩略图',
      ingested.saved === 1 && diff >= 0 && diff < 12,
      `id=${newId} 16x16 平均像素差=${diff.toFixed(1)} saved=${ingested.saved}（0 附近才算同一张，深蓝竖图会 >100）`
    );
    check('新入库时同 id 的旧平铺缩略图被清掉', !fs.existsSync(legacyOf(newId)), legacyOf(newId));
    // 磁盘上有文件 ≠ 接口拿得到：缩略图目录在点目录（.tuku / .data）下时，
    // sendFile 默认会把点路径当隐藏文件直接 404，界面上就是所有卡片一直转圈。
    const thumbRes = await fetch(`${BASE}/api/images/${newId}/thumb`, { headers });
    check(
      '点目录下的缩略图能通过接口取到（不是隐藏文件 404）',
      thumbRes.ok && (thumbRes.headers.get('content-type') || '').startsWith('image/'),
      `id=${newId} status=${thumbRes.status} type=${thumbRes.headers.get('content-type')}`
    );
  }

  // 错误响应必须是 JSON：未匹配的 /api 路径若掉进 HTML 兜底，前端 request() 解析失败，
  // 只能给出「服务端返回了无效数据」，用户和排查的人都没法知道是路径写错了
  const auth0 = { Authorization: `Bearer ${token}` };
  const unknownApi = await fetch(`${BASE}/api/definitely-not-a-route`, { headers: auth0 });
  const unknownText = await unknownApi.text();
  check(
    '未知接口返回 JSON 404',
    unknownApi.status === 404 && /接口不存在/.test(unknownText),
    `${unknownApi.status} ${unknownText.slice(0, 40)}`
  );
  // 坏 JSON 是客户端问题，不能报 500（否则 500 日志里全是这类噪音）
  const badJson = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { ...auth0, 'Content-Type': 'application/json' },
    body: '{"theme":',
  });
  const badJsonText = await badJson.text();
  check(
    '坏 JSON 请求体返回 400 而非 500',
    badJson.status === 400 && /JSON/.test(badJsonText),
    `${badJson.status} ${badJsonText.slice(0, 40)}`
  );

  // SSE 事件流：能收到 hello 事件
  const sse = await fetch(`${BASE}/api/events?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'text/event-stream' },
  });
  let gotHello = false;
  if (sse.ok && sse.body) {
    const reader = sse.body.getReader();
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const { value, done } = await reader.read();
      if (done) break;
      if (new TextDecoder().decode(value).includes('event: hello')) {
        gotHello = true;
        break;
      }
    }
    reader.cancel().catch(() => {});
  }
  check('SSE 事件流可用（hello）', gotHello);

  // 任务中心 / 撤销栈：空库时必须返回数组而不是 500（新增的 routes/jobs.js 曾漏导出 register，
  // 整个服务起不来；这里守住接口形状，避免再出现「能编译不能跑」）
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const jobsRes = await fetch(`${BASE}/api/jobs`, auth);
  const jobsBody = jobsRes.ok ? await jobsRes.json() : null;
  check('任务历史接口可用（空数组）', jobsRes.status === 200 && Array.isArray(jobsBody));
  const opsRes = await fetch(`${BASE}/api/ops`, auth);
  const opsBody = opsRes.ok ? await opsRes.json() : null;
  check('操作日志接口可用（空数组）', opsRes.status === 200 && Array.isArray(opsBody));
  const undoEmpty = await fetch(`${BASE}/api/ops/undo-last`, { method: 'POST', ...auth });
  check('空栈撤销返回 400 而不是 500', undoEmpty.status === 400);
  const retryMissing = await fetch(`${BASE}/api/jobs/999999/retry`, { method: 'POST', ...auth });
  check('重试不存在的任务返回 404', retryMissing.status === 404);

  // 人脸：路由注册漏了会让整个服务起不来，模型未下载时又必须给出可读的原因而不是 500
  const faceSt = await fetch(`${BASE}/api/face/status`, auth);
  const faceStj = faceSt.ok ? await faceSt.json() : null;
  check(
    '人脸状态接口可用（含下载/扫描/计数）',
    faceSt.status === 200 && faceStj && typeof faceStj.downloaded === 'boolean' && Number.isFinite(faceStj.pending),
    `${faceSt.status} ${JSON.stringify(faceStj)?.slice(0, 120)}`
  );
  const facePpl = await fetch(`${BASE}/api/face/persons`, auth);
  const facePplj = facePpl.ok ? await facePpl.json() : null;
  // total 是「显示不全」的防线：没有它，前端被 limit 截断时无法提示用户
  check(
    '人物列表可用（空库返回空数组 + total）',
    facePpl.status === 200 && Array.isArray(facePplj?.persons) && Number.isFinite(facePplj?.total)
  );
  const faceItems = await fetch(`${BASE}/api/face/persons/1/items`, auth);
  const faceItemsj = faceItems.ok ? await faceItems.json() : null;
  check(
    '单人图片接口返回 total（超出 limit 才能提示「只显示了一部分」）',
    faceItems.status === 200 && Array.isArray(faceItemsj?.items) && Number.isFinite(faceItemsj?.total)
  );
  // 只在没下载模型时断言拒绝：真下过模型的话这一下会启动全库扫描，冒烟不该干这种事
  if (!faceStj?.downloaded) {
    const faceScan = await fetch(`${BASE}/api/face/scan`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const faceScanj = faceScan.ok ? null : await faceScan.json().catch(() => null);
    check('未下载模型时扫描明确拒绝（400 且有原因）', faceScan.status === 400 && !!faceScanj?.error);
  }
  const faceMerge = await fetch(`${BASE}/api/face/persons/merge`, {
    method: 'POST',
    headers: { ...auth.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  check('人物合并缺参数返回 400', faceMerge.status === 400);

  // 库健康：路径唯一索引是否真的建起来、删图有没有留孤儿 —— 以前这两件事用户完全看不见
  const health = await fetch(`${BASE}/api/maintenance/health`, auth);
  const healthj = health.ok ? await health.json() : null;
  check(
    '库健康接口可用（索引状态 + 孤儿计数 + 结构告警）',
    health.status === 200 &&
      healthj?.pathIndex &&
      typeof healthj.pathIndex.ok === 'boolean' &&
      healthj.orphans &&
      Array.isArray(healthj.warnings),
    `${health.status}`
  );
  check('新建库的 abs_path 唯一索引已建立', healthj?.pathIndex?.ok === true, JSON.stringify(healthj?.pathIndex));
  const idx = await fetch(`${BASE}/api/maintenance/path-index`, { method: 'POST', ...auth });
  const idxj = idx.ok ? await idx.json() : null;
  check('补建路径索引幂等（已存在时不报错）', idx.status === 200 && idxj?.ok === true);
  const orphan = await fetch(`${BASE}/api/maintenance/orphans/clean`, { method: 'POST', ...auth });
  const orphanj = orphan.ok ? await orphan.json() : null;
  check('清理孤儿关联接口可用', orphan.status === 200 && orphanj?.ok === true && orphanj.after);

  // 撤销栈端到端：入库 → 打标 → 撤销、重命名 → 撤销、删除 → 撤销。
  // 这三条是「统一操作日志」的核心承诺，出错时是静默的数据不一致（标签没回滚、文件名没改回），
  // 只测接口形状是发现不了的，必须在真实库里跑一遍逆操作。
  const sharp = (await import('sharp')).default;
  const W = 900;
  const H = 700;
  const noise = testPixels(W, H, 5);
  const png = await sharp(noise, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const upload = await fetch(`${BASE}/api/import/upload?filename=smoke-undo.png`, {
    method: 'POST',
    headers: { ...auth.headers, 'Content-Type': 'application/octet-stream' },
    body: png,
  });
  const uploaded = upload.ok ? await upload.json() : null;
  const imageId = uploaded?.image?.id;
  check('上传入库（撤销测试用）', upload.status === 200 && !!imageId);

  const getImage = async (id) => (await fetch(`${BASE}/api/images/${id}`, auth)).json();
  const readTags = (img) => (Array.isArray(img?.tags) ? img.tags.join(',') : String(img?.tags || ''));
  const latestOp = async (op) => {
    const list = await (await fetch(`${BASE}/api/ops?limit=20`, auth)).json();
    return Array.isArray(list) ? list.find((o) => o.op === op && !o.undone) : null;
  };
  const undoById = (id) => fetch(`${BASE}/api/ops/${id}/undo`, { method: 'POST', ...auth });

  if (imageId) {
    await fetch(`${BASE}/api/images/${imageId}`, {
      method: 'PATCH',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: 'smoke,undo' }),
    });
    const tagOp = await latestOp('tags');
    await undoById(tagOp?.id);
    check('撤销打标还原标签', readTags(await getImage(imageId)) === '');

    await fetch(`${BASE}/api/images/rename-batch`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [imageId], template: 'smoke-renamed-{index}' }),
    });
    const renOp = await latestOp('rename');
    await undoById(renOp?.id);
    check('撤销批量重命名还原文件名', (await getImage(imageId))?.title === 'smoke-undo.png');

    await fetch(`${BASE}/api/images/${imageId}`, { method: 'DELETE', ...auth });
    const trashOp = await latestOp('trash');
    const undoRes = await undoById(trashOp?.id);
    const listed = await (await fetch(`${BASE}/api/images?limit=50`, auth)).json();
    // 恢复是「重新入库」，id 会变，所以按标题确认回来了
    check('撤销删除把图片从回收站恢复', undoRes.status === 200 && (listed?.items || []).some((it) => it.title === 'smoke-undo.png'));
  }

  // 调色「预览 = 成品」：前端 renderPixels 与后端 applyRaw 必须算出同一张图。
  // 一旦两边公式跑偏，用户体验就是「调的时候好看，保存后变了个色」——这种问题只能靠逐像素比对发现。
  // 每组参数上传一张新图（PNG 无损），让它走真实调色管线，再比最大通道偏差。
  {
    const { renderPixels } = await import('../web/src/lib/adjust.ts');
    const { ADJUST_DEFAULTS } = await import('../web/src/types.ts');
    // 长边要 ≥ 默认 minResolution(800)，否则会被导入规则直接拒绝
    const aw = 800;
    const ah = 600;
    const cases = [
      ['曝光+对比度', { exposure: 25, contrast: 30 }],
      ['影调（亮度域）', { shadows: 45, highlights: -25, whites: 10, blacks: -12 }],
      ['白平衡+饱和度+色相', { temperature: 18, tint: -10, saturation: 15, vibrance: 20, hue: 8 }],
      [
        '曲线+全参数',
        {
          exposure: 12,
          contrast: 20,
          shadows: 30,
          highlights: -18,
          whites: 8,
          blacks: -10,
          temperature: 14,
          tint: -8,
          saturation: 12,
          vibrance: 18,
          hue: 6,
          curves: { rgb: [[0, 0], [128, 148], [255, 255]], r: [[0, 0], [128, 140], [255, 255]] },
        },
      ],
    ];
    for (const [caseNo, [label, params]] of cases.entries()) {
      const srcPixels = testPixels(aw, ah, 6 + caseNo);
      const srcPng = await sharp(srcPixels, { raw: { width: aw, height: ah, channels: 3 } }).png().toBuffer();
      const name = `smoke-adjust-${label.replace(/[^\w\u4e00-\u9fa5]/g, '')}.png`;
      const upAdjust = await fetch(`${BASE}/api/import/upload?filename=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { ...auth.headers, 'Content-Type': 'application/octet-stream' },
        body: srcPng,
      });
      const upText = await upAdjust.text();
      const adjustId = upAdjust.ok ? JSON.parse(upText)?.image?.id : null;
      const adjustRes = adjustId
        ? await fetch(`${BASE}/api/images/${adjustId}/adjust`, {
            method: 'POST',
            headers: { ...auth.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
          })
        : null;
      const savedBytes =
        adjustRes?.ok && (await fetch(`${BASE}/api/images/${adjustId}/file`, auth)).ok
          ? Buffer.from(await (await fetch(`${BASE}/api/images/${adjustId}/file`, auth)).arrayBuffer())
          : Buffer.alloc(0);
      let maxDiff = 999;
      let detail = `upload=${upAdjust.ok} adjust=${adjustRes?.status} bytes=${savedBytes.length}`;
      if (!upAdjust.ok) detail += ` ${upText.slice(0, 100)}`;
      if (savedBytes.length) {
        const { data: got, info: gotInfo } = await sharp(savedBytes).raw().toBuffer({ resolveWithObject: true });
        const want = new Uint8ClampedArray(srcPixels);
        renderPixels(want, 3, { ...ADJUST_DEFAULTS, ...params });
        if (gotInfo.width === aw && gotInfo.height === ah && got.length === want.length) {
          maxDiff = 0;
          let first = -1;
          for (let i = 0; i < got.length; i++) {
            const d = Math.abs(got[i] - want[i]);
            if (d > maxDiff) maxDiff = d;
            if (d > 2 && first < 0) first = i;
          }
          if (first >= 0) {
            const o = first - (first % 3);
            detail += ` first@${first} src=${[...srcPixels.subarray(o, o + 3)]} got=${[...got.subarray(o, o + 3)]} want=${[...want.subarray(o, o + 3)]}`;
          }
        } else {
          detail += ` ${gotInfo.width}x${gotInfo.height} 尺寸不符`;
        }
      }
      // 允许 1 级取整差（PNG 无损，两边都是浮点算、最后写 8bit）；实际长期是 0
      check(`调色预览=成品：${label}`, maxDiff <= 1, `${detail} maxDiff=${maxDiff}`);
    }
  }

  // 单张裁切复用了批量裁切台的「输出宽高」：给了就裁完重采样，不给就保持自然尺寸。
  // 这条路径以前只有批量裁切走，单张面板刚接上，得盯着点，别再出现「填了 300×300 出来还是原尺寸」。
  {
    const cw = 800;
    const ch = 600;
    const px = testPixels(cw, ch, 9);
    const png = await sharp(px, { raw: { width: cw, height: ch, channels: 3 } }).png().toBuffer();
    const up = await fetch(`${BASE}/api/import/upload?filename=smoke-crop.png`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/octet-stream' },
      body: png,
    });
    const upText = await up.text();
    const cropId = up.ok ? JSON.parse(upText)?.image?.id : null;

    const doCrop = async (body) => {
      if (!cropId) return { status: 0, text: `upload=${up.ok} ${upText.slice(0, 100)}` };
      const r = await fetch(`${BASE}/api/images/${cropId}/crop`, {
        method: 'POST',
        headers: { ...auth.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, text: await r.text() };
    };
    const fileDims = async () => {
      const r = await fetch(`${BASE}/api/images/${cropId}/file`, auth);
      if (!r.ok) return null;
      const meta = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
      return [meta.width, meta.height];
    };

    // 1) 不进行调整：0.5×0.5 的框 → 400×300
    const noResize = await doCrop({ ratio: 'free', rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
    const dims1 = noResize.status === 200 ? await fileDims() : null;
    check('单张裁切：不调整尺寸时按框自然裁', !!dims1 && dims1[0] === 400 && dims1[1] === 300, `${noResize.status} ${dims1?.join('x')}`);

    // 2) 指定输出 300×300：裁完重采样（覆盖的是同一张，尺寸会变，正好能验证写回后 DTO 也更新）
    const resized = await doCrop({
      ratio: 'free',
      rect: { x: 0, y: 0, w: 1, h: 1 },
      outWidth: 300,
      outHeight: 300,
    });
    const dims2 = resized.status === 200 ? await fileDims() : null;
    check('单张裁切：指定输出尺寸会重采样', !!dims2 && dims2[0] === 300 && dims2[1] === 300, `${resized.status} ${dims2?.join('x')}`);
    if (resized.status === 200) {
      const dto = JSON.parse(resized.text)?.item;
      check('单张裁切：DTO 里的宽高跟着更新', dto?.width === 300 && dto?.height === 300, `${dto?.width}x${dto?.height}`);
    }
  }

  // 水印 / 相框：预览和写回共用 renderComposite，所以「一项信息都没选」必须在 HTTP 层就被拦住，
  // 不能等到生成一张空白水印；相框要真的扩画布，尺寸得比原图大。
  {
    const optRes = await fetch(`${BASE}/api/watermark/options`, { headers: auth.headers });
    const optJson = optRes.ok ? await optRes.json() : {};
    check(
      '水印：23 款水印 + 20 款相框',
      optRes.status === 200 && optJson.watermarks?.length === 23 && optJson.frames?.length === 20,
      `${optRes.status} ${optJson.watermarks?.length}/${optJson.frames?.length}`
    );

    const px = testPixels(900, 600, 10);
    const png = await sharp(px, { raw: { width: 900, height: 600, channels: 3 } }).png().toBuffer();
    const up = await fetch(`${BASE}/api/import/upload?filename=smoke-wm.png`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/octet-stream' },
      body: png,
    });
    const upText = await up.text();
    const wmId = up.ok ? JSON.parse(upText)?.image?.id : null;

    const post = (suffix, body) =>
      fetch(`${BASE}/api/images/${wmId}/${suffix}`, {
        method: 'POST',
        headers: { ...auth.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    // 品牌与字体是下拉框的数据源：这两条曾经是空数组，界面上表现为「点开什么都没有」
    check(
      '水印：品牌下拉收录数十种（相机+手机+无人机，不含纯镜头厂）',
      Array.isArray(optJson.brands) && optJson.brands.length >= 40,
      `brands=${optJson.brands?.length}`
    );
    // 品牌清单只收「自己能拍」的：既不能剩纯镜头厂，也不能有只能手打型号的空品牌
    const loneLens = (optJson.brands || []).filter((b) => ['zeiss', 'tamron', 'voigtlander', 'samyang'].includes(b.key));
    const noModel = (optJson.brands || []).filter((b) => !(b.models || []).length);
    check(
      '水印：品牌都能拍且都有型号（无纯镜头厂、无空型号品牌）',
      loneLens.length === 0 && noModel.length === 0,
      `镜头厂=${loneLens.map((b) => b.key).join(',') || '无'} 空型号=${noModel.map((b) => b.key).join(',') || '无'}`
    );
    check(
      '水印：字体样式下拉可用（含跟随样式 + 至少 5 种）',
      Array.isArray(optJson.fonts) && optJson.fonts.length >= 6 && optJson.fonts[0].key === 'auto',
      `fonts=${optJson.fonts?.length}`
    );
    // 型号清单跟着品牌一起下发：以前只有品牌，用户得自己在别处查「佳能全画幅叫 EOS R5」
    const canonModels = optJson.brands?.find((b) => b.key === 'canon')?.models || [];
    const sonyModels = optJson.brands?.find((b) => b.key === 'sony')?.models || [];
    check(
      '水印：品牌下拉带上常见型号',
      canonModels.length >= 10 && sonyModels.length >= 10,
      `canon=${canonModels.length} sony=${sonyModels.length}`
    );

    // 拍摄地点的三级选择器：省 → 市 → 区/县，数据缺了前端就只剩一个手填框
    const geo = await (await fetch(`${BASE}/api/geo/regions`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const zj = geo.provinces?.find((p) => p.name === '浙江省');
    const hz = zj?.cities?.find((c) => c.name === '杭州市');
    const bj = geo.provinces?.find((p) => p.name === '北京市');
    check(
      '拍摄地点：省/市/区三级数据可用',
      geo.provinces?.length >= 34 && (hz?.districts || []).includes('西湖区') && (bj?.cities?.[0]?.districts || []).includes('东城区'),
      `provinces=${geo.provinces?.length} 杭州区县=${hz?.districts?.length}`
    );

    // 第三级必须真的比上一级细：港澳台原来一个区县都没有，只能选到「香港岛/九龙/新界」；
    // 东莞/中山这种直筒子市原来第三级只有自己。缺了就等于逼用户手写。
    const hkIsland = geo.provinces?.find((p) => p.name === '香港特别行政区')?.cities?.find((c) => c.name === '香港岛');
    const kowloon = geo.provinces?.find((p) => p.name === '香港特别行政区')?.cities?.find((c) => c.name === '九龙');
    const tw = geo.provinces?.find((p) => p.name === '台湾省');
    const tpe = tw?.cities?.find((c) => c.name === '台北市');
    const dg = geo.provinces?.find((p) => p.name === '广东省')?.cities?.find((c) => c.name === '东莞市');
    const emptyDistricts = (geo.provinces || [])
      .flatMap((p) => (p.cities || []).map((c) => ({ k: `${p.name}/${c.name}`, n: (c.districts || []).length })))
      .filter((x) => x.n === 0);
    check(
      '拍摄地点：港澳台与直筒子市都有更细的下一级',
      (hkIsland?.districts || []).includes('中西区') &&
        (kowloon?.districts || []).includes('油尖旺区') &&
        (tw?.cities || []).length >= 22 &&
        (tpe?.districts || []).includes('中正区') &&
        (dg?.districts || []).includes('虎门镇') &&
        emptyDistricts.length === 0,
      `香港岛=${hkIsland?.districts?.length} 九龙=${kowloon?.districts?.length} 台湾城市=${tw?.cities?.length} 东莞=${dg?.districts?.length} 空区县城市=${emptyDistricts.length}`
    );

    // 预览不再因为「没有可显示的信息」而失败：给原图 + 响应头说明原因。
    // 立刻返回 400 时用户看到的是一个黑框，连图都看不到，等于没法调参。
    const bare = await post('watermark/preview', { style: 'corner-br', fields: [], logo: false });
    const bareNote = decodeURIComponent(bare.headers.get('x-watermark-note') || '');
    check(
      '水印：预览无可显示信息时仍出原图并给说明',
      bare.status === 200 && (bare.headers.get('content-type') || '').includes('image/jpeg') && /一项信息都没选/.test(bareNote),
      `${bare.status} ${bareNote.slice(0, 40)}`
    );

    // 写回仍然必须拒绝：不能把一张没有水印的图当成「已加完」覆盖原图
    const bad = await post('watermark', { style: 'corner-br', fields: [], logo: false, saveMode: 'overwrite' });
    const badText = await bad.text();
    check('水印：写回时一项信息都不选直接报错', bad.status === 400 && /一项信息都没选/.test(badText), `${bad.status} ${badText.slice(0, 48)}`);

    // 这张是随机噪声图，没有 EXIF：只能靠手动指定品牌出 logo
    // 顺便指定字体样式，覆盖「替换 20 款样式里写死的 font-family」这条路
    const prev = await post('watermark/preview', { style: 'corner-br', fields: [], logo: true, brand: 'canon', font: 'kai' });
    check(
      '水印：预览返回 JPEG（带字体覆盖）',
      prev.status === 200 && (prev.headers.get('content-type') || '').includes('image/jpeg'),
      `${prev.status} ${prev.headers.get('content-type')}`
    );

    const applied = await post('watermark', {
      style: 'corner-br',
      frame: 'white-even',
      fields: [],
      logo: true,
      brand: 'canon',
      saveMode: 'overwrite',
    });
    const appliedText = await applied.text();
    const aj = applied.ok ? JSON.parse(appliedText) : {};
    check(
      '水印：写回后尺寸含相框扩边',
      applied.status === 200 && aj.width > 900 && aj.height > 600,
      `${applied.status} ${aj.width}x${aj.height}`
    );
  }

  // 焦点检测走真实 HTTP 链路：题材无关（这张是白底 + 蓝色主体，没有任何人脸/肤色），
  // 框必须往主体那边偏，而不是被中心先验按在正中
  {
    // 1600×1200 是为了让 PNG 体积过 30KB 的导入门槛（小图会被当成「文件太小」丢掉）
    const svg = `<svg width="1600" height="1200"><rect width="1600" height="1200" fill="#f7f7f7"/><rect x="1000" y="660" width="460" height="360" fill="#2f6fd0"/></svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const up = await fetch(`${BASE}/api/import/upload?filename=smoke-focus.png`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/octet-stream' },
      body: png,
    });
    const upText = await up.text();
    const upJson = up.ok ? JSON.parse(upText) : {};
    const focusId = upJson?.image?.id;
    let fok = false;
    let detail = `upload=${up.status} ${upText.slice(0, 120)}`;
    if (focusId) {
      const r = await fetch(`${BASE}/api/images/${focusId}/focus?ratio=1:1`, auth);
      const j = await r.json().catch(() => ({}));
      detail = `${r.status} ${JSON.stringify(j.rect || j.error)}`;
      // 主体在 x 0.625~0.9125：1:1 窗口（横 0.75 宽）最右只能到 x=0.25，
      // 居中会是 0.125 —— 贴着右边界且左边界 ≥0.2 才能说明它真的往主体走了
      fok = r.ok && !!j.rect && j.rect.x >= 0.2 && j.rect.x + j.rect.w > 0.98;
    }
    check('焦点检测：无人脸图也框住主体', fok, detail);
  }

  // 纯底图抠图：白底/灰底棚拍图不依赖 AI 模型，走纯像素漫水
  // 画布给到 3000×2250 是为了过导入的 30KB 体积门槛（小尺寸纯色图 PNG 只有十几 KB）
  {
    const svg = `<svg width="3000" height="2250"><rect width="3000" height="2250" fill="#ffffff"/><rect x="1125" y="844" width="750" height="562" fill="#2f6fd0"/></svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const up = await fetch(`${BASE}/api/import/upload?filename=smoke-flat.png`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/octet-stream' },
      body: png,
    });
    const upText = await up.text();
    const flatId = up.ok ? JSON.parse(upText)?.image?.id : null;
    let okCut = false;
    let detail = `upload=${up.status} ${upText.slice(0, 100)}`;
    if (flatId) {
      const r = await fetch(`${BASE}/api/images/${flatId}/remove-bg`, {
        method: 'POST',
        headers: { ...auth.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'flat' }),
      });
      const j = await r.json().catch(() => ({}));
      detail = `${r.status} ${JSON.stringify(j).slice(0, 120)}`;
      // 750×562 / (3000×2250) ≈ 6.2%：抠出主体、且明确是 flat 模式
      okCut = r.ok && j.mode === 'flat' && j.coverage > 0.04 && j.coverage < 0.09;
      if (okCut && j.id) {
        const fileRes = await fetch(`${BASE}/api/images/${j.id}/file`, auth);
        const meta = await sharp(Buffer.from(await fileRes.arrayBuffer())).metadata();
        okCut = !!meta.hasAlpha;
        detail = `${detail} alpha=${meta.hasAlpha}`;
      }
    }
    check('纯底图抠图：白底图抠出透明 PNG', okCut, detail);
  }

  // 灯箱预览图：长边 2560 的 webp。图库里原图平均 8MB+，灯箱直接加载要等一两秒，
  // 预览图把它压到几百 KB；这条守住「路由存在 + 输出确实是 webp + 比原图小」
  {
    const svg = `<svg width="3000" height="2250"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f6fd0"/><stop offset="1" stop-color="#d03f6f"/></linearGradient></defs><rect width="3000" height="2250" fill="url(#g)"/><circle cx="1500" cy="1125" r="700" fill="#ffffff" opacity="0.55"/><rect x="300" y="300" width="2200" height="200" fill="#0b1220" opacity="0.4"/></svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const up = await fetch(`${BASE}/api/import/upload?filename=smoke-preview.png`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/octet-stream' },
      body: png,
    });
    const upText = await up.text();
    const pvId = up.ok ? JSON.parse(upText)?.image?.id : null;
    let okPv = false;
    let detail = `upload=${up.status} ${upText.slice(0, 90)}`;
    if (pvId) {
      const r = await fetch(`${BASE}/api/images/${pvId}/preview`, auth);
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || '';
      // 再要一次：应命中磁盘缓存，且同样可用
      const again = await fetch(`${BASE}/api/images/${pvId}/preview`, auth);
      const againBuf = Buffer.from(await again.arrayBuffer());
      detail = `${r.status} ${ct} ${buf.length}B / ${png.length}B, 二次=${again.status} ${againBuf.length}B`;
      okPv =
        r.ok &&
        // JPEG 是刻意的：同一张大图 webp 编码要 550ms、jpeg 只要 175ms，
        // 灯箱是「当场生成」的档位，慢的是编码不是传输
        /image\/jpe?g/.test(ct) &&
        buf.length > 500 &&
        buf.length < png.length &&
        again.ok &&
        againBuf.length === buf.length;
    }
    check('灯箱预览图：小体积 JPEG 且可缓存复用', okPv, detail);
  }

  // 新建资源库：只填「素材文件夹」，库数据自动落到 <素材文件夹>/.tuku/ 下。
  // 这条守住「用户只需要回答一个问题」以及删库时会把 .tuku 空壳一起收掉。
  {
    const rootDir = path.join(tmpUser, 'lib-smoke-root');
    fs.mkdirSync(rootDir, { recursive: true });
    const created = await fetch(`${BASE}/api/libraries`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '冒烟库', rootPath: rootDir }),
    });
    const createdJson = await created.json().catch(() => ({}));
    const newId = createdJson?.id;
    const list = await (await fetch(`${BASE}/api/libraries`, auth)).json().catch(() => ({}));
    const row = (list.libraries || []).find((l) => l.id === newId);
    const expectedBase = path.join(rootDir, '.tuku');
    const okLib =
      created.ok &&
      !!row &&
      // 没有第二个目录参数：数据就在素材文件夹下的 .tuku 里
      path.resolve(row.path).startsWith(path.resolve(expectedBase)) &&
      path.resolve(row.root_path) === path.resolve(rootDir) &&
      fs.existsSync(path.join(row.path, 'gallery.db'));
    // 删库：库目录和 .tuku 空壳都要收掉（删文件是接口返回后的异步动作，等一会儿）
    if (row) await fetch(`${BASE}/api/libraries/${newId}`, { method: 'DELETE', ...auth });
    await new Promise((r) => setTimeout(r, 600));
    const shellGone = !fs.existsSync(expectedBase) || fs.readdirSync(expectedBase).length === 0;
    check(
      '新建资源库：只需素材文件夹，数据自动落在 .tuku',
      okLib && shellGone,
      `${created.status} path=${row?.path || '-'} 空壳已清=${shellGone}`
    );
  }

  // 导出 HTML 网页画廊：单文件 + 缩略图内嵌（不能是 /api/... 链接，否则发给别人就是空白）
  // 以及文件夹封面（手动指定 / 恢复自动兜底）。两张卡共用一个新上传的素材，
  // 不复用前面的 imageId——它可能已经被回收站/撤销那几条测试改过状态。
  {
    // 长边要过 800px 的入库门槛，否则会被判 lowres
    const px = testPixels(1000, 800, 11);
    const png = await sharp(px, { raw: { width: 1000, height: 800, channels: 3 } }).png().toBuffer();
    const up = await fetch(`${BASE}/api/import/upload?filename=smoke-gallery.png`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/octet-stream' },
      body: png,
    });
    const upText = await up.text();
    const gid = up.ok ? JSON.parse(upText)?.image?.id : null;

    const q = new URLSearchParams({ ids: String(gid), title: '冒烟画廊', maxItems: '5', columns: '3' });
    const r = gid ? await fetch(`${BASE}/api/export/gallery?${q}`, auth) : null;
    const html = r ? await r.text() : '';
    const cd = r?.headers.get('content-disposition') || '';
    const okG =
      !!gid &&
      r.ok &&
      /^text\/html/.test(r.headers.get('content-type') || '') &&
      /attachment/.test(cd) &&
      html.includes('冒烟画廊') &&
      html.includes('data:image/jpeg;base64,') &&
      html.includes('1 张') &&
      !/src="\/api\//.test(html);
    check('导出 HTML 画廊：单文件内嵌缩略图', okG, `upload=${up.status} ${upText.slice(0, 80)} ${r?.status} ${html.length}B`);

    const jsonHeaders = { ...auth.headers, 'Content-Type': 'application/json' };
    const created = await fetch(`${BASE}/api/folders`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name: '封面冒烟夹' }),
    });
    const cj = await created.json().catch(() => ({}));
    const fid = cj.id;
    if (fid && gid) {
      await fetch(`${BASE}/api/folders/${fid}/images`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ imageIds: [gid] }),
      });
    }
    const setCover = fid
      ? await fetch(`${BASE}/api/folders/${fid}/cover`, {
          method: 'PUT',
          headers: jsonHeaders,
          body: JSON.stringify({ imageId: gid }),
        })
      : null;
    const setJson = setCover ? await setCover.json().catch(() => ({})) : {};
    const node = (setJson.folders || []).find((f) => f.id === fid);
    const clearRes = fid
      ? await fetch(`${BASE}/api/folders/${fid}/cover`, {
          method: 'PUT',
          headers: jsonHeaders,
          body: JSON.stringify({ imageId: null }),
        })
      : null;
    const clearJson = clearRes ? await clearRes.json().catch(() => ({})) : {};
    const node2 = (clearJson.folders || []).find((f) => f.id === fid);
    const okCover =
      !!fid &&
      setCover?.ok &&
      node?.cover?.imageId === gid &&
      node.cover.manual === true &&
      clearRes?.ok &&
      // 夹里只有这一张：自动封面同样回落到它，但手动标记必须消失
      node2?.cover?.imageId === gid &&
      node2.cover.manual === false;
    check('文件夹封面：手动指定 + 恢复自动兜底', okCover, `${setCover?.status} / ${clearRes?.status}`);
  }

  // 浏览器扩展：目录必须能被找到（以前打包不带 extension/，界面也没入口）
  {
    const r = await fetch(`${BASE}/api/extension/info`, auth);
    const j = await r.json().catch(() => ({}));
    const okE = r.ok && j.exists === true && /extension$/i.test(String(j.dir || '')) && String(j.id || '').length === 32;
    check('浏览器扩展：目录可定位且 ID 固定', okE, `${r.status} ${j.dir || '-'} id=${(j.id || '').slice(0, 8)}…`);
  }

  // 新增能力的最小契约：接口存在且形状正确。
  // 这些路由是「能编译不能跑」的高危区（register 漏导出、依赖未安装、参数解析崩），
  // 单测覆盖不到 HTTP 层，所以在这里各打一枪。
  {
    const j = async (p) => {
      const r = await fetch(`${BASE}${p}`, auth);
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const ocr = await j('/api/ocr/status');
    check(
      'OCR 状态：明确报告平台与可用性',
      ocr.status === 200 && typeof ocr.body?.available === 'boolean' && ocr.body.engine === 'windows-ocr',
      `${ocr.status} ${ocr.body?.platform} available=${ocr.body?.available}`
    );

    const acts = await j('/api/actions');
    check(
      '动作：列表返回步骤类型表与动作数组',
      acts.status === 200 &&
        acts.body?.types &&
        typeof acts.body.types === 'object' &&
        Object.keys(acts.body.types).length > 0 &&
        Array.isArray(acts.body?.actions),
      `${acts.status} types=${Object.keys(acts.body?.types || {}).length}`
    );

    const sim = await j('/api/similar?ids=1');
    check('相似分组：支持 ids 限定扫描范围', sim.status === 200 && Array.isArray(sim.body?.groups), `${sim.status}`);
    const dup = await j('/api/dupes/format');
    check('同目录跨格式重复：接口可用', dup.status === 200 && Array.isArray(dup.body?.groups), `${dup.status}`);

    // 可见区预热：前端滚动停稳后上报可见 id，服务端把它挪到预取队首（只排队不生成）
    const warm = await fetch(`${BASE}/api/images/previews/warm`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 2, 3] }),
    });
    const wj = await warm.json().catch(() => ({}));
    check(
      '预览预热：接受可见 id 并返回队列计数',
      warm.ok && wj.ok === true && typeof wj.added === 'number' && typeof wj.pending === 'number',
      `${warm.status} ${JSON.stringify(wj).slice(0, 80)}`
    );
  }

  // 数据出口端到端：备份必须落 gallery.db + 可读 library.json，
  // 恢复成新库时必须做路径前缀重映射（换机器/换盘符后「整库失联」就是这里没做事）。
  {
    const backupParent = path.join(tmpUser, 'backup-out');
    fs.mkdirSync(backupParent, { recursive: true });
    const preview = await fetch(`${BASE}/api/transfer/preview`, auth);
    const pv = await preview.json().catch(() => ({}));
    const bk = await fetch(`${BASE}/api/transfer/backup`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetDir: backupParent, includeThumbs: false }),
    });
    const bj = await bk.json().catch(() => ({}));
    const metaRes = await fetch(`${BASE}/api/transfer/metadata.json`, auth);
    const metaJson = await metaRes.json().catch(() => ({}));
    const backupOk =
      preview.ok &&
      typeof pv.counts?.images === 'number' &&
      bk.ok &&
      !!bj.dir &&
      fs.existsSync(path.join(bj.dir, 'gallery.db')) &&
      fs.existsSync(path.join(bj.dir, 'library.json')) &&
      metaRes.ok &&
      Array.isArray(metaJson.images) &&
      metaJson.images.length === pv.counts.images;

    const newRoot = path.join(tmpUser, 'restore-root');
    fs.mkdirSync(newRoot, { recursive: true });
    const rs = await fetch(`${BASE}/api/transfer/restore`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceDir: bj.dir, name: '冒烟恢复库', rootPath: newRoot }),
    });
    const rj = await rs.json().catch(() => ({}));
    const restoreOk =
      rs.ok &&
      !!rj.id &&
      fs.existsSync(rj.dbPath || '') &&
      // 所有素材原本都在旧根目录下：应当全部被重映射，且在新目录里都找不到（missing=remapped）
      rj.remapped === pv.counts?.images &&
      rj.missing === rj.remapped;
    if (rj.id) await fetch(`${BASE}/api/libraries/${rj.id}`, { method: 'DELETE', ...auth });
    check(
      '数据出口：备份含 gallery.db/library.json，恢复后按新根目录重映射',
      backupOk && restoreOk,
      `backup=${bk.status} ${bj.dir || '-'} restore=${rs.status} remapped=${rj.remapped} missing=${rj.missing}`
    );
  }

  /* ---------------- 本轮新增功能的端到端契约 ---------------- */
  {
    const bearer = { Authorization: `Bearer ${token}` };
    const json = async (res) => (await res.json().catch(() => ({})));

    // 开放 API v1：不接受同源豁免，令牌与 scope 都得是真的
    const anon = await fetch(`${BASE}/api/v1/status`);
    check('开放 API v1：无令牌 401（同源也不放行）', anon.status === 401, `${anon.status}`);
    const v1 = await fetch(`${BASE}/api/v1/status`, { headers: bearer });
    const v1j = await json(v1);
    check('开放 API v1：主令牌可用', v1.status === 200 && v1j.ok === true, `${v1.status} total=${v1j.total}`);
    const who = await json(await fetch(`${BASE}/api/v1/whoami`, { headers: bearer }));
    check(
      '开放 API v1：主令牌拥有 read/write/ingest',
      ['read', 'write', 'ingest'].every((s) => who.scopes?.includes(s)),
      JSON.stringify(who.scopes)
    );
    const doc = await fetch(`${BASE}/api/v1/openapi.json`, { headers: bearer });
    const docj = await json(doc);
    check(
      'OpenAPI 3.0：文档覆盖 images/ingest 与 Bearer 方案',
      doc.status === 200 && String(docj.openapi).startsWith('3.0') && !!docj.paths?.['/api/v1/ingest'] &&
        !!docj.paths?.['/api/v1/images'] && !!docj.components?.securitySchemes?.BearerAuth,
      `${doc.status} ${docj.openapi}`
    );
    const ro = { Authorization: 'Bearer smoke-readonly-token-1234' };
    const roRead = await fetch(`${BASE}/api/v1/status`, { headers: ro });
    const roWrite = await fetch(`${BASE}/api/v1/images/1/tags`, {
      method: 'POST',
      headers: { ...ro, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['不该写入'] }),
    });
    check('scope：只读令牌可读', roRead.status === 200, `${roRead.status}`);
    check('scope：只读令牌写操作被 403 拦下', roWrite.status === 403, `${roWrite.status}`);
    const roMainWrite = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { ...ro, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tourDone: true }),
    });
    check('scope：只读令牌不能借主 /api/* 写接口绕过 v1 的 403', roMainWrite.status === 403, `${roMainWrite.status}`);

    // 插件 / 脚本宿主
    const plugs = await fetch(`${BASE}/api/plugins`, auth);
    const plugsj = await json(plugs);
    check(
      '插件宿主：内置示例插件可发现',
      plugs.status === 200 && plugsj.plugins?.some((p) => p.id === 'tag-prefix'),
      JSON.stringify(plugsj.plugins?.map((p) => p.id))
    );
    const pr = await fetch(`${BASE}/api/plugins/tag-prefix/run`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'run', args: { prefix: '冒烟' } }),
    });
    const prj = await json(pr);
    check(
      '插件宿主：独立进程试运行回传 patch',
      pr.status === 200 && prj.ok === true && prj.patch?.tags?.includes('冒烟'),
      `${pr.status} ${JSON.stringify(prj).slice(0, 130)}`
    );

    const market = await fetch(`${BASE}/api/plugins/market`, auth);
    const marketJson = await json(market);
    check(
      '插件市场：索引可读且回显权限白名单',
      market.status === 200 && marketJson.plugins?.length >= 2 &&
        marketJson.permissions?.includes('image:write'),
      `${market.status}`
    );
    const badInstall = await fetch(`${BASE}/api/plugins/install`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'not-in-market' }),
    });
    check('插件市场：未收录的 id 明确 400', badInstall.status === 400, `${badInstall.status}`);
    const evilPackage = await fetch(`${BASE}/api/plugins/install/upload?filename=evil.tuku-plugin`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/octet-stream' },
      body: JSON.stringify({
        format: 'tuku-plugin/1',
        manifest: { id: 'evil', name: 'evil', entry: 'index.js', permissions: ['image:read'] },
        files: { '../escape.js': 'x' },
      }),
    });
    check('插件市场：路径穿越的插件包被拒绝', evilPackage.status === 400, `${evilPackage.status}`);
    const builtinDelete = await fetch(`${BASE}/api/plugins/note-date`, { method: 'DELETE', headers: auth.headers });
    check('插件市场：内置插件不允许卸载', builtinDelete.status === 400, `${builtinDelete.status}`);

    // 局域网投送：默认关闭，主服务不暴露端口（真正的开关启停由单测覆盖）
    const lan = await fetch(`${BASE}/api/lan/status`, auth);
    const lanj = await json(lan);
    check('局域网投送：默认关闭且无端口', lan.status === 200 && lanj.enabled === false && lanj.port === 0);
    const qr = await fetch(`${BASE}/api/lan/qrcode.svg`, auth);
    check('局域网投送：未开启时二维码明确 409', qr.status === 409, `${qr.status}`);
    const lanCheck = await fetch(`${BASE}/api/lan/selfcheck`, auth);
    const lanCheckJson = await json(lanCheck);
    check(
      '局域网投送：未开启时自检明确不可达',
      lanCheck.status === 200 && lanCheckJson.ok === false && Array.isArray(lanCheckJson.results),
      `${lanCheck.status}`
    );

    const badShareQr = await fetch(`${BASE}/api/lan/share-qrcode.svg?share=not-a-real-token`, auth);
    check('只读分享：未知令牌的二维码明确 404', badShareQr.status === 404, `${badShareQr.status}`);
    const pwaOnMain = await fetch(`${BASE}/manifest.webmanifest`, auth);
    const pwaCt = pwaOnMain.headers.get('content-type') || '';
    check(
      'PWA 外壳只在独立投送端口提供，主服务不暴露',
      !pwaCt.includes('manifest+json'),
      `${pwaOnMain.status} ${pwaCt}`
    );

    const namePreview = await fetch(`${BASE}/api/import/name-preview`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: '{date}-{index}{ext}' }),
    });
    const namePreviewJson = await json(namePreview);
    check(
      '导入命名模板：预览返回目标名、预设与占位符说明',
      namePreview.status === 200 &&
        Array.isArray(namePreviewJson.names) &&
        namePreviewJson.names.length > 0 &&
        namePreviewJson.names.length <= 20 &&
        namePreviewJson.presets?.length >= 4 &&
        namePreviewJson.tokens?.some((t) => t.token === '{index}'),
      `${namePreview.status} ${JSON.stringify(namePreviewJson).slice(0, 130)}`
    );

    // 动态壁纸：新字段、实时参数、GLSL 预设、渲染页、音频源
    const livej = await json(await fetch(`${BASE}/api/wallpaper/live`, auth));
    check(
      '动态壁纸：默认参数与新字段齐备',
      livej.params?.brightness === 100 && 'shaderPreset' in livej && 'audioSource' in livej,
      JSON.stringify(livej.params)
    );
    const putLive = await fetch(`${BASE}/api/wallpaper/live`, {
      method: 'PUT',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: { brightness: 130, speed: 60, intensity: 60, depth: 40 } }),
    });
    const liveAfter = await json(await fetch(`${BASE}/api/wallpaper/live`, auth));
    check('实时参数滑块：PUT 后立即读回', putLive.ok && liveAfter.params?.brightness === 130, `${putLive.status}`);
    const shaders = await json(await fetch(`${BASE}/api/wallpaper/live/shaders`, auth));
    check(
      'GLSL 预设：4 款且源码只依赖白名单 uniform',
      shaders.presets?.length === 4 && shaders.presets.every((p) => p.source?.includes('u_resolution')),
      `${shaders.presets?.length} 款`
    );
    const livePage = await fetch(`${BASE}/live?token=${encodeURIComponent(token)}`, auth);
    const liveHtml = await livePage.text();
    check(
      '动态壁纸渲染页：shader/交互/音频/实时 setParams/屏保都在',
      livePage.status === 200 &&
        ['startShader', 'startInteractive', 'startAudio', 'setParams', 'SCREENSAVER'].every((k) => liveHtml.includes(k)),
      `${livePage.status} ${liveHtml.length}B`
    );
    const audio = await fetch(`${BASE}/api/wallpaper/live/audio`, auth);
    check('音频壁纸：未选文件时明确 404', audio.status === 404, `${audio.status}`);

    // 视频首尾裁剪：区间可落库并进入 DTO（GIF / WebM 编码在单测里验证）
    const one = await json(await fetch(`${BASE}/api/v1/images?limit=1`, { headers: bearer }));
    const firstId = one.items?.[0]?.id;
    const patchMedia = firstId
      ? await fetch(`${BASE}/api/images/${firstId}/media`, {
          method: 'PATCH',
          headers: { ...auth.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ trimStart: 1.5, trimEnd: 4.5 }),
        })
      : null;
    const dto = firstId ? await json(await fetch(`${BASE}/api/v1/images/${firstId}`, { headers: bearer })) : {};
    check(
      '视频首尾裁剪：trimStart/trimEnd 可保存并进入 DTO',
      !!patchMedia?.ok && dto.item?.trimStart === 1.5 && dto.item?.trimEnd === 4.5,
      `${patchMedia?.status} ${JSON.stringify(dto.item?.trimStart)}~${JSON.stringify(dto.item?.trimEnd)}`
    );

    // 主令牌实际投送一张图：验证 write/ingest 通路不只是「鉴权通过」
    const unique = await sharp({
      create: {
        width: 64, height: 64, channels: 3,
        background: { r: 30 + (Date.now() % 200), g: 90, b: 160 },
      },
    }).png().toBuffer();
    const ingest = await fetch(`${BASE}/api/v1/ingest`, {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataUrl: `data:image/png;base64,${unique.toString('base64')}`,
        title: 'v1 冒烟投送',
        tags: '开放API',
      }),
    });
    const ingj = await json(ingest);
    check(
      '开放 API v1：主令牌可投送入库',
      ingest.ok && ingj.ok === true && ingj.id > 0,
      `${ingest.status} ${JSON.stringify(ingj).slice(0, 120)}`
    );

    // 跨库共享设置（屏保 / 投送开关）能落库并读回
    const putSaver = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        screensaver: { enabled: true, idleMinutes: 3, mode: 'shader', showClock: false },
        lanAccess: false,
      }),
    });
    const saver = await json(await fetch(`${BASE}/api/settings`, auth));
    check(
      '屏保 / 投送开关：设置可保存并读回',
      putSaver.ok && saver.screensaver?.idleMinutes === 3 && saver.screensaver?.mode === 'shader' &&
        saver.screensaver?.showClock === false && saver.lanAccess === false,
      `${putSaver.status} ${JSON.stringify(saver.screensaver)}`
    );

    /* ------------- 第四轮：采集源 / 暂停策略 / 擦除 / 工坊 / 同步 / 跨平台 ------------- */
    const caps = await json(await fetch(`${BASE}/api/platform`, auth));
    check(
      '跨平台：能力矩阵如实标注桌面层与静态壁纸能力',
      caps.ok === true && typeof caps.liveWallpaper === 'boolean' &&
        caps.staticWallpaper === true && caps.library === true && caps.screensaver === true,
      `${caps.family} live=${caps.liveWallpaper}`
    );
    const sources = await json(await fetch(`${BASE}/api/sources`, auth));
    const sourceKeys = (sources.sources || sources.items || []).map((s) => s.key || s.id || s);
    check(
      '采集源：豆瓣 / 贴吧 / Wikimedia 已注册',
      ['commons', 'douban', 'tieba'].every((k) => sourceKeys.includes(k)),
      sourceKeys.join(',')
    );
    const livePut = await fetch(`${BASE}/api/wallpaper/live`, {
      method: 'PUT',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pauseOnGpu: true, gpuThreshold: 72,
        pauseApps: ['photoshop.exe', 'msedge*'],
        allowLocalUrl: true, trustedDir: tmpUser, clickThrough: false,
      }),
    });
    const liveNext = await json(await fetch(`${BASE}/api/wallpaper/live`, auth));
    check(
      '暂停策略 / 网页交互：新配置项可保存读回',
      livePut.ok && liveNext.pauseOnGpu === true && liveNext.gpuThreshold === 72 &&
        liveNext.pauseApps?.length === 2 && liveNext.allowLocalUrl === true && liveNext.clickThrough === false,
      `${livePut.status} ${JSON.stringify(liveNext.pauseApps)}`
    );

    // 擦除修复：真实图片 + 真实 PNG 蒙版，走完整的写回 / 另存链路
    if (firstId) {
      const maskRaw = Buffer.alloc(64 * 64 * 3, 0);
      for (let y = 20; y < 40; y++) {
        for (let x = 20; x < 40; x++) {
          const i = (y * 64 + x) * 3;
          maskRaw[i] = 255;
          maskRaw[i + 1] = 255;
          maskRaw[i + 2] = 255;
        }
      }
      const maskPng = await sharp(maskRaw, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
      const inp = await fetch(`${BASE}/api/images/${firstId}/inpaint`, {
        method: 'POST',
        headers: { ...auth.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mask: `data:image/png;base64,${maskPng.toString('base64')}`,
          strength: 8,
          saveMode: 'copy',
          addToLibrary: true,
        }),
      });
      const inpj = await json(inp);
      check(
        '擦除修复：真实图片 + 蒙版能另存副本并回报覆盖率',
        inp.ok && inpj.ok === true && inpj.coverage > 0 && !!inpj.item,
        `${inp.status} coverage=${inpj.coverage} ${JSON.stringify(inpj).slice(0, 100)}`
      );
    } else {
      check('擦除修复：真实图片 + 蒙版能另存副本并回报覆盖率', false, '库里没有素材');
    }

    // 创意工坊：导出 → 导入往返，配色 / 壁纸设置 / 图片都要还原，注入的 CSS 要被剔掉
    const cover = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 12, g: 34, b: 56 } } })
      .png().toBuffer();
    const exp = await fetch(`${BASE}/api/workshop/export`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '冒烟主题',
        theme: { base: 'dark', variables: { '--accent': '#aabbcc', '--bg': 'url(https://evil/x)' } },
        assets: [{ name: 'cover.png', dataUrl: `data:image/png;base64,${cover.toString('base64')}` }],
      }),
    });
    const expj = await json(exp);
    check(
      '创意工坊：导出过滤注入值、保留合法配色与图片',
      exp.ok && expj.pack?.theme?.variables?.['--accent'] === '#aabbcc' &&
        !('--bg' in (expj.pack?.theme?.variables || {})) && expj.pack.assets.length === 1,
      `${exp.status} skipped=${expj.skipped?.length}`
    );
    const imp = await fetch(`${BASE}/api/workshop/import`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: JSON.stringify(expj.pack) }),
    });
    const impj = await json(imp);
    check(
      '创意工坊：导入还原配色 / 壁纸设置 / 图片',
      imp.ok && impj.theme?.variables?.['--accent'] === '#aabbcc' &&
        impj.assetPaths?.length === 1 && impj.appliedSettings?.includes('liveWallpaper'),
      `${imp.status} applied=${JSON.stringify(impj.appliedSettings)}`
    );

    // 多端同步：发布 → 第二次发布增量跳过 → 已是最新时不重复拉取
    const syncDir = path.join(tmpUser, 'sync-folder');
    fs.mkdirSync(syncDir, { recursive: true });
    const cfgSync = await fetch(`${BASE}/api/sync/configure`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncDir }),
    });
    const pubArgs = { method: 'POST', headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: '{}' };
    const pub1 = await json(await fetch(`${BASE}/api/sync/publish`, pubArgs));
    const pub2 = await json(await fetch(`${BASE}/api/sync/publish`, pubArgs));
    const pull = await json(await fetch(`${BASE}/api/sync/pull`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: '{"force":false}',
    }));
    check(
      '多端同步：发布 / 内容未变增量跳过 / 已是最新不重复拉取',
      cfgSync.ok && pub1.ok === true && pub1.revision === 1 && pub2.unchanged === true &&
        pull.ok === true && pull.skipped === true,
      `${cfgSync.status} r=${pub1.revision} unchanged=${pub2.unchanged} skipped=${pull.skipped}`
    );
  }

  // 首页与安全头：安全头与「dist 有没有构建」无关，必须无条件断言。
  // 以前整段包在 #root 判断里，未构建时 CSP 检查被静默跳过——安全回归就没人发现了。
  const home = await fetch(`${BASE}/`);
  check('首页可访问', home.status === 200);
  const csp = home.headers.get('content-security-policy');
  const xcto = home.headers.get('x-content-type-options');
  check('HTML 响应带 CSP 头', !!csp, csp?.slice(0, 60));
  check('CSP 含 default-src 限制', !!csp && /default-src/.test(csp));
  check('安全头 nosniff', xcto === 'nosniff');
} catch (err) {
  check('冒烟过程异常', false, String(err));
} finally {
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[smoke] ${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.error('\n----- 服务端日志（末 2000 字符）-----');
  console.error(serverLog.slice(-2000));
  try {
    fs.rmSync(tmpUser, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* Windows 下服务端刚被 kill，句柄释放有延迟；删不掉不影响结论 */
  }
  process.exit(1);
}
// Windows：句柄还会挂一会儿，EBUSY/EPERM 交给 rmSync 自己重试
try {
  fs.rmSync(tmpUser, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
} catch {
  /* 临时目录在 %TEMP% 下，删不干净也不影响校验结论 */
}
