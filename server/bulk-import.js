import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import { db, getSettings, getThumbDir, getLibraryGeneration, withTransaction } from './db.js';
import { listRules, scoreImage } from './kb.js';
import {
  indexPhash,
  buildFileName,
  resolveStorageDir,
  findDuplicateByPhash,
  toDTO,
  getImage,
  KEEP_REASONS,
  ALLOWED_FORMATS,
} from './library.js';
import { ensureFolderByRelDir, linkImageByPath } from './folders.js';
import { ingestMedia, isMediaPath, MEDIA_EXTS } from './lib/media.js';
import { shouldSkipDir } from './lib/skip-dirs.js';
import { thumbPathFor } from './thumbs.js';
import * as clip from './clip.js';

/**
 * 大规模本地导入流水线（面向十万 / 百万级图库）。
 *
 * 旧实现（importer.importFiles + library.ingest）的瓶颈，逐条对应现在的做法：
 *  1. 每张图解码 3 次（缩略图 / pHash / 主色各一次）
 *     → worker 里只解码一次，pHash 与主色都从缩略图像素派生（见 media-worker.js）。
 *  2. 解码/编码全在 HTTP 主线程上跑 → 导入期间 API 全卡（实测 p95 150ms）
 *     → CPU 活全部搬进 worker_threads 池（默认 CPU 核数 - 1，上限 8），主线程只做 SQLite。
 *  3. 每张图一个隐式事务 + 每次 db.prepare() 重新编译语句
 *     → 预编译语句复用 + 每批一个事务（WAL 下批量提交近似一次 fsync）。
 *  4. 每次入库都查一次评分规则表（scoreImage 默认参数会 listRules()）
 *     → 规则只在任务开始时读一次。
 *  5. 每次入库都触发 CLIP 重新建模（reembed 是异步点火，百万张会堆积上百万次推理）
 *     → 批量导入不建模，交给已有的 CLIP 补算任务（backfill）后台跑。
 *  6. 每次扫盘都要把整个 images 表拉出来比对（SELECT abs_path 全表）
 *     → 分片 IN 查询，并记录 size + mtime：内容没变的文件直接跳过（增量扫描秒级完成）。
 *
 * 分两阶段写库：先批量 INSERT 拿到 id（前端立刻能看到图，缩略图随后补上），
 * 再批量 UPDATE 回填宽高 / 缩略图 / pHash / 主色 / 评分。
 * 缩略图文件名是 `${id}.jpg`，所以必须先有 id —— 这也是必须分两阶段的原因。
 */

const EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', ...[...MEDIA_EXTS].map((e) => `.${e}`)]);
// 排除表（thumbs / .tuku / .library …）统一在 lib/skip-dirs.js，别再本地复制一份：
// 之前这里和 importer.js 各有一份，加 .tuku 时漏掉了真正干活的那一份
const DEFAULT_MAX_DEPTH = 4;

/**
 * 目录遍历深度上限：设置项 importMaxDepth 可调（默认 4 层，保持老行为）。
 * 以前写死 4：素材放得深一点就整批没人扫，而且界面上什么提示都没有——
 * 用户只知道"导入完少了一半图"。
 */
function resolveMaxDepth() {
  const v = Number(getSettings().importMaxDepth);
  return Number.isFinite(v) && v > 0 ? Math.min(16, Math.floor(v)) : DEFAULT_MAX_DEPTH;
}

const CHUNK = 400;       // 每批发现 / 查询 / 提交的文件数
const QUERY_CHUNK = 400; // 单条 IN 查询的路径数
const FLUSH_SIZE = 64;   // 积累多少条派生结果就回填一次
const FLUSH_MS = 400;    // 或最多等多久就回填一次
// 单张图派给 worker 的超时上限（大图 / 巨型 RAW 解码可能很慢，但卡住必须有出口）
const MEDIA_JOB_TIMEOUT = 120000;

/**
 * 清理缩略图目录里的写入残留。
 * 缩略图是「先写 .tmp 再改名」，进程在写的过程中被强杀就会留下一堆 .tmp-xxx 文件，
 * 永远没人收拾（还会让 thumbs 目录越来越脏）。启动时扫一遍即可。
 * 缩略图分桶后残片可能落在桶目录里，需递归（深度只有两层：thumbs/xx/）。
 */
