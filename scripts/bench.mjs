#!/usr/bin/env node
/**
 * 百万级性能基准（零依赖，真实 SQLite + 真实 HTTP）：
 *  1. 临时用户目录 + 随机端口起真实服务，新建一个临时资源库；
 *  2. 直接往该库的 gallery.db 批量灌 N 行素材（批量事务，不逐张上传，避免把基准变成导入测试）；
 *  3. 打真实接口，取 p50 / p95，与门槛比较，超了 exit 1。
 *
 * 用法：
 *   npm run bench                 # 20 万行
 *   npm run bench:quick           # 2 万行（verify 用，几十秒内跑完）
 *   npm run bench -- --rows 1000000 --samples 20
 *
 * 为什么不走导入接口：导入吞吐另有 worker 池与单次解码，混进来测不到查询侧。
 * 为什么不建缩略图：列表接口只拼 URL，缩略图生成是另一条懒加载链路。
 */
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
const ROWS = argv.includes('--quick') ? 20000 : argOf('rows', 200000);
const SAMPLES = argOf('samples', 15);
// 灌数与测量分成两次启动，端口各取各的，避免 TIME_WAIT 让第二次 listen 失败
let port = 0;
let BASE = '';
// 临时目录必须是 ASCII：node:sqlite 在中文路径下 close 后删不掉（见项目记忆）
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-bench-'));
const libraryRoot = path.join(tmpRoot, 'lib-root');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};
const ms = (n) => `${n.toFixed(0)}ms`;
// GitHub Actions 是共享 runner，单核性能浮动可达数倍：调色预览这类纯 CPU 门槛
// 在本机 p95 已贴近 25ms/80ms，换台慢机器就会假红。CI 放宽 3 倍并显式打印，
// 仍能拦住数量级回退；严格门槛请在受控机器上跑不带 CI 的 npm run bench*。
const CI_GATE_FACTOR = process.env.CI === 'true' ? 3 : 1;

let server = null;
let db = null;
let serverLog = '';

function cleanup() {
  try {
    db?.close();
  } catch {
    /* 已关闭 */
  }
  db = null;
  if (server && !server.killed) {
    try {
      server.kill();
    } catch {
      /* 已退出 */
    }
  }
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      return;
    } catch {
      /* Windows 上句柄释放有延迟，重试几次 */
    }
  }
}

async function waitReady(deadlineMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.status < 500) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return false;
}

/** 灌数据：真实表结构 + 批量事务，created_at 递减保证 newest 排序有区分度 */
function seed(dbFile, rows) {
  const conn = new DatabaseSync(dbFile);
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;');
  // images 上的触发器调用了应用注册的 SQL 函数；独立连接也必须注册同一套语义，
  // 否则 INSERT 直接抛 "no such function: sync_item_tags"。
  const delTags = conn.prepare('DELETE FROM item_tags WHERE image_id = ?');
  const insTag = conn.prepare('INSERT OR IGNORE INTO item_tags(tag, image_id) VALUES (?, ?)');
  const delNotes = conn.prepare('DELETE FROM image_notes WHERE image_id = ?');
  conn.function('sync_item_tags', (id, tagsStr) => {
    const id2 = Number(id);
    delTags.run(id2);
    for (const raw of String(tagsStr || '').split(',')) {
      const tag = raw.trim();
      if (tag) insTag.run(tag, id2);
    }
  });
  conn.function('delete_item_tags', (id) => delTags.run(Number(id)));
  conn.function('delete_image_notes', (id) => delNotes.run(Number(id)));
  const stmt = conn.prepare(
    `INSERT INTO images
      (title, abs_path, thumb, source, keyword, source_url, width, height, size_bytes, mime,
       phash, favorite, tags, created_at, viewed_at, view_count)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`
  );
  const base = Date.parse('2026-01-01T00:00:00Z');
  const CHUNK = 5000;
  for (let start = 0; start < rows; start += CHUNK) {
    const end = Math.min(rows, start + CHUNK);
    conn.exec('BEGIN');
    for (let i = start; i < end; i++) {
      const created = new Date(base - i * 60000).toISOString();
      // 标签覆盖按真实情况设：bench-tag 只挂 10%（没人会给全库八成的图打同一个标签），
      // 高覆盖的 50% 标签单独留一行「仅记录」，用来看数据量涨上去后的真实斜率
      const tags =
        i % 10 === 0 ? 'bench-tag,alpha' : i % 2 === 0 ? 'alpha' : 'beta';
      stmt.run(
        `bench-${i}`,
        `E:\\bench\\img\\${String(i % 500).padStart(3, '0')}\\p${i}.jpg`,
        // 非空 thumb：后台缩略图队列只补「没有缩略图」的行，压测不该触发真实解码
        `bench-${i}.webp`,
        i % 2 === 0 ? 'local' : 'crawl',
        i % 5 === 0 ? 'shadow mountain lake' : `keyword ${i % 97}`,
        1920 + (i % 7) * 160,
        1080 + (i % 5) * 120,
        204800 + (i % 13) * 10240,
        'image/jpeg',
        (i % 65536).toString(16).padStart(16, '0'),
        i % 11 === 0 ? 1 : 0,
        tags,
        created,
        i % 4,
      );
    }
    conn.exec('COMMIT');
  }
  return conn;
}

