// @ts-check
/**
 * 崩溃诊断包：用户报障时一键导出「日志 + 环境 + 最近错误」。
 *
 * 以前只能让用户截图 + 口头描述，一来一回三四轮才定位到「显卡驱动版本」或
 * 「服务没起来」。这里把能自证的东西打成 zip：最近几份日志、崩溃转储清单、
 * 运行环境、脱敏后的设置。诊断包不含素材文件与任何密钥。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

/** 单份日志最多带这么多：日志动辄几十 MB，诊断包不该比应用还大 */
const MAX_LOG_BYTES = 4 * 1024 * 1024;
/** 最多带几份日志（按修改时间倒序） */
const MAX_LOG_FILES = 4;

/** 敏感字段一律打码：诊断包是要发给别人（甚至贴到公开 issue）的 */
function maskSecrets(settings) {
  const out = { ...settings };
  if (out.aiApiKey) out.aiApiKey = '***';
  if (out.weiboCookie) out.weiboCookie = '***';
  if (out.ai && typeof out.ai === 'object') out.ai = { ...out.ai, apiKey: '***' };
  if (out.network && typeof out.network === 'object' && out.network.proxyPassword) {
    out.network = { ...out.network, proxyPassword: '***' };
  }
  return out;
}

function listLogs(logDir) {
  try {
    return fs
      .readdirSync(logDir, { withFileTypes: true })
      .filter((d) => d.isFile() && /\.log(\.old)?$/i.test(d.name))
      .map((d) => {
        const p = path.join(logDir, d.name);
        const st = fs.statSync(p);
        return { name: d.name, path: p, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_LOG_FILES);
  } catch {
    return [];
  }
}

function listCrashDumps(crashDir) {
  try {
    return fs
      .readdirSync(crashDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const st = fs.statSync(path.join(crashDir, d.name));
        return { name: d.name, bytes: st.size, at: new Date(st.mtimeMs).toISOString() };
      })
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, 20);
  } catch {
    return [];
  }
}

/**
 * 组装诊断包。
 * @param {{app:any, logDir:string, crashDir:string, userData:string, settings:any, serverPort?:number}} ctx
 * @returns {Promise<Buffer>}
 */
export async function buildDiagnosticsZip(ctx) {
  const zip = new JSZip();
  const logs = listLogs(ctx.logDir);
  for (const f of logs) {
    try {
      const buf = fs.readFileSync(f.path);
      // 拿最后 4MB：崩溃通常发生在日志末尾，开头几 MB 是启动噪音
      zip.file(`logs/${f.name}`, buf.length > MAX_LOG_BYTES ? buf.subarray(buf.length - MAX_LOG_BYTES) : buf);
    } catch (err) {
      zip.file(`logs/${f.name}.error.txt`, `读取失败：${/** @type {any} */ (err)?.message || err}`);
    }
  }

  const env = {
    app: {
      version: ctx.app.getVersion(),
      name: ctx.app.getName(),
      packaged: ctx.app.isPackaged,
      locale: ctx.app.getLocale(),
    },
    runtime: { ...process.versions },
    system: {
      platform: process.platform,
      arch: process.arch,
      release: process.getSystemVersion?.() || os.release(),
      totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
      cpu: os.cpus()?.[0]?.model || '',
    },
    paths: {
      userData: ctx.userData,
      logDir: ctx.logDir,
      crashDir: ctx.crashDir,
    },
    serverPort: ctx.serverPort || 0,
    exportedAt: new Date().toISOString(),
  };
  zip.file('environment.json', JSON.stringify(env, null, 2));
  zip.file('crash-dumps.json', JSON.stringify(listCrashDumps(ctx.crashDir), null, 2));
  zip.file('settings.json', JSON.stringify(maskSecrets(ctx.settings || {}), null, 2));
  zip.file(
    'README.txt',
    [
      'TuKu 图库 诊断包',
      '',
      `导出时间：${new Date().toLocaleString()}`,
      '包含：logs/（最近几份运行日志，只保留末尾 4MB）、environment.json（版本与系统信息）、',
      'crash-dumps.json（崩溃转储清单，不含转储本体）、settings.json（设置，密钥已打码）。',
      '',
      '不包含：素材原图、缩略图、数据库文件、任何账号密码。',
      '排查显卡 / 服务问题时，把这份 zip 整个发给开发者即可。',
    ].join('\n')
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