export async function sweepThumbTemp(thumbDir = getThumbDir()) {
  const sweep = async (dir, depth) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在等情况直接跳过
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) await sweep(full, depth + 1);
        continue;
      }
      if (entry.name.includes('.tmp-')) await fsp.rm(full, { force: true }).catch(() => {});
    }
  };
  await sweep(thumbDir, 0);
}

export function mediaPoolSize() {
  const cpus = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  // 留一个核给 HTTP / SQLite；上限 8 是内存与磁盘 IO 的折中（libvips 每个 worker 自带缓存）
  return Math.max(2, Math.min(8, cpus - 1));
}

/* ----------------------------- worker 池 ----------------------------- */

class MediaPool {
  constructor(size) {
    this.size = size;
    this.slots = [];
    this.queue = [];
    this.seq = 0;
  }

  _spawn() {
    const worker = new Worker(new URL('./media-worker.js', import.meta.url));
    const slot = { worker, busy: false, current: null, dead: false };
    worker.on('message', (msg) => {
      const job = slot.current;
      slot.current = null;
      slot.busy = false;
      if (job) job.resolve(msg);
      this._pump();
    });
    worker.on('error', (err) => {
      const job = slot.current;
      slot.current = null;
      slot.busy = false;
      slot.dead = true;
      // worker 崩了不能让整批导入悬住：按失败返回，后续任务交给别的 slot
      if (job) job.resolve({ seq: job.seq, ok: false, error: String(err?.message || err) });
      worker.terminate().catch(() => {});
      this._pump();
    });
    worker.on('exit', () => {
      slot.dead = true;
    });
    return slot;
  }

  _take() {
    for (const s of this.slots) if (!s.busy && !s.dead) return s;
    // 崩掉的 slot 必须先剔出去：否则它一直占着名额，slots.length 到 size 后
    // 就再也不会补新 worker，8 个槽崩完队列再也派不出去 —— 导入会静默挂死。
    if (this.slots.some((s) => s.dead)) {
      this.slots = this.slots.filter((s) => !s.dead);
      const s = this._spawn();
      this.slots.push(s);
      return s;
    }
    if (this.slots.length < this.size) {
      const s = this._spawn();
      this.slots.push(s);
      return s;
    }
    return null;
  }

  _pump() {
    while (this.queue.length) {
      const slot = this._take();
      if (!slot) return; // 池满，等有 worker 回来
      const job = this.queue.shift();
      slot.busy = true;
      slot.current = job;
      slot.worker.postMessage({ seq: job.seq, file: job.file, thumbPath: job.thumbPath });
    }
  }

  run(job) {
    return new Promise((resolve) => {
      const done = (res) => {
        clearTimeout(timer);
        resolve(res);
      };
      // 兜底超时：worker 可能被外部杀掉（OOM / 休眠唤醒）而拿不到 error 事件，
      // 没有超时的话这个 promise 永不 settle，整批导入会卡在 Promise.all 上不动
      const timer = setTimeout(() => {
        const qi = this.queue.indexOf(job);
        if (qi >= 0) {
          this.queue.splice(qi, 1); // 还没轮到它，直接撤单
        } else {
          const slot = this.slots.find((s) => s.current === job);
          if (slot) {
            slot.current = null;
            slot.busy = false;
            slot.dead = true;
            slot.worker.terminate().catch(() => {});
          }
        }
        done({ seq: job.seq, ok: false, error: '处理超时' });
        this._pump();
      }, MEDIA_JOB_TIMEOUT);
      job.seq = ++this.seq;
      job.resolve = done;
      this.queue.push(job);
      this._pump();
    });
  }