async function timed(url, headers, n) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const res = await fetch(url, { headers });
    await res.arrayBuffer();
    samples.push(performance.now() - t0);
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  }
  return samples;
}

const rowsOut = [];
function report(name, samples, gateMs) {
  const p50 = pct(samples, 50);
  const p95 = pct(samples, 95);
  const gate = gateMs == null ? null : gateMs * CI_GATE_FACTOR;
  const ok = gate == null || p95 <= gate;
  rowsOut.push({ name, p50, p95, gateMs: gate, ok });
  const gateTxt =
    gate == null ? '仅记录' : ms(gate) + (CI_GATE_FACTOR > 1 ? `（CI×${CI_GATE_FACTOR}）` : '');
  console.log(
    `  ${ok ? '✓' : '✗'} ${name.padEnd(26)} p50 ${ms(p50).padStart(6)}  p95 ${ms(p95).padStart(6)}  门槛 ${gateTxt}`
  );
}

/** 起一个真实服务实例（每次换端口）：灌数前后各起一次 */
async function startServer() {
  serverLog = '';
  port = 39290 + Math.floor(Math.random() * 600);
  BASE = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      TUKU_USER_DATA: path.join(tmpRoot, 'app'),
      TUKU_DATA_DIR: path.join(tmpRoot, 'app', 'data'),
      TUKU_DEFAULT_STORAGE_DIR: path.join(tmpRoot, 'app', 'storage'),
      // 基准只压查询路径：CLIP 开着会让入库/检索多打一层模型，结论不稳定
      TUKU_CLIP: 'off',
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  return waitReady();
}

async function stopServer() {
  const p = server;
  server = null;
  if (!p || p.killed) return;
  await new Promise((resolve) => {
    const done = () => resolve();
    p.once('exit', done);
    try {
      p.kill();
    } catch {
      done();
    }
    setTimeout(done, 5000);
  });
  await sleep(300);
}

/**
 * 前端调色预览：直接跑 ColorRoom 用的同一个 renderPixels（纯 CPU、无需浏览器）。
 * 尺寸取真实工作档：拖滑块 720 长边、停手 1600 长边；4000×3000 只记录，用来说明为什么必须先降采样。
 */
async function benchTone() {
  console.log('[bench] 调色预览（renderPixels，与 ColorRoom 同一条代码路径）：');
  let renderPixels;
  let defaults;
  try {
    ({ renderPixels } = await import('../web/src/lib/adjust.ts'));
    ({ ADJUST_DEFAULTS: defaults } = await import('../web/src/types.ts'));
  } catch (err) {
    console.log(`  - 跳过：无法加载前端调色实现（${String(err?.message || err).slice(0, 120)}）`);
    return;
  }
  const params = { ...defaults, exposure: 6, contrast: 12, saturation: 20, vibrance: 15, temperature: 8, clarity: 10 };
  const frames = (w, h) => {
    const base = new Uint8ClampedArray(w * h * 4);
    // 渐变 + 噪声：避免纯色让 HSL 分支被短路，参数组合是真实调色面板的常用量级
    for (let i = 0; i < w * h; i++) {
      const x = i % w;
      const y = (i / w) | 0;
      base[i * 4] = (x * 7 + y * 3) & 255;
      base[i * 4 + 1] = (x * 13 + y * 5) & 255;
      base[i * 4 + 2] = (x * 3 + y * 11) & 255;
      base[i * 4 + 3] = 255;
    }
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      // 真实预览也是每次把缓存帧复制一份再渲染，这里保持同样的内存行为
      const buf = new Uint8ClampedArray(base);
      const t = performance.now();
      renderPixels(buf, 4, params);
      samples.push(performance.now() - t);
    }
    return samples;
  };
  // 拖动帧是 50ms 节流一次（ColorRoom 的 quick 档），25ms 留一倍余量；
  // 16ms 是 60fps 游戏级目标，扣这个会把「感知流畅」误判成不达标
  report('调色预览 720 长边（拖滑块帧）', frames(720, 405), 25);
  report('调色预览 1600 长边（停手全精度）', frames(1600, 900), 80);
  report('调色预览 4000×3000（原图，仅记录）', frames(4000, 3000), null);
}

