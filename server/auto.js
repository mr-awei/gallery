import { db, getSettings, saveSettings } from './db.js';
import * as wallpaper from './wallpaper.js';
import { listMonitors, isFullscreenAppRunning } from './desktop.js';
import * as fit from './wallpaper-fit.js';
import * as kb from './kb.js';
import * as lib from './library.js';
import * as pref from './preference.js';

/**
 * 定时自动切换壁纸
 * 范围：全库 / 收藏 / 指定清单；周期：每天 / 每周 / 每月 / 自定义间隔
 */

const TICK_MS = 30 * 1000;
let timer = null;

function parseTime(str) {
  const [h, m] = String(str || '09:00').split(':');
  return { hour: Math.max(0, Math.min(23, Number(h) || 9)), minute: Math.max(0, Math.min(59, Number(m) || 0)) };
}

/** 计算下一次执行时间 */
export function computeNextRun(cfg = getSettings().autoWallpaper, from = new Date()) {
  if (!cfg || !cfg.enabled) return null;
  const { mode, atTime, weekday, dayOfMonth, minutes, lastRunAt } = cfg;
  const last = lastRunAt ? new Date(lastRunAt).getTime() : 0;
  const { hour, minute } = parseTime(atTime);

  if (mode === 'custom') {
    const gap = Math.max(1, Number(minutes) || 60) * 60 * 1000;
    const base = lastRunAt ? new Date(lastRunAt) : new Date(from.getTime() + gap);
    let next = new Date(base.getTime() + gap);
    while (next <= from) next = new Date(next.getTime() + gap);
    return next;
  }

  if (mode === 'week') {
    // weekday: 1=周一 … 7=周日 → JS getDay(): 0=周日
    const want = (Number(weekday) || 1) % 7;
    const next = new Date(from);
    next.setHours(hour, minute, 0, 0);
    next.setDate(next.getDate() + ((want - next.getDay() + 7) % 7));
    // 已过点或本轮已执行过 → 顺延一周（保证「错过仍会补切」）
    if (next.getTime() <= from.getTime() || next.getTime() <= last) next.setDate(next.getDate() + 7);
    return next;
  }

  if (mode === 'month') {
    const day = Math.max(1, Math.min(28, Number(dayOfMonth) || 1));
    let next = new Date(from.getFullYear(), from.getMonth(), day, hour, minute, 0, 0);
    if (next.getTime() <= from.getTime() || next.getTime() <= last) {
      next = new Date(from.getFullYear(), from.getMonth() + 1, day, hour, minute, 0, 0);
    }
    return next;
  }

  // 每天：目标是「今天 hour:minute」；只有当它已到点且本轮尚未执行过（> last）才返回过去的时间点，
  // 供调度器立即补切（此前实现把它直接推到明天，导致每天/每周/每月模式实际永不触发）
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() > from.getTime() || next.getTime() <= last) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function scopeQuery(scope, playlistId) {
  if (scope === 'favorites') return { sql: 'SELECT id FROM images WHERE favorite = 1', params: [] };
  if (scope === 'playlist' && playlistId) {
    return {
      sql: 'SELECT image_id AS id FROM playlist_items WHERE playlist_id = ? AND EXISTS (SELECT 1 FROM images WHERE images.id = playlist_items.image_id)',
      params: [Number(playlistId)],
    };
  }
  return { sql: 'SELECT id FROM images', params: [] };
}

/**
 * 从范围内挑一张。
 * order: random 等概率随机 / sequential 按入库顺序轮换 / smart 按 AI 评分加权随机
 * 另外支持 minScore（低于该分数不选）与 excluded（用户点过「不喜欢」的图不再出现）
 */
export async function pickImage(cfg) {
  const id = await pickOnce(cfg);
  if (id != null) return id;
  // 「不喜欢」记录是把双刃剑：库里只有几张图时，点几下就把候选吃干净了，
  // 之后每次「换一张」都只能报「该范围内没有可用图片」。排到空就清空重来。
  if (Array.isArray(cfg.excluded) && cfg.excluded.length) {
    console.warn('[auto] 候选被「不喜欢」记录排空，已清空排除列表重选');
    cfg.excluded = [];
    return pickOnce(cfg);
  }
  return id;
}