  async terminate() {
    // 队列里的任务先跑完（结果已经没人要，但不能把 worker 停在半路留下半个缩略图文件）。
    // 加时间上限：一旦有任务卡住，terminate 本身不能再无限等待。
    const deadline = Date.now() + 60000;
    while ((this.queue.length || this.slots.some((s) => s.busy)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    for (const s of this.slots) s.worker.terminate().catch(() => {});
    this.slots = [];
  }
}

/* --------------------------- 文件发现（流式） --------------------------- */

async function* walkChunks(dirs, chunkSize = CHUNK, onDepthSkip = null) {
  const maxDepth = resolveMaxDepth();
  const walk = async function* (list, depth) {
    if (depth > maxDepth) {
      // 不再静默丢弃：把被深度截断的目录报给调用方
      if (onDepthSkip) for (const d of list) onDepthSkip(d);
      return;
    }
    for (const dir of list) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const subDirs = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          // 排除表里除 thumbs / 回收站外，还包括 .tuku（库数据目录，默认就在素材
          // 文件夹里）和 .library（资产目录，*.info 是库内图片的副本，由导入到库自己登记）
          if (!shouldSkipDir(e.name)) subDirs.push(full);
          continue;
        }
        if (EXTS.has(path.extname(e.name).toLowerCase())) yield full;
      }
      if (subDirs.length) yield* walk(subDirs, depth + 1);
    }
  };
  let buf = [];
  for await (const file of walk(dirs, 0)) {
    buf.push(file);
    if (buf.length >= chunkSize) {
      yield buf;
      buf = [];
    }
  }
  if (buf.length) yield buf;
}

/* ------------------------------ 主流程 ------------------------------ */