/** 找本机已有的 CLIP 权重目录（开发态 data/models 或安装版 %APPDATA%） */
function findModelDir() {
  const rel = path.join('Xenova', 'clip-vit-base-patch32', 'onnx', 'text_model_quantized.onnx');
  const candidates = [
    process.env.TUKU_MODEL_DIR || '',
    path.join(ROOT, 'data', 'models'),
    path.join(process.env.APPDATA || '', 'TuKu', 'data', 'models'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, rel))) return dir;
    } catch {
      /* 路径不可读就当没有 */
    }
  }
  return '';
}

/** CLIP：子进程跑，避免 server/clip.js 的模块单例与 bench 自己的 sqlite 连接打架 */
async function benchClip() {
  console.log('[bench] CLIP 语义检索：');
  const run = (mode, extra = [], envExtra = {}) =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          ...process.execArgv,
          path.join(ROOT, 'scripts', 'bench-clip.mjs'),
          '--app', path.join(tmpRoot, 'app'),
          '--mode', mode,
          '--samples', String(SAMPLES),
          ...extra,
        ],
        { cwd: ROOT, env: { ...process.env, ...envExtra }, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('exit', () => {
        const line = out
          .split('\n')
          .reverse()
          .find((l) => l.includes('[bench-clip]'));
        if (!line) return resolve({ ok: false, error: out.trim().slice(-600) || '子进程没有输出' });
        try {
          resolve(JSON.parse(line.slice(line.indexOf('[bench-clip]') + '[bench-clip]'.length).trim()));
        } catch {
          resolve({ ok: false, error: '子进程输出无法解析' });
        }
      });
    });

  const VEC_COUNT = Math.min(ROWS, 100000);
  const vec = await run('vectors', ['--vectors', String(VEC_COUNT)]);
  if (vec.ok) {
    report(`CLIP 向量检索（${vec.vectors} 条，minCos=0 全库上界）`, vec.samples, 300);
    const perK = vec.samples.reduce((a, b) => a + b, 0) / vec.samples.length / vec.vectors;
    console.log(
      `  · 写入 ${vec.vectors} 条向量耗时 ${(vec.seedMs / 1000).toFixed(1)}s；` +
        `按线性外推 100 万条约 ${(perK * 1e6).toFixed(0)}ms（外推值，非实测）`
    );
  } else {
    console.log(`  - 跳过向量检索：${vec.error}`);
  }

  // 文本塔：必须复用本机已有权重。临时库的 models 目录是空的，
  // 不指路的话 transformers.js 会去镜像站现下 64MB —— CI 上既慢又可能直接失败。
  const modelDir = findModelDir();
  if (!modelDir) {
    console.log('  - 跳过文本塔：本机没有 CLIP 文本塔权重（可用 TUKU_MODEL_DIR 指向已有缓存）');
  } else {
    const text = await run('text', [], { TUKU_MODEL_DIR: modelDir });
    if (text.ok) {
      console.log(`  · 文本塔首次加载 ${text.loadMs.toFixed(0)}ms（不计入样本，权重来自 ${modelDir}）`);
      report('CLIP 文本塔编码（单次）', text.samples, 500);
    } else {
      console.log(`  - 跳过文本塔：${text.error}`);
    }
  }
}