async function pickOnce(cfg) {
  const { scope, playlistId, order } = cfg;
  const { sql, params } = scopeQuery(scope, playlistId);
  const where = [`i.id IN (${sql})`];
  const args = [...params];

  const minScore = Math.max(0, Number(cfg.minScore) || 0);
  if (minScore > 0) {
    where.push('i.score >= ?');
    args.push(minScore);
  }
  const excluded = (Array.isArray(cfg.excluded) ? cfg.excluded : []).map(Number).filter(Boolean).slice(-200);
  if (excluded.length) {
    where.push(`i.id NOT IN (${excluded.map(() => '?').join(',')})`);
    args.push(...excluded);
  }
  const base = `SELECT i.id AS id, i.score AS score FROM images i WHERE ${where.join(' AND ')}`;

  if (order === 'sequential') {
    const total = db.prepare(`SELECT COUNT(*) AS c FROM (${base})`).get(...args).c;
    if (!total) return null;
    const index = (Number(cfg.cursor) || 0) % total;
    const row = db.prepare(`SELECT id FROM (${base}) ORDER BY id ASC LIMIT 1 OFFSET ?`).get(...args, index);
    cfg.cursor = index + 1;
    return row ? row.id : null;
  }

  if (order === 'smart' || order === 'ai') {
    // 评分加权随机：分数越高越容易被抽中，但低分图仍有露面机会（避免总是同几张）
    const rows = db.prepare(base).all(...args);
    if (!rows.length) return null;
    const useFit = order === 'ai' && cfg.useAiFit !== false;

    // 候选先按知识库评分粗筛，只对头部算适配度（适配度要读图，全库算太慢）
    const CANDIDATES = 48;
    let pool = rows;
    if (useFit) {
      pool = [...rows].sort((a, b) => Number(b.score) || 0 - (Number(a.score) || 0)).slice(0, CANDIDATES);
      await Promise.all(pool.map((r) => fit.ensureFit(r.id, { useAi: true }).catch(() => null)));
    }
    const hour = new Date().getHours();
    const wantDark = cfg.useTimeAware !== false && (hour >= 21 || hour < 6); // 夜间偏好暗色
    // 个人偏好模型没训练时 pref 全是 50，把它按 0.25 混进去只是个常数偏移
    // （等价于 score*0.4+33.5），看着像「智能」其实排序完全由规则分决定。
    // 未训练就不参与，然后把剩余权重归一化，保证「说的和算的一致」。
    const prefTrained = pref.prefStatus().trained;
    const weights = pool.map((r) => {
      let w = Math.max(0, Number(r.score) || 0);
      if (useFit) {
        const f = fit.getFit(r.id);
        const fs = f ? Number(f.score) || 60 : 60;
        const parts = [
          { w: 0.4, v: w },
          { w: 0.35, v: fs },
        ];
        if (prefTrained) parts.push({ w: 0.25, v: pref.prefScore(r.id) });
        const sumW = parts.reduce((a, p) => a + p.w, 0);
        w = parts.reduce((a, p) => a + p.w * p.v, 0) / sumW; // 知识库评分 / 壁纸适配度 [/ 个人偏好]
        // 用户反馈纠偏：被点过「不喜欢」的图大幅降权，点过「喜欢」的加一点
        if (f) {
          w -= Math.min(40, (f.dislikes || 0) * 14);
          w += Math.min(12, (f.likes || 0) * 4);
        }
        if (wantDark && f && typeof f.brightness === 'number') {
          // 夜间：越暗越合适（亮度 0-255，理想 40-110）
          const dist = Math.abs(f.brightness - 75);
          w += Math.max(0, 10 - dist / 6);
        } else if (!wantDark && f && typeof f.brightness === 'number') {
          const dist = Math.abs(f.brightness - 150);
          w += Math.max(0, 8 - dist / 8);
        }
      }
      // +8 是「保底权重」，避免 0 分图被数学上彻底排除；平方让高分优势明显
      return (Math.max(0, w) + 8) ** 2;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let x = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      x -= weights[i];
      if (x <= 0) return pool[i].id;
    }
    return pool[pool.length - 1].id;
  }

  const row = db.prepare(`${base} ORDER BY RANDOM() LIMIT 1`).get(...args);
  return row ? row.id : null;
}

/** 多屏模式：给其余屏幕各挑一张不同的图（最多重试几次避免重复） */
async function pickExtraIds(cfg, count, used) {
  const out = [];
  for (let i = 0; i < count; i++) {
    let pick = null;
    for (let t = 0; t < 6 && !pick; t++) {
      const cand = await pickImage({ ...cfg, order: cfg.order === 'sequential' ? 'random' : cfg.order });
      if (cand && !used.has(cand)) pick = cand;
    }
    if (pick) used.add(pick);
    out.push(pick);
  }
  return out;
}

/** 立即切换一张（按当前配置的范围） */
export async function applyNow(scopeOverride = null, playlistIdOverride = null) {
  const settings = getSettings();
  const current = settings.autoWallpaper || {};
  const cfg = {
    ...current,
    scope: scopeOverride || current.scope || 'all',
    playlistId: playlistIdOverride ?? current.playlistId,
  };
  const imageId = await pickImage(cfg);
  if (!imageId) throw new Error('该范围内没有可用图片');

  // 闭环：抽到的图低于画质标准时，先自动增强再设为壁纸（可选开关）
  if (cfg.autoEnhance === true) {
    const std = settings.enhance?.standard || '1080p';
    const target = lib.getStandardResolution(std, settings.enhance || {});
    const row0 = db.prepare('SELECT id, width, height, title FROM images WHERE id = ?').get(imageId);
    if (row0 && (row0.width < target.width || row0.height < target.height)) {
      try {
        const model = settings.enhance?.model || 'sharp-standard';
        const result = await lib.enhanceImage(imageId, model, { standard: std });
        // 已达标（noop）时文件没变，别记成「已增强」
        if (!result?.noop) console.log('[auto] 已自动增强候选壁纸：', row0.title);
      } catch (err) {
        console.error('[auto] 自动增强失败，按原图使用：', err?.message || err);
      }
    }
  }

  // 多屏模式：其余屏幕各配一张不同的图
  const mode = settings.wallpaperMode || 'single';
  let ids = null;
  if (mode === 'per-monitor' && current.perMonitorDifferent !== false) {
    const monitors = await listMonitors().catch(() => []);
    if (monitors.length > 1) {
      const used = new Set([imageId]);
      const extra = pickExtraIds(cfg, monitors.length - 1, used);
      ids = [imageId, ...extra.map((x) => x || imageId)];
    }
  }

  const row = db.prepare('SELECT id, title FROM images WHERE id = ?').get(imageId);
  const result = await wallpaper.applyWallpaper(imageId, { mode, ids });
  const nowIso = new Date().toISOString();

  db.prepare('INSERT INTO wallpaper_log(image_id, scope, title, applied_at) VALUES (?, ?, ?, ?)').run(
    imageId,
    cfg.scope,
    row?.title || '',
    nowIso
  );
  db.prepare('DELETE FROM wallpaper_log WHERE id NOT IN (SELECT id FROM wallpaper_log ORDER BY id DESC LIMIT 30)').run();

  saveSettings({
    autoWallpaper: {
      ...current,
      scope: cfg.scope,
      playlistId: cfg.playlistId,
      cursor: cfg.cursor ?? current.cursor ?? 0,
      // pickImage 排空后会把 excluded 就地清空，这里跟着落盘，否则下次还从满列表开始
      excluded: cfg.excluded ?? current.excluded ?? [],
      lastRunAt: nowIso,
      lastImageId: imageId,
    },
  });

  return { imageId, title: row?.title || '', ...result, appliedAt: nowIso };
}

/**
 * 挑选策略「实际会用到什么」——纯描述，不参与计算。
 *
 * 前端选项文案一直是「AI 智能适配」，但这条链路里没有任何 AI：
 * 适配度是本地启发式（留白/亮度/对比/复杂度），个人偏好模型未训练时也不参与。
 * 这里把真实参与项列出来，让设置页照实展示，而不是按名字猜。
 */
export function pickPlan(cfg = getSettings().autoWallpaper || {}) {
  const order = cfg.order || 'smart';
  if (order === 'random') {
    return { order, engine: 'random', label: '等概率随机', parts: ['random'] };
  }
  if (order === 'sequential') {
    return { order, engine: 'sequential', label: '按入库顺序轮换', parts: ['sequential'] };
  }
  const useFit = order === 'ai' && cfg.useAiFit !== false;
  const trained = pref.prefStatus().trained;
  const parts = ['score'];
  if (useFit) parts.push('fit');
  if (useFit && trained) parts.push('pref');
  return {
    order,
    engine: parts.join('+'),
    label: useFit
      ? `知识库评分 + 本地适配度${trained ? ' + 个人偏好模型' : ''}`
      : `知识库评分${trained ? ' + 个人偏好模型' : ''}（未启用适配度）`,
    parts,
    prefTrained: trained,
  };
}

export function getAutoStatus() {
  const cfg = getSettings().autoWallpaper || {};
  const next = computeNextRun(cfg);
  const { sql, params } = scopeQuery(cfg.scope, cfg.playlistId);
  const count = db.prepare(`SELECT COUNT(*) AS c FROM (${sql})`).get(...params).c;
  const last = db
    .prepare('SELECT * FROM wallpaper_log ORDER BY id DESC LIMIT 1')
    .get();
  return {
    config: cfg,
    nextRunAt: next ? next.toISOString() : null,
    scopeCount: count,
    running: !!timer,
    // 当前策略真实使用的评分项（设置页据此写人话，别让用户以为在跑 AI）
    pick: pickPlan(cfg),
    lastLog: last
      ? { imageId: last.image_id, title: last.title, scope: last.scope, appliedAt: last.applied_at }
      : null,
  };
}

export function history(limit = 20) {
  return db
    .prepare('SELECT * FROM wallpaper_log ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ id: r.id, imageId: r.image_id, title: r.title, scope: r.scope, appliedAt: r.applied_at }));
}

/** 当前壁纸对应的图片记录（托盘 / 悬浮按钮用） */
export function currentWallpaper() {
  const last = db.prepare('SELECT * FROM wallpaper_log ORDER BY id DESC LIMIT 1').get();
  const cfg = getSettings().autoWallpaper || {};
  const id = last?.image_id || cfg.lastImageId || null;
  if (!id) return null;
  const row = db.prepare('SELECT id, title, favorite FROM images WHERE id = ?').get(id);
  if (!row) return null;
  const f = fit.getFit(row.id);
  return {
    imageId: row.id,
    title: row.title,
    favorite: !!row.favorite,
    // 适配度（可能还没算过）
    fit: f
      ? { score: f.score, safeArea: f.safe_area, reason: f.reason, source: f.source, likes: f.likes, dislikes: f.dislikes }
      : null,
  };
}

/** 收藏当前壁纸（托盘菜单 / 全局快捷键） */
export function favoriteCurrent() {
  const cur = currentWallpaper();
  if (!cur) throw new Error('还没有切换过壁纸');
  db.prepare('UPDATE images SET favorite = 1 WHERE id = ?').run(cur.imageId);
  return { ...cur, favorite: true };
}

/**
 * 「不喜欢这张」→ 完整闭环：
 * 1) 加入排除名单（之后不再被抽中）
 * 2) 记入壁纸适配度的 dislikes，后续排序大幅降权
 * 3) 沉淀到 AI 知识库规则（原因「不适合做壁纸」）→ 同来源 / 同关键词 / 同类描述词的图都会被降分
 * 4) 立刻换一张
 */
export async function dislikeCurrent() {
  const cur = currentWallpaper();
  const settings = getSettings();
  const cfg = settings.autoWallpaper || {};
  if (cur) {
    const excluded = [...(Array.isArray(cfg.excluded) ? cfg.excluded : []), cur.imageId].slice(-200);
    saveSettings({ autoWallpaper: { ...cfg, excluded } });
    try {
      fit.recordFeedback(cur.imageId, false);
    } catch {
      /* 没算过适配度也能继续 */
    }
    let learned = null;
    if (cfg.feedbackToKb !== false) {
      try {
        // 先归因（这张为什么不适合当壁纸），再只按具体原因建规则：
        // 不做来源/关键词连坐——不喜欢一张不等于这个来源或这个人都不能要
        const reasons = await fit.inferDislikeReasons(cur.imageId);
        kb.addFeedback({
          imageId: cur.imageId,
          reasons,
          note: '自动壁纸：不喜欢这张（已自动归因）',
          skipStatsRules: true,
        });
        learned = reasons;
        console.log('[auto] 不喜欢已归因并回流知识库：', cur.title, '→', reasons.join('/'));
      } catch (err) {
        console.error('[auto] 回流知识库失败：', err?.message || err);
      }
    }
    const next = await applyNow();
    return { skipped: cur.imageId, learned, ...next };
  }
  const next = await applyNow();
  return { skipped: null, ...next };
}

/** 「喜欢这张」：记入适配度 likes，后续更容易被抽中（正向闭环） */
export function likeCurrent() {
  const cur = currentWallpaper();
  if (!cur) throw new Error('还没有切换过壁纸');
  db.prepare('UPDATE images SET favorite = 1 WHERE id = ?').run(cur.imageId);
  fit.recordFeedback(cur.imageId, true).catch?.(() => {});
  return { ...cur, favorite: true };
}

/** 启动调度器（服务端启动时调用） */
export function startScheduler() {
  if (timer) return timer;
  timer = setInterval(async () => {
    const cfg = getSettings().autoWallpaper;
    if (!cfg || !cfg.enabled) return;
    const next = computeNextRun(cfg);
    if (!next || next > new Date()) return;
    // 全屏应用（游戏 / 播放器）运行时不打断用户，下个 tick 再补切
    // （计划点已过会持续命中触发条件，全屏结束后 30s 内自动完成切换；
    //   与动态壁纸侧的 isFullscreenAppRunning 性能规则保持一致）
    try {
      if (await isFullscreenAppRunning()) return;
    } catch {
      /* 检测失败不阻塞切换 */
    }
    try {
      const result = await applyNow();
      console.log('[auto] 已自动切换壁纸：', result.title, `(${result.screen?.width}x${result.screen?.height})`);
    } catch (err) {
      console.error('[auto] 自动切换壁纸失败：', err.message);
    }
  }, TICK_MS);
  console.log('[auto] 壁纸定时切换调度器已启动');
  return timer;
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
