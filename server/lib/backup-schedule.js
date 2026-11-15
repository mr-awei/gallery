// @ts-check
/**
 * 自动备份排程：本地管理器最该有、却最容易漏的一件事。
 *
 * 以前备份是设置页里的一个手动按钮 —— 用户记得点才有备份，而「记得点」这件事
 * 恰恰在硬盘坏掉的那天不成立。这里做成：开着服务就每小时看一眼，到点自动备份
 * 到用户指定的另一块盘，并按份数保留，不无限占空间。
 *
 * 几个刻意的选择：
 * - 配置存 settings（按库独立）：不同资源库可以备到不同盘；
 * - 只在「上一次备份时间超过间隔」时动手，所以关机/重启不会补跑一堆；
 * - 备份目录下每次一个子目录 `tuku-YYYYMMDD-HHmm`，按名字排序即时间序，好清理；
 * - 失败只记日志并写 lastError，下次照样重试 —— 不因为一次盘没插就永久停摆。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, saveSettings } from '../db.js';

/** 每小时看一次：比「每天固定钟点」更抗休眠/时区变化，最坏晚一小时 */
const TICK_MS = 60 * 60 * 1000;

let timer = null;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || lo));

/** 当前自动备份配置（前端与调度器共用同一份口径） */
export function autoBackupConfig() {
  const s = getSettings();
  return {
    enabled: !!s.backupAuto,
    dir: String(s.backupAutoDir || ''),
    everyDays: clamp(s.backupAutoEveryDays, 1, 90),
    keep: clamp(s.backupAutoKeep, 1, 30),
    lastAt: String(s.backupAutoLastAt || ''),
    lastPath: String(s.backupAutoLastPath || ''),
    lastError: String(s.backupAutoLastError || ''),
  };
}

/** 保存配置；只接受白名单字段，避免前端塞任意键进设置表 */
export function saveAutoBackupConfig(patch) {
  const next = {};
  if (patch?.enabled !== undefined) next.backupAuto = !!patch.enabled;
  if (patch?.dir !== undefined) next.backupAutoDir = String(patch.dir || '').trim();
  if (patch?.everyDays !== undefined) next.backupAutoEveryDays = clamp(patch.everyDays, 1, 90);
  if (patch?.keep !== undefined) next.backupAutoKeep = clamp(patch.keep, 1, 30);
  saveSettings(next);
  return autoBackupConfig();
}

/** 备份目录下的子目录按名字倒序 = 时间倒序；超出保留份数的删掉（只删本应用建的目录） */
function pruneOld(dir, keep) {
  let names;
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^tuku-\d{8}-\d{4}$/.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch (err) {
    console.warn('[backup-auto] 读取备份目录失败：', /** @type {any} */ (err)?.message || err);
    return 0;
  }
  let removed = 0;
  for (const name of names.slice(keep)) {
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed++;
    } catch (err) {
      console.warn(`[backup-auto] 删除旧备份 ${name} 失败：`, /** @type {any} */ (err)?.message || err);
    }
  }
  return removed;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 跑一次自动备份（也可由设置页的「立即备份一次」直接调）。
 * @param {{force?: boolean}} [opts] force 忽略间隔判断
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, dir?:string, removed?:number, error?:string}>}
 */
export async function runAutoBackup({ force = false } = {}) {
  const cfg = autoBackupConfig();
  if (!cfg.enabled && !force) return { ok: false, skipped: true, reason: '自动备份未开启' };
  if (!cfg.dir) return { ok: false, skipped: true, reason: '还没有选择备份目录' };
  const last = Date.parse(cfg.lastAt) || 0;
  if (!force && last && Date.now() - last < cfg.everyDays * 86400_000) {
    return { ok: false, skipped: true, reason: '还没到下次备份时间' };
  }

  const outDir = path.join(cfg.dir, `tuku-${stamp()}`);
  try {
    // 动态 import：transfer.js 依赖 db/libraries，调度器在服务启动早期就会被调用，
    // 静态 import 会让「启动顺序」变成隐藏依赖
    const { backupLibrary } = await import('./transfer.js');
    const r = backupLibrary({ targetDir: outDir, includeThumbs: true });
    if (!r || r.ok === false) throw new Error(r?.error || '备份失败');
    const removed = pruneOld(cfg.dir, cfg.keep);
    saveSettings({ backupAutoLastAt: new Date().toISOString(), backupAutoLastPath: outDir, backupAutoLastError: '' });
    console.info(`[backup-auto] 已备份到 ${outDir}${removed ? `，清理旧份 ${removed} 个` : ''}`);
    return { ok: true, dir: outDir, removed };
  } catch (err) {
    const message = String(/** @type {any} */ (err)?.message || err);
    console.warn('[backup-auto] 备份失败：', message);
    saveSettings({ backupAutoLastError: message });
    return { ok: false, error: message };
  }
}

/** 启动每小时检查（重复调用无副作用） */
export function startBackupSchedule() {
  if (timer) return timer;
  timer = setInterval(() => {
    void runAutoBackup();
  }, TICK_MS);
  // 不阻塞进程退出：桌面端关窗就走，不需要等下一次 tick
  timer.unref?.();
  // 启动 2 分钟后补一次：很多人是「开机 → 打开图库 → 关掉」，等到整点就永远不跑
  const first = setTimeout(() => void runAutoBackup(), 120_000);
  first.unref?.();
  return timer;
}


