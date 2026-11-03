// 系统字体清单：直接解析 TTF/OTF/TTC 的 name 表拿「家族名」。
//
// 为什么不用注册表/命令行：`reg query` 在中文 Windows 上输出是 OEM 编码，
// Node 拿到的字符串是乱码，家族名一旦错一个字 fontconfig 就匹配不上，水印会静默
// 掉回默认字体。name 表里的字符串是 UTF-16BE，自己解析既准又快（几百个文件几十毫秒）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FONT_EXTS = new Set(['.ttf', '.otf', '.ttc', '.otc']);
/** 家族名白名单：字母数字、拉丁扩展、中日韩、空格与常见连接符。双引号/尖括号一律不要 */
const SAFE_NAME = /^[A-Za-z0-9\u00C0-\u024F\u0400-\u04FF\u3000-\u30FF\u4E00-\u9FFF\uFF01-\uFF60 ._&'’() -]+$/;
const CJK = /[\u3000-\u30FF\u4E00-\u9FFF\uFF01-\uFF60]/;

/** WOFF/WOFF2 的 sfnt 头是压缩的，不解；返回每个 face 的 sfnt 起始偏移 */
function sfntBases(buf) {
  if (buf.length < 16) return [];
  if (buf.toString('latin1', 0, 4) === 'ttcf') {
    const num = buf.readUInt32BE(8);
    const bases = [];
    for (let i = 0; i < num && i < 16; i += 1) {
      const off = buf.readUInt32BE(12 + i * 4);
      if (off + 12 <= buf.length) bases.push(off);
    }
    return bases;
  }
  return [0];
}

/** 从一个 sfnt 头里读 name 表，挑「英文家族名」优先；同时报告它有没有中日韩名字 */
function familyOf(buf, base) {
  if (base + 12 > buf.length) return { family: '', hasCjk: false };
  const numTables = buf.readUInt16BE(base + 4);
  let nameOff = -1;
  for (let i = 0; i < numTables; i += 1) {
    const rec = base + 12 + i * 16;
    if (rec + 16 > buf.length) break;
    if (buf.toString('latin1', rec, rec + 4) === 'name') {
      nameOff = buf.readUInt32BE(rec + 8);
      break;
    }
  }
  if (nameOff < 0 || nameOff + 6 > buf.length) return { family: '', hasCjk: false };
  const count = buf.readUInt16BE(nameOff + 2);
  const strBase = nameOff + buf.readUInt16BE(nameOff + 4);
  let best = '';
  let bestRank = -1;
  let hasCjk = false;
  for (let i = 0; i < count; i += 1) {
    const r = nameOff + 6 + i * 12;
    if (r + 12 > buf.length) break;
    const platform = buf.readUInt16BE(r);
    const encoding = buf.readUInt16BE(r + 2);
    const lang = buf.readUInt16BE(r + 4);
    const nameId = buf.readUInt16BE(r + 6);
    const len = buf.readUInt16BE(r + 8);
    const off = buf.readUInt16BE(r + 10);
    // 1 = Family，16 = Typographic Family（多字重字体里更干净）；4 = Full Name 只用来判断有没有中文名
    if (nameId !== 1 && nameId !== 4 && nameId !== 16) continue;
    if (strBase + off + len > buf.length) continue;
    let text;
    if (platform === 3) {
      const slice = Buffer.from(buf.subarray(strBase + off, strBase + off + len));
      if (slice.length % 2) continue;
      slice.swap16();
      text = slice.toString('utf16le');
    } else if (platform === 1 && encoding === 0) {
      text = buf.toString('latin1', strBase + off, strBase + off + len);
    } else {
      continue;
    }
    text = text.replace(/[\u0000-\u001F\u007F]/g, '').trim();
    if (!text) continue;
    // 任一语言写成中日韩名字，就说明它是中文字体（英文家族名的中文字体也靠这个认）
    if (CJK.test(text)) hasCjk = true;
    if (nameId === 4) continue;
    // 英文优先：fontconfig 对英文家族名匹配最稳，中文名作为兜底
    const rank = (platform === 3 ? 8 : 0) + (lang === 0x409 ? 4 : 0) + (nameId === 16 ? 2 : 0) + (CJK.test(text) ? 0 : 1);
    if (rank > bestRank) {
      bestRank = rank;
      best = text;
    }
  }
  return { family: best, hasCjk };
}

/** 系统字体目录：系统级 + 当前用户安装（后者常被忽略） */
function fontDirs() {
  const dirs = [];
  if (process.platform === 'win32') {
    const win = process.env.WINDIR || 'C:\\Windows';
    dirs.push(path.join(win, 'Fonts'));
    const local = process.env.LOCALAPPDATA;
    if (local) dirs.push(path.join(local, 'Microsoft', 'Windows', 'Fonts'));
  } else if (process.platform === 'darwin') {
    dirs.push('/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts'));
  } else {
    dirs.push('/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.local/share/fonts'));
  }
  return dirs.filter((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

function walk(dir, out, depth = 0) {
  if (depth > 2) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (FONT_EXTS.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
}

let cache = { at: 0, list: [] };

/**
 * 扫描本机字体，返回 [{ key, name, stack, group }]
 * key 形如 `sys:Microsoft YaHei`，存进设置里再回服务端还原成 SVG 的 font-family。
 */
export function systemFonts({ refresh = false } = {}) {
  if (!refresh && cache.list.length && Date.now() - cache.at < 60_000) return cache.list;
  const files = [];
  for (const d of fontDirs()) walk(d, files);
  const seen = new Set();
  const list = [];
  for (const file of files) {
    let buf;
    try {
      const st = fs.statSync(file);
      // 太大的字体（>40MB，常见于 CJK 全集）读起来慢，直接跳过
      if (st.size > 40 * 1024 * 1024) continue;
      buf = fs.readFileSync(file);
    } catch {
      continue;
    }
    for (const base of sfntBases(buf)) {
      const { family: name, hasCjk } = familyOf(buf, base);
      if (!name || !SAFE_NAME.test(name) || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      list.push({ key: `sys:${name}`, name, stack: fontStack(name), group: hasCjk ? '中文字体' : '西文字体' });
      if (list.length > 400) break;
    }
    if (list.length > 400) break;
  }
  list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  cache = { at: Date.now(), list };
  return list;
}

/** 家族名 → SVG font-family（带兜底栈，字体缺失时不至于排出豆腐块） */
export function fontStack(family) {
  const safe = String(family).replace(/["<>]/g, '').trim();
  return CJK.test(safe)
    ? `'${safe}', 'Microsoft YaHei', 'PingFang SC', sans-serif`
    : `'${safe}', 'Segoe UI', Arial, sans-serif`;
}

/** 校验并还原用户选的字体：只认清单里真实存在的家族名 */
export function resolveSystemFont(key) {
  const s = String(key || '');
  if (!s.startsWith('sys:')) return null;
  const name = s.slice(4);
  if (!SAFE_NAME.test(name)) return null;
  const hit = systemFonts().find((f) => f.name.toLowerCase() === name.toLowerCase());
  return hit ? { key: hit.key, name: hit.name, stack: hit.stack } : null;
}
