// @ts-check
/**
 * 备份完整性清单：备份目录里写一份 manifest.json，恢复前拿它核对。
 *
 * 为什么需要它：备份就是一次文件夹拷贝，拷到一半（磁盘满、拔盘、进程被杀）
 * 也能留下一个「看起来像备份」的目录，而旧代码要到恢复中途才发现缺文件。
 * 有了清单，恢复前就能报出「缺 gallery.db」或「library.json 校验和不符」。
 *
 * 单独成模块（不 import db）：verifyBackup 是纯文件操作，可以直接被单测覆盖，
 * 不必为了测它去打开一个真实图库。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 这些文件坏了备份就等于废了，逐个记 sha256 */
const HASHED_FILES = ['gallery.db', 'library.json'];

/** 单文件 sha256（备份里的关键文件都不大，直接读进内存最省事） */
export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 目录里的文件数与总字节（thumbs 可能几万个文件，只统计不做逐文件哈希） */
export function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else {
        files++;
        try {
          bytes += fs.statSync(p).size;
        } catch {
          /* 读不到大小就只计数 */
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/**
 * 备份写完后落清单。必须在所有文件都写完后再调用。
 * @param {string} outDir 备份目录
 * @param {Record<string, number>} counts 素材/文件夹/标签数量
 */
export function writeManifest(outDir, counts) {
  const files = HASHED_FILES.filter((rel) => fs.existsSync(path.join(outDir, rel))).map((rel) => {
    const p = path.join(outDir, rel);
    return { path: rel, bytes: fs.statSync(p).size, sha256: sha256(p) };
  });
  const thumbDir = path.join(outDir, 'thumbs');
  const manifest = {
    schema: 1,
    app: 'TuKu',
    createdAt: new Date().toISOString(),
    counts: counts || {},
    files,
    // 缩略图丢了可以按需重建，所以只记数量/总量：几万个文件逐个哈希太慢，
    // 也不该因为「少了几张缩略图」拦住恢复
    thumbs: fs.existsSync(thumbDir) ? dirStats(thumbDir) : { files: 0, bytes: 0 },
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

/**
 * 恢复前预检：缺什么、哪个文件对不上，一次说清楚。
 * 老备份没有清单不拦（靠数据库 integrity_check 兜底），但要提示一句。
 * @param {string} sourceDir
 * @returns {{ok:boolean, problems:string[], warnings:string[], manifest:any|null, counts:any}}
 */
export function verifyBackup(sourceDir) {
  const raw = String(sourceDir || '').trim();
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  if (!raw || !fs.existsSync(raw)) {
    return { ok: false, problems: ['备份文件夹不存在'], warnings, manifest: null, counts: null };
  }
  // 统一成绝对路径再比前缀：调用方可能传 E:/xxx（正斜杠），path.join 出来是 E:\xxx，
  // 直接比字符串会把正常文件判成「越界」（2026-11-15 实测踩到）
  const dir = path.resolve(raw);
  if (!fs.existsSync(path.join(dir, 'gallery.db'))) problems.push('缺少 gallery.db（元数据主文件）');

  const mf = path.join(dir, 'manifest.json');
  /** @type {any} */
  let manifest = null;
  if (!fs.existsSync(mf)) {
    warnings.push('备份里没有 manifest.json 清单（旧版本备份或未完成），只能靠数据库自检兜底');
  } else {
    try {
      manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    } catch {
      problems.push('manifest.json 无法解析（可能写到一半就中断了）');
    }
  }

  if (manifest && Array.isArray(manifest.files)) {
    for (const f of manifest.files) {
      const rel = String(f?.path || '');
      const p = path.resolve(dir, rel);
      // 清单是外部文件，路径必须落在备份目录里（防 ../ 越界读到别处）
      const inside = path.relative(dir, p);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
        problems.push(`清单里的路径越界：${rel}`);
        continue;
      }
      if (!fs.existsSync(p)) {
        problems.push(`缺少文件：${rel}`);
        continue;
      }
      const size = fs.statSync(p).size;
      if (Number(f.bytes) !== size) {
        problems.push(`${rel} 大小不符（清单 ${f.bytes} 字节，实际 ${size} 字节）`);
        continue;
      }
      if (f.sha256 && sha256(p) !== f.sha256) problems.push(`${rel} 校验和不符（文件已损坏）`);
    }
  }

  if (manifest?.thumbs) {
    const thumbDir = path.join(dir, 'thumbs');
    const actual = fs.existsSync(thumbDir) ? dirStats(thumbDir) : { files: 0, bytes: 0 };
    if (Number(manifest.thumbs.files) !== actual.files) {
      warnings.push(
        `缩略图数量与清单不符（清单 ${manifest.thumbs.files} 个，实际 ${actual.files} 个）——缩略图可以按需重建，不影响元数据`
      );
    }
  }

  return { ok: problems.length === 0, problems, warnings, manifest, counts: manifest?.counts || null };
}