export async function bulkImportLocal({
  dirs,
  keyword = '',
  onProgress = null,
  isCancelled = () => false,
} = {}) {
  const settings = getSettings();
  const generation = getLibraryGeneration();
  const rules = listRules(); // 评分规则只读一次（旧实现每张图查一次库）
  const thumbDir = getThumbDir();
  await fsp.mkdir(thumbDir, { recursive: true });

  const result = {
    total: 0, saved: 0, duplicate: 0, dropped: 0, errors: 0, cancelled: 0, unchanged: 0,
    /** 因为超过深度上限而没扫的目录（非空时前端要提示用户，不能假装导入完整） */
    depthSkippedDirs: [],
  };
  const pool = new MediaPool(mediaPoolSize());

  // 预编译语句复用（旧实现每张图 prepare 一次）
  const insStmt = db.prepare(
    `INSERT OR IGNORE INTO images (title, abs_path, thumb, source, keyword, source_url, width, height,
      size_bytes, mime, phash, favorite, tags, created_at, fs_mtime)
     VALUES (?, ?, NULL, ?, ?, '', 0, 0, ?, '', '', 0, '', ?, ?)`
  );
  const updStmt = db.prepare(
    `UPDATE images SET width = ?, height = ?, mime = ?, thumb = ?, phash = ?,
      dominant = ?, hue = ?, palette = ?, score = ?, score_reason = ?, fs_mtime = ? WHERE id = ?`
  );
  const delStmt = db.prepare('DELETE FROM images WHERE id = ?');
  const linkStmt = db.prepare(
    'INSERT OR IGNORE INTO image_folders(image_id, folder_id) VALUES (?, ?)'
  );
  // 分片查重语句只编译一次：占位符固定为整片长度（百万张 = 几千次查询，
  // 逐次 db.prepare 是纯浪费）；末尾不满一片的分片走临时语句。
  const knownStmt = db.prepare(
    `SELECT id, abs_path, size_bytes, fs_mtime, thumb FROM images WHERE abs_path IN (${Array(QUERY_CHUNK)
      .fill('?')
      .join(',')})`
  );

  const folderCache = new Map(); // 相对目录 -> folder id（百万张图往往只对应几百个目录）
  const now = new Date().toISOString();
  const folderOf = (file) => {
    const root = settings.storageDir || '';
    if (!root) return null;
    const rel = path.relative(root, path.dirname(file));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (folderCache.has(rel)) return folderCache.get(rel);
    const id = ensureFolderByRelDir(rel);
    folderCache.set(rel, id);
    return id;
  };

  let pending = [];
  let lastFlush = Date.now();
  let lastPush = 0;
  let finished = 0;
  let shownProgress = 0;

  const flush = () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    lastFlush = Date.now();
    // 切库保护：这批 id 属于「启动时那个库」。若期间切了库，db 已经指向新库，
    // 写下去就是把旧库的缩略图路径写进新库的行 —— 直接丢弃这批结果。
    if (generation !== getLibraryGeneration()) {
      result.cancelled += batch.length;
      for (const r of batch) fsp.rm(r.thumb, { force: true }).catch(() => {});
      return;
    }
    const deletes = [];
    try {
      // withTransaction 用 SAVEPOINT：与偏好训练/知识库重打分交叉时不会
      // 抛「cannot start a transaction within a transaction」而把整批吞成失败
      withTransaction(() => {
        for (const r of batch) {
          if (r.filtered) {
            deletes.push(r);
            continue;
          }
          updStmt.run(
            r.width, r.height, r.mime, r.thumb, r.phash,
            r.dominant, r.hue, r.palette, r.score, r.reasons, r.mtime, r.id
          );
          if (r.phash) indexPhash(r.id, r.phash);
          if (r.folderId) linkStmt.run(r.id, r.folderId);
        }
        for (const r of deletes) delStmt.run(r.id);
      });
    } catch (err) {
      console.error('[bulk] 批量回填失败', err?.message || err);
      result.errors += batch.length;
      // 回滚后这批「新登记」的行（update=false）没有 thumb 字段，缩略图文件却
      // 已落盘 —— 不清就是孤儿文件，中断重试几次就积一大片。重派生的行不动：
      // 磁盘上的新缩略图与旧行记录会由下一次增量扫描重新对齐
      for (const r of batch) {
        if (!r.update && !r.filtered) fsp.rm(r.thumb, { force: true }).catch(() => {});
      }
      return;
    }
    // 被评分规则拦下的：缩略图一并删掉
    for (const r of deletes) fsp.rm(r.thumb, { force: true }).catch(() => {});
    result.saved += batch.length - deletes.length;
    result.dropped += deletes.length;
  };

  for await (const chunk of walkChunks(dirs, CHUNK, (dir) => {
    if (result.depthSkippedDirs.length < 20) result.depthSkippedDirs.push(dir);
  })) {
    if (isCancelled() || generation !== getLibraryGeneration()) {
      result.cancelled += chunk.length;
      break;
    }

    // 0) 非图片素材（视频/音频/字体/PDF/Office/3D）不进 sharp 管线：
    //    直接登记，缩略图交给前端用 <video>/<audio>/@font-face 渲染
    const mediaFiles = chunk.filter((f) => isMediaPath(f));
    for (const f of mediaFiles) {
      result.total++;
      try {
        if (db.prepare('SELECT id FROM images WHERE abs_path = ?').get(f)) {
          result.unchanged++;
        } else {
          const r = await ingestMedia({ absPath: f, keyword: keyword || '壁纸库' });
          if (r.ok) result.saved++;
          else result.dropped++;
        }
      } catch {
        result.errors++;
      }
    }
    const images = mediaFiles.length ? chunk.filter((f) => !isMediaPath(f)) : chunk;
    if (!images.length) continue;

    // 1) 文件指纹（size + mtime）：内容没变的文件直接跳过，增量扫描几乎零成本
    const stats = await Promise.all(images.map((f) => fsp.stat(f).catch(() => null)));
    const meta = [];
    for (let i = 0; i < images.length; i++) {
      const st = stats[i];
      if (!st || !st.isFile()) continue;
      meta.push({ file: images[i], size: st.size, mtime: Math.round(st.mtimeMs / 1000) });
    }

    // 2) 分片查已登记的行（不再 SELECT abs_path 全表）
    const known = new Map();
    for (let i = 0; i < meta.length; i += QUERY_CHUNK) {
      const part = meta.slice(i, i + QUERY_CHUNK);
      const files = part.map((m) => m.file);
      const rows =
        part.length === QUERY_CHUNK
          ? knownStmt.all(...files) // 整片走预编译语句
          : db
              .prepare(
                `SELECT id, abs_path, size_bytes, fs_mtime, thumb FROM images WHERE abs_path IN (${files
                  .map(() => '?')
                  .join(',')})`
              )
              .all(...files);
      for (const r of rows) known.set(r.abs_path, r);
    }

    let work = [];
    for (const m of meta) {
      result.total++;
      const row = known.get(m.file);
      if (!row) {
        work.push({ ...m, update: false });
        continue;
      }
      const sameSize = Number(row.size_bytes) === m.size;
      const sameMtime = Number(row.fs_mtime || 0) === m.mtime;
      // 上次导入被中断时行已登记但缩略图还没生成：指纹相同也要补派生，
      // 否则这张图会永远没有缩略图（增量扫描会一直跳过它）
      if (sameSize && sameMtime && row.thumb) {
        result.unchanged++; // 已登记且文件未变：跳过（增量扫描）
        continue;
      }
      work.push({ ...m, id: row.id, update: true }); // 文件被改过 / 缺缩略图：重新派生
    }
    if (!work.length) {
      finished += meta.length;
      continue;
    }

    // 3) 批量 INSERT 先拿 id（缩略图文件名 = id.jpg），整批一个事务
    let dupSkipped = 0;
    try {
      withTransaction(() => {
        for (const m of work) {
          if (m.update) continue;
          // OR IGNORE：并发下同一路径已被别的流程登记，唯一索引会拦下这条
          const info = insStmt.run(
            path.basename(m.file), m.file, 'local', keyword || '壁纸库', m.size, now, m.mtime
          );
          if (info.changes) {
            m.id = Number(info.lastInsertRowid);
          } else {
            m.dup = true;
            dupSkipped++;
          }
        }
      });
    } catch (err) {
      console.error('[bulk] 批量登记失败', err?.message || err);
      result.errors += work.length;
      continue;
    }
    if (dupSkipped) {
      // 已由另一条链路登记：跳过派生，别用这次的扫描结果去覆盖别人刚写好的行
      work = work.filter((m) => !m.dup);
      if (!work.length) {
        finished += meta.length;
        continue;
      }
    }

    // 4) 派生资产交给 worker 池（解码 / 编码 / pHash / 主色），主线程只收结果
    await Promise.all(
      work.map((m) =>
        pool
          .run({ file: m.file, thumbPath: thumbPathFor(m.id) })
          .then((res) => {
            finished++;
            if (!res.ok) {
              result.errors++;
              return;
            }
            const width = Number(res.width) || 0;
            const height = Number(res.height) || 0;
            const format = (res.format || '').toLowerCase();
            const { score, reasons } = scoreImage(
              {
                source: 'local',
                keyword: keyword || '壁纸库',
                width,
                height,
                tags: '',
                phash: res.phash,
              },
              rules,
              ''
            );
            const filtered =
              settings.aiFilterEnabled !== false &&
              score < Number(settings.scoreThreshold) &&
              !m.update; // 已登记过的图不因评分被删（它当初已经通过了）
            pending.push({
              id: m.id,
              update: m.update, // 回滚清理时区分「新登记」与「重派生」（见 flush 的 catch）
              width,
              height,
              mime: `image/${format === 'jpg' ? 'jpeg' : format || 'jpeg'}`,
              thumb: res.thumb,
              phash: res.phash || '',
              dominant: res.dominant?.dominant || '',
              hue: res.dominant?.hue || '',
              palette: JSON.stringify(res.dominant?.palette || []),
              score,
              reasons: reasons.join('；'),
              mtime: m.mtime,
              folderId: folderOf(m.file),
              filtered,
            });
            if (pending.length >= FLUSH_SIZE || Date.now() - lastFlush >= FLUSH_MS) flush();
          })
      )
    );
    flush();

    // 文件是边发现边处理的，分母在扫描途中一直在涨 —— 直接用会让进度条忽进忽退。
    // 取历史最大值，保证单调前进（总量未知时的常见做法）。
    if (onProgress && Date.now() - lastPush >= 500) {
      lastPush = Date.now();
      const pct = Math.min(99, Math.round((finished / Math.max(1, result.total)) * 100));
      shownProgress = Math.max(shownProgress, pct);
      onProgress(shownProgress, chunk[chunk.length - 1], result);
    }
  }

  await pool.terminate();
  flush();
  if (result.depthSkippedDirs.length) {
    console.warn(
      `[import] ${result.depthSkippedDirs.length} 个目录超过深度上限（${resolveMaxDepth()} 层）已跳过：`,
      result.depthSkippedDirs.slice(0, 5).join(' | ')
    );
  }
  if (onProgress) onProgress(100, '', result);
  return result;
}