try {
  if (CI_GATE_FACTOR > 1) {
    console.log(
      `[bench] CI 环境：绝对时延门槛放宽 ${CI_GATE_FACTOR}×（共享 runner 波动大）；本地运行仍按原门槛严格判定`
    );
  }
  fs.mkdirSync(libraryRoot, { recursive: true });
  if (!(await startServer())) {
    console.error('[bench] 服务没起来：\n' + serverLog.slice(-2000));
    process.exit(1);
  }
  const tokenFile = path.join(tmpRoot, 'app', '.api-token');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const headers = { Authorization: `Bearer ${token}` };

  const created = await fetch(`${BASE}/api/libraries`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '压测库', rootPath: libraryRoot }),
  });
  if (!created.ok) throw new Error(`建库失败 HTTP ${created.status}`);
  const createdJson = await created.json();
  // 建库不会自动切换：压测必须显式激活，否则量的是默认空库（假绿灯）
  const activated = await fetch(`${BASE}/api/libraries/${createdJson.id}/activate`, {
    method: 'POST',
    headers,
  });
  if (!activated.ok) throw new Error(`激活压测库失败 HTTP ${activated.status}`);
  // 建库响应只回 id，库目录要回列表里取（与界面同一条路径）
  const list = await (await fetch(`${BASE}/api/libraries`, { headers })).json();
  const lib = (list.libraries || []).find((l) => l.id === createdJson.id);
  if (!lib) throw new Error('建库后列表里找不到这个库');
  const dbFile = path.join(lib.path, 'gallery.db');
  if (!fs.existsSync(dbFile)) throw new Error(`没找到库文件 ${dbFile}`);

  // 先停服再灌数：不停的话 fs.watch 会把「库变了」当成导入信号，
  // 后台缩略图队列对着不存在的素材疯狂重试，把要测的接口一起拖垮。
  await stopServer();
  console.log(`[bench] 灌 ${ROWS.toLocaleString('en-US')} 行…`);
  const t0 = performance.now();
  db = seed(dbFile, ROWS);
  const seedMs = performance.now() - t0;
  console.log(`[bench] 灌库完成 ${(seedMs / 1000).toFixed(1)}s（${Math.round(ROWS / (seedMs / 1000))} 行/秒）`);

  // 灌完再起一次（同一 user data → 同一活动库与令牌）
  if (!(await startServer())) throw new Error('灌数后服务没起来：' + serverLog.slice(-800));

  // 先确认服务真的看到这些行：否则「1ms 全绿」可能是在空库上跑出来的假绿灯
  const statsJson = await (await fetch(`${BASE}/api/stats`, { headers })).json();
  // 顺带预热标签计数快照：下面「缓存」那一行要量的是稳定态，不是首次重算
  await fetch(`${BASE}/api/tags`, { headers });
  const total = Number(statsJson?.total ?? statsJson?.counts?.images ?? 0);
  if (total < ROWS) {
    throw new Error(`服务只看到 ${total} 行（期望 ${ROWS}）—— 库没切到压测库，基准结论无效`);
  }

  // 让服务看到新数据：列表与统计都是实时查，不重启
  const deepPage = Math.max(1, Math.floor(ROWS / 100) - 1);
  console.log(`[bench] 采样 ${SAMPLES} 次/接口：`);
  report('列表首页 pageSize=100', await timed(`${BASE}/api/images?page=1&pageSize=100&sort=newest`, headers, SAMPLES), 200);
  report(
    `列表深页 page=${deepPage}`,
    await timed(`${BASE}/api/images?page=${deepPage}&pageSize=100&sort=newest`, headers, SAMPLES),
    400
  );
  report('关键词搜索 q=shadow', await timed(`${BASE}/api/images?q=shadow&page=1&pageSize=100`, headers, SAMPLES), 500);
  report('标签筛选 tag=bench-tag（10%）', await timed(`${BASE}/api/images?tag=bench-tag&page=1&pageSize=100`, headers, SAMPLES), 500);
  // 50% 覆盖的标签：真实场景里出现在「给一批图统一打标」之后，规模一上去就是 O(命中行数)，
  // 这里只记录斜率，不设门槛（硬设门槛等于逼着去优化一个不该出现的高频路径）
  report(
    '标签筛选 tag=alpha（50%，仅记录）',
    await timed(`${BASE}/api/images?tag=alpha&page=1&pageSize=100`, headers, SAMPLES),
    null
  );
  report('收藏筛选 favorite=1', await timed(`${BASE}/api/images?favorite=1&page=1&pageSize=100`, headers, SAMPLES), 300);
  report('标签列表 /api/tags（缓存）', await timed(`${BASE}/api/tags`, headers, SAMPLES), 300);
  // ?fresh=1 是真实重算：标签计数按「写入行数指纹」缓存，任何写都会让它下一次重算
  report(
    '标签列表 /api/tags（重算）',
    await timed(`${BASE}/api/tags?fresh=1`, headers, SAMPLES),
    ROWS <= 250000 ? 1200 : null
  );
  // 统计：界面走缓存（5s TTL），?fresh=1 是真实冷查询。冷路径本身是 O(n) 全表聚合，
  // 20 万行以内设门槛；跑百万时只记录数字，不假装它还能压到毫秒级。
  report('统计 /api/stats（缓存）', await timed(`${BASE}/api/stats`, headers, SAMPLES), 150);
  report(
    '统计 /api/stats（冷查询）',
    await timed(`${BASE}/api/stats?fresh=1`, headers, SAMPLES),
    ROWS <= 250000 ? 1500 : null
  );

  // 到这里 HTTP 部分已经测完：停服，让下面的前端渲染与 CLIP 索引独占库文件
  await stopServer();
  await benchTone();
  await benchClip();

  const failed = rowsOut.filter((r) => !r.ok);
  console.log(
    `[bench] ${rowsOut.length - failed.length}/${rowsOut.length} 项达标` +
      (failed.length ? `；超标：${failed.map((f) => f.name).join('、')}` : '')
  );
  cleanup();
  process.exit(failed.length ? 1 : 0);
} catch (err) {
  console.error('[bench] 失败：', err instanceof Error ? err.message : err);
  if (serverLog) console.error('[bench] 服务日志尾部：\n' + serverLog.slice(-1500));
  cleanup();
  process.exit(1);
}
