/**
 * 模型文件下载：流式落盘 + 真实进度 + sha256 完整性校验 + 原子替换。
 * - 先写 <dest>.part，全部校验通过后再 rename：网络断 / 进程中断不会留下半截「完整」模型
 * - sha256 校验两层：KNOWN_SHA256 显式清单；首次成功下载自动写入 <dest>.sha256，
 *   之后重装 / 换源都会对齐这份记录，防镜像投毒或传输损坏
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { httpFetch } from './http.js';

/**
 * 随包可信哈希清单（只读资源，打包进 asar，运行时改不了）。
 *
 * 与 sidecar 的本质区别：sidecar 是「上次下载时自己写的」，模型与 sidecar 一起被替换时
 * 校验照样通过；而这里的条目来自发布包，攻击者改不了，才算真正的外部参照。
 * 清单用 `npm run pin-models -- <已核对的文件> <键>` 固化，并随代码提交。
 * 内网部署可用 TUKU_MODEL_SHA256_FILE 指向同结构 JSON 覆盖/追加。
 */
function loadPins() {
  const models = {};
  const zips = {};
  const merge = (raw, from) => {
    try {
      const data = JSON.parse(raw);
      for (const [k, v] of Object.entries(data?.models || {})) {
        if (/^[0-9a-f]{64}$/i.test(String(v))) models[k] = String(v).toLowerCase();
      }
      for (const [k, v] of Object.entries(data?.zips || {})) {
        if (/^[0-9a-f]{64}$/i.test(String(v))) zips[k] = String(v).toLowerCase();
      }
    } catch (err) {
      console.warn(`[model] ${from} 不是有效的哈希清单：${err?.message || err}`);
    }
  };
  try {
    merge(fs.readFileSync(new URL('./model-pins.json', import.meta.url), 'utf8'), '随包清单');
  } catch {
    /* 开发态清单可能还没生成：只留 sidecar 兜底，但不谎报 verified */
  }
  const override = String(process.env.TUKU_MODEL_SHA256_FILE || '').trim();
  if (override) {
    try {
      merge(fs.readFileSync(override, 'utf8'), override);
    } catch (err) {
      console.warn(`[model] 外部哈希清单不可读：${err?.message || err}`);
    }
  }
  return { models, zips };
}

const PINS = loadPins();

/** 已知模型的强校验哈希（hex，键 = 镜像内相对路径） */
export const KNOWN_SHA256 = Object.freeze({ ...PINS.models });
/** 已知 release zip 的强校验哈希（hex，键 = 下载 URL） */
export const KNOWN_ZIP_SHA256 = Object.freeze({ ...PINS.zips });

/** 该仓库路径是否有固定过的可信哈希（false = 只有 sidecar 自记录，不能算校验通过） */
export function isPinned(repoPath) {
  return /^[0-9a-f]{64}$/i.test(String(KNOWN_SHA256[repoPath] || ''));
}

/**
 * 取清单里的期望哈希：downloadModelFile 必须优先用它，不能被 sidecar 覆盖。
 * 调用方有时传相对路径（如 matting 的 `onnx/model.onnx`），而清单键为完整
 * `仓库/路径`；后缀唯一时也应命中，否则清单形同虚设、又退回 sidecar 自记录。
 */