/* ------------------- 采集批量入库（爬虫 / 浏览器插件） ------------------- */

/**
 * 采集场景的批量入库：输入是「网络下载到的 buffer + 元数据」，与 bulkImportLocal
 * 共享同一套 worker 池与批量写库模式。旧路径（crawler 逐条调 library.ingest）的瓶颈：
 *  - 每张图在 HTTP 主线程解码 3 次（metadata / ensureThumb / computePHash）
 *  - 每张图一个独立事务、一次评分规则查询
 *  - 主线程 decode 峰值把 API 拖到 p95 150ms+
 * 现在的流程（每批）：
 *  1. 廉价预检：字节数上下限 + sharp 读文件头（格式 / 宽高 / 分辨率下限）→ 拒绝的不落盘
 *  2. 原图落盘（采集语义：素材进 storage 目录，文件名可读）
 *  3. 批量 INSERT 拿 id（整批一个事务）
 *  4. worker 池派生（每张图只解码一次：缩略图 + pHash + 主色）
 *  5. 回填（整批一个事务）：pHash 查重 / CLIP 查重 / 评分过滤，命中的删行删文件；
 *     存活的回填派生字段 + 建 pHash 索引 + 归夹
 * CLIP 建模不逐张点火（与 bulkImportLocal 一致），交给已有的补算任务后台覆盖；
 * 但 CLIP 查重保留（第二道防线，挡 pHash 挡不住的裁剪/旋转/滤镜重复）。
 *
 * @param {Array<{buffer: Buffer, source?: string, keyword?: string, sourceUrl?: string, title?: string, tags?: string}>} items
 * @param {{ onEach?: (index: number, result: object) => void, libGeneration?: number|null }} opts
 * @returns {Promise<{total: number, saved: number, duplicate: number, dropped: number, failed: number}>}
 */
export async function bulkIngestBuffers(items, { onEach = null, libGeneration = null } = {}) {
  const settings = getSettings();
  const generation = libGeneration ?? getLibraryGeneration();
  const rules = listRules();
  const minBytes = Number(settings.minFileSize) * 1024;
  const maxBytes = Number(settings.maxFileSize) * 1024 * 1024;
  const minLong = Number(settings.minResolution);
  const phashThreshold = Number(settings.phashThreshold);

  const result = { total: items.length, saved: 0, duplicate: 0, dropped: 0, failed: 0 };
  const report = (i, r) => onEach && onEach(i, r);

  /* 1) 预检（只读文件头，失败/不合格的直接拒绝，不占 worker） */
  const accepted = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const buffer = it.buffer;
    if (!buffer || !buffer.length) {
      result.failed++;
      report(i, { ok: false, reason: KEEP_REASONS.failed });
      continue;
    }
    if (buffer.length < minBytes) {
      result.dropped++;
      report(i, { ok: false, reason: KEEP_REASONS.tooLight });
      continue;
    }
    if (buffer.length > maxBytes) {
      result.dropped++;
      report(i, { ok: false, reason: KEEP_REASONS.tooLarge });
      continue;
    }
    let meta;
    try {
      meta = await sharp(buffer, { failOn: 'none' }).metadata();
    } catch {
      result.dropped++;
      report(i, { ok: false, reason: KEEP_REASONS.badFormat });
      continue;
    }
    const format = (meta.format || '').toLowerCase();
    const width = meta.width || 0;
    const height = meta.height || 0;
    if (!ALLOWED_FORMATS.has(format) || !width || !height) {
      result.dropped++;
      report(i, { ok: false, reason: KEEP_REASONS.badFormat });
      continue;
    }
    if (Math.max(width, height) < minLong) {
      result.dropped++;
      report(i, { ok: false, reason: KEEP_REASONS.tooSmall });
      continue;
    }
    accepted.push({ i, it, buffer, format, width, height });
  }

  if (!accepted.length || generation !== getLibraryGeneration()) {
    // 切库保护：预检通过的也不能入库，按取消处理
    for (const a of accepted) {
      result.failed++;
      report(a.i, { ok: false, reason: KEEP_REASONS.cancelled });
    }
    return result;
  }

  /* 2) 原图落盘（可读文件名，重名加随机后缀） */
  const storageDir = resolveStorageDir(settings);
  await fsp.mkdir(storageDir, { recursive: true });
  for (const a of accepted) {
    const name = buildFileName({
      keyword: a.it.keyword,
      source: a.it.source,
      width: a.width,
      height: a.height,
      format: a.format,
    });
    let finalPath = path.join(storageDir, name);
    if (fs.existsSync(finalPath)) {
      finalPath = path.join(storageDir, name.replace(/(\.\w+)$/, `_${crypto.randomBytes(2).toString('hex')}$1`));
    }
    try {
      await fsp.writeFile(finalPath, a.buffer);
      a.finalPath = finalPath;
      a.size = a.buffer.length;
    } catch (err) {
      result.failed++;
      report(a.i, { ok: false, reason: KEEP_REASONS.failed, error: err?.message });
    }
  }
  const writable = accepted.filter((a) => a.finalPath);
  if (!writable.length) return result;

  /* 3) 批量 INSERT 拿 id（整批一个事务） */
  const insStmt = db.prepare(
    `INSERT OR IGNORE INTO images (title, abs_path, thumb, source, keyword, source_url, width, height,
      size_bytes, mime, phash, favorite, tags, created_at, fs_mtime)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?, 0)`
  );
  try {
    withTransaction(() => {
      for (const a of writable) {
        const info = insStmt.run(
          a.it.title || path.basename(a.finalPath),
          a.finalPath,
          a.it.source || 'local',
          a.it.keyword || '',
          a.it.sourceUrl || '',
          a.width,
          a.height,
          a.size,
          `image/${a.format === 'jpg' ? 'jpeg' : a.format}`,
          a.it.tags || '',
          new Date().toISOString()
        );
        if (info.changes) a.id = Number(info.lastInsertRowid);
        // 唯一索引拦下的（并发重复登记）：原图不能删，交给下面的重复计数
      }
    });
    for (let i = writable.length - 1; i >= 0; i--) {
      if (!writable[i].id) {
        writable.splice(i, 1);
        result.duplicates = (result.duplicates || 0) + 1;
      }
    }
  } catch (err) {
    console.error('[bulk] 采集批量登记失败', err?.message || err);
    // 登记失败：原图已落盘的清掉，避免孤儿文件
    for (const a of writable) {
      result.failed++;
      if (a.finalPath) fsp.rm(a.finalPath, { force: true }).catch(() => {});
      report(a.i, { ok: false, reason: KEEP_REASONS.failed, error: err?.message });
    }
    return result;
  }

  /* 4) worker 池派生（每张图唯一一次整图解码） */
  const pool = new MediaPool(mediaPoolSize());
  await Promise.all(
    writable.map((a) =>
      pool
        .run({ file: a.finalPath, thumbPath: thumbPathFor(a.id) })
        .then((res) => {
          if (!res.ok) {
            result.failed++;
            a.deriveError = res.error;
            return;
          }
          a.derived = res;
        })
        .catch((err) => {
          result.failed++;
          a.deriveError = String(err?.message || err);
        })
    )
  );
  await pool.terminate();

  /* 5) 回填：查重 / 评分 / 删行 / 更新（整批一个事务 + 事务外的查重决策） */
  const updStmt = db.prepare(
    `UPDATE images SET width = ?, height = ?, mime = ?, thumb = ?, phash = ?,
      dominant = ?, hue = ?, palette = ?, score = ?, score_reason = ? WHERE id = ?`
  );
  const delStmt = db.prepare('DELETE FROM images WHERE id = ?');

  const kills = []; // 查重/评分命中的：删行删文件
  const keeps = []; // 存活的：回填派生字段
  for (const a of writable) {
    if (a.deriveError) {
      kills.push(a);
      continue;
    }
    const res = a.derived;
    // pHash 查重（采集语义：命中撤销入库）
    if (res.phash) {
      const dupId = findDuplicateByPhash(res.phash, phashThreshold);
      if (dupId) {
        a.dupId = dupId;
        kills.push(a);
        continue;
      }
    }
    // CLIP 查重（第二道防线；模型未就绪时跳过，补算任务会补上向量）
    if (clip.clipReady()) {
      try {
        const vec = await clip.embedImage(a.finalPath);
        const dup = await clip.topSimilar(vec, { k: 1, minCos: 0.965, excludeId: a.id });
        if (dup.length) {
          a.dupId = dup[0].id;
          a.clipCos = dup[0].cos;
          kills.push(a);
          continue;
        }
      } catch (err) {
        console.error('[clip] 采集批量查重失败（忽略）', a.finalPath, err?.message || err);
      }
    }
    const { score, reasons } = scoreImage(
      { source: a.it.source, keyword: a.it.keyword, width: res.width, height: res.height, tags: a.it.tags || '', phash: res.phash },
      rules,
      ''
    );
    a.score = score;
    a.reasons = reasons;
    if (settings.aiFilterEnabled !== false && score < Number(settings.scoreThreshold)) {
      kills.push(a);
      continue;
    }
    keeps.push(a);
    // 存活即入内存索引：同一批内后续条目才能被 pHash 查重拦下（批内互查）。
    // 极端情况（回填事务失败回滚）索引会留下幽灵 hash，只会误杀后续相似图，可接受
    if (res.phash) indexPhash(a.id, res.phash);
  }

  // 删除与回填分别整批一个事务
  try {
    withTransaction(() => {
      for (const a of kills) delStmt.run(a.id);
      for (const a of keeps) {
        const res = a.derived;
        updStmt.run(
          res.width,
          res.height,
          `image/${(res.format || a.format).toLowerCase() === 'jpg' ? 'jpeg' : (res.format || a.format).toLowerCase()}`,
          res.thumb,
          res.phash || '',
          res.dominant?.dominant || '',
          res.dominant?.hue || '',
          JSON.stringify(res.dominant?.palette || []),
          a.score || 0,
          (a.reasons || []).join('；'),
          a.id
        );
      }
    });
  } catch (err) {
    console.error('[bulk] 采集批量回填失败', err?.message || err);
    // 回滚后 keeps 的行没有派生字段、缩略图却已落盘 —— 清理孤儿缩略图
    for (const a of keeps) fsp.rm(a.derived?.thumb, { force: true }).catch(() => {});
    result.failed += kills.length + keeps.length;
    for (const a of [...kills, ...keeps]) {
      report(a.i, { ok: false, reason: KEEP_REASONS.failed, error: err?.message });
    }
    return result;
  }

  // 事务外的收尾：文件清理 / 内存索引 / 归夹 / 结果回报
  for (const a of kills) {
    if (a.derived?.thumb) fsp.rm(a.derived.thumb, { force: true }).catch(() => {});
    fsp.rm(a.finalPath, { force: true }).catch(() => {});
    if (a.dupId) {
      result.duplicate++;
      report(a.i, { ok: false, reason: KEEP_REASONS.duplicate, duplicateOf: a.dupId, clipCos: a.clipCos });
    } else {
      result.dropped++;
      report(a.i, { ok: false, reason: a.score != null ? KEEP_REASONS.aiFilter : KEEP_REASONS.failed, score: a.score, reasons: a.reasons });
    }
  }
  for (const a of keeps) {
    try {
      linkImageByPath(a.id, a.finalPath, settings.storageDir);
    } catch {
      /* 建树失败不影响入库 */
    }
    result.saved++;
    report(a.i, { ok: true, id: a.id, image: toDTO(getImage(a.id)) });
  }
  return result;
}