export function pinnedSha(repoPath) {
  const key = String(repoPath || '');
  if (isPinned(key)) return String(KNOWN_SHA256[key]).toLowerCase();
  const suffix = `/${key.replace(/^\/+/, '')}`;
  const hits = Object.entries(KNOWN_SHA256).filter(([k, v]) => k.endsWith(suffix) && /^[0-9a-f]{64}$/i.test(String(v)));
  return hits.length === 1 ? String(hits[0][1]).toLowerCase() : '';
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(p)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

async function readSidecar(dest) {
  try {
    const hex = (await fsp.readFile(`${dest}.sha256`, 'utf8')).trim();
    return /^[0-9a-f]{64}$/i.test(hex) ? hex : '';
  } catch {
    return '';
  }
}

/**
 * 下载单个模型文件。
 * @param {object} opts
 * @param {string[]} opts.mirrors   完整 URL 前缀列表（含 repo 路径，逐个尝试）
 * @param {string}   opts.repoPath  镜像内相对路径（拼在 mirror 后）
 * @param {string}   opts.dest      目标文件
 * @param {number}  [opts.minBytes] 最小合法体积（默认 16）
 * @param {number}  [opts.maxBytes] 最大合法体积（0 = 不限，防超大响应写爆磁盘）
 * @param {string}  [opts.sha256]   期望哈希（空则回退 sidecar 记录）
 * @param {(p:number, done:number, total:number)=>void} [opts.onProgress] 0~1
 */
export async function downloadModelFile({
  mirrors,
  repoPath,
  dest,
  minBytes = 16,
  maxBytes = 0,
  sha256 = '',
  onProgress,
  signal,
}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let lastErr = null;
  const aborted = () => !!signal?.aborted;

  for (const base of mirrors) {
    if (aborted()) throw new Error('已取消下载');
    try {
      const res = await httpFetch(`${base}${repoPath}`, { redirect: 'follow', signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      if (maxBytes && total > maxBytes) throw new Error('文件超出预期大小');

      let done = 0;
      const hash = crypto.createHash('sha256');
      await pipeline(
        Readable.fromWeb(res.body),
        async function* (source) {
          for await (const chunk of source) {
            if (aborted()) throw new Error('已取消下载');
            done += chunk.length;
            if (maxBytes && done > maxBytes) throw new Error('文件超出预期大小');
            hash.update(chunk);
            onProgress?.(total ? Math.min(1, done / total) : 0, done, total);
            yield chunk;
          }
        },
        fs.createWriteStream(part)
      );

      const size = fs.statSync(part).size;
      if (size < minBytes) throw new Error(`文件不完整（仅 ${size} 字节）`);

      const digest = hash.digest('hex');
      // 清单优先：sidecar 可能被和模型一起替换掉，不能让它覆盖随包可信哈希
      const pinned = pinnedSha(repoPath);
      const expect = pinned || sha256 || (await readSidecar(dest));
      if (expect && digest !== expect) {
        throw new Error(
          pinned ? 'sha256 与随包可信清单不一致：模型可能被替换' : 'sha256 校验失败：文件损坏或来源异常'
        );
      }

      await fsp.rename(part, dest);
      await fsp.writeFile(`${dest}.sha256`, `${digest}\n`, 'utf8').catch(() => {});
      // 只有「随包清单」或调用方显式给出的期望哈希才算外部参照；
      // sidecar 只是自洽，不能谎报 verified=true
      return { size, sha256: digest, verified: !!(pinned || sha256) };
    } catch (err) {
      lastErr = err;
      await fsp.rm(part, { force: true }).catch(() => {});
      // 取消 / 主动中止时不要再试下一个镜像：那会把「取消」变成「换源继续下」
      if (aborted() || err?.name === 'AbortError' || /已取消/.test(String(err?.message || ''))) {
        throw new Error('已取消下载', { cause: err });
      }
    }
  }
  throw new Error(`模型下载失败：${lastErr?.message || '镜像与官方源都不可达'}`);
}

/**
 * 供既有模块核对已存在文件是否可信（体积 + sidecar/清单哈希）。
 * 返回 `{ ok, verified }`：`verified=false` 意味着只自洽（与上次下载记录的哈希一致），
 * 没有任何外部可信参照 —— 调用方据此决定是否敢说自己「校验通过」。
 */
export async function verifyModelFileDetailed(dest, { minBytes = 16, sha256 = '' } = {}) {
  try {
    const st = await fsp.stat(dest);
    if (st.size < minBytes) return { ok: false, verified: false, reason: '体积异常' };
    const pinned = String(sha256 || '').trim();
    const expect = pinned || (await readSidecar(dest));
    if (!expect) return { ok: true, verified: false, reason: '无参照哈希' };
    const digest = await sha256File(dest);
    return {
      ok: digest === expect,
      verified: !!pinned,
      sha256: digest,
      reason: digest === expect ? '' : '哈希不匹配',
    };
  } catch (err) {
    return { ok: false, verified: false, reason: err?.message || String(err) };
  }
}

/** 兼容旧调用：只关心是否可用 */
export async function verifyModelFile(dest, opts = {}) {
  const r = await verifyModelFileDetailed(dest, opts);
  return r.ok;
}
