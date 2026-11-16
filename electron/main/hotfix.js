// @ts-check
/**
 * 热更内核（主进程）：下载 → 验签 → 解包校验 → 换入 → 启动期看门狗。
 *
 * 为什么不覆盖 app.asar：asar 只读、且 electron-updater 只认整包；
 * 所以热更包落在用户数据目录，启动时以「叠加层」的身份优先于 asar 使用。
 * 层级只有两种，其余都走原有安装包通道：
 *   - web/**  → 静态托管的增量目录（缺的文件自动回落 asar 里的 dist/web）
 *   - server/** → 由 asar 里的 loader 把裸模块解析回 asar 的 node_modules
 * electron/、package.json、原生模块一律禁止入包（见 lib/hotfix-manifest.js）。
 *
 * 坏包必须能自愈：启动前记一笔「这次要带 seq=N 启动」，服务就绪后才销账；
 * 连续两次没走到销账就判定坏包并隔离，自动退回内置版本 —— 应用不会变砖。
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { manifestProblem, sha256, verifyManifest } from '../lib/hotfix-manifest.js';

const READY_TRIES_MAX = 2;
const FETCH_TIMEOUT = 20_000;

/** 内置服务入口（asar 内）；热更生效时主进程会改用 server/hotfix-entry.js 这个 shim */
const builtinEntry = (appRoot) => path.join(appRoot, 'server', 'standalone.js');

/**
 * @param {object} opts
 * @param {string} opts.userDataDir  用户数据目录（%APPDATA%/TuKu）
 * @param {string} opts.appRoot     真实应用根（打包后是 app.asar）
 * @param {string} opts.shellVersion app.getVersion()
 * @param {number} opts.schemaVersion 数据库迁移版本（= MIGRATIONS 长度）
 * @param {string} opts.publicKeyPem 公钥（PEM）；为空 = 热更关闭
 * @param {string[]} opts.feedUrls   manifest 候选地址
 * @param {typeof fetch} [opts.fetchImpl] 注入 fetch（默认 Electron 的 net.fetch）
 */
export function createHotfix({
  userDataDir,
  appRoot,
  shellVersion,
  schemaVersion,
  publicKeyPem,
  feedUrls,
  fetchImpl,
}) {
  const root = path.join(userDataDir, 'hotfix');
  const dir = {
    root,
    current: path.join(root, 'current'),
    pending: (seq) => path.join(root, `pending-${seq}`),
    staging: (seq) => path.join(root, `staging-${seq}-${process.pid}`),
    state: path.join(root, 'state.json'),
  };
  const enabled = Boolean(publicKeyPem);

  /* ------------------------------- 状态文件 ------------------------------- */

  const readState = () => {
    const empty = { lastSeq: 0, active: null, pending: null, boot: null, bad: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(dir.state, 'utf8'));
      return { ...empty, ...raw, bad: Array.isArray(raw.bad) ? raw.bad : [] };
    } catch {
      return empty;
    }
  };

  const writeState = (st) => {
    try {
      fs.mkdirSync(root, { recursive: true });
      const tmp = `${dir.state}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
      fs.renameSync(tmp, dir.state);
    } catch (err) {
      console.warn('[hotfix] 状态写入失败：', err?.message || err);
    }
  };

  const rmrf = (target) => {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (err) {
      console.warn('[hotfix] 删除失败（忽略）：', target, err?.message || err);
    }
  };

  /* ------------------------------- 清单校验 ------------------------------- */

  /** 读某个目录里的 manifest.json 并验签；返回 { manifest } 或 { error } */
  const readManifestDir = (base) => {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
    } catch {
      return { error: '读不到 manifest.json' };
    }
    if (!verifyManifest(manifest, publicKeyPem)) return { error: '验签失败' };
    return { manifest };
  };

  /** 目录里的文件是否与清单逐条对得上（大小即可，sha256 在下载/解包时已校验过） */
  const filesIntact = (base, manifest) => {
    for (const f of manifest.files) {
      const abs = path.join(base, f.path);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        return `缺文件 ${f.path}`;
      }
      if (!stat.isFile() || stat.size !== f.size) return `文件大小不符 ${f.path}`;
    }
    return '';
  };

  /* --------------------------- 启动期：选入口 --------------------------- */

  /**
   * 启动前调用一次（早于服务进程 fork）。
   * 顺带做三件必须在这里做的事：坏包销账、pending 换入、current 校验。
   * @returns {{mode:'builtin'|'overlay', seq:number, serverEntry:string, webOverlay:string, env:Record<string,string>, manifest:any, note:string}}
   */
  const boot = () => {
    /** @type {any} */
    const out = {
      mode: 'builtin',
      seq: 0,
      serverEntry: builtinEntry(appRoot),
      webOverlay: '',
      env: { TUKU_APP_ROOT: appRoot },
      manifest: null,
      note: '',
    };
    if (!enabled) return out;

    const st = readState();
    // 1) 上次带着热更启动，但始终没走到 markReady：说明这套文件起不来
    if (st.boot && st.boot.seq && st.active && st.boot.seq === st.active.seq) {
      st.boot.tries = (Number(st.boot.tries) || 0) + 1;
      if (st.boot.tries >= READY_TRIES_MAX) {
        out.note = `热更 #${st.boot.seq} 连续 ${st.boot.tries} 次未能就绪，已隔离`;
        console.error(`[hotfix] ${out.note}，本次改用内置版本`);
        quarantine(st);
        st.boot = null;
      }
      writeState(st);
    }

    // 2) 已下载未生效的包：这里换入（「下次启动生效」就是在这一步落地）
    if (st.pending) promote(st);

    // 3) 校验生效中的包，任何一项不符都当坏包
    if (st.active && fs.existsSync(dir.current)) {
      const { manifest, error } = readManifestDir(dir.current);
      if (error) {
        out.note = `热更 #${st.active.seq} 不可用：${error}`;
        quarantine(st);
        writeState(st);
      } else {
        // 已生效的包不再比 seq（它就是当前版本），只校验其余门槛与文件完整性
        const problem =
          manifestProblem(manifest, { shellVersion, schemaVersion, lastSeq: 0 }) ||
          filesIntact(dir.current, manifest);
        if (problem) {
          out.note = `热更 #${st.active.seq} 校验失败：${problem}`;
          quarantine(st);
          writeState(st);
        } else {
          const serverDir = path.join(dir.current, 'server');
          const webDir = path.join(dir.current, 'web');
          const hasServer = fs.existsSync(path.join(serverDir, 'standalone.js'));
          out.mode = 'overlay';
          out.seq = manifest.seq;
          out.manifest = manifest;
          out.webOverlay = fs.existsSync(webDir) ? webDir : '';
          out.serverEntry = hasServer ? path.join(appRoot, 'server', 'hotfix-entry.js') : builtinEntry(appRoot);
          out.env = {
            ...out.env,
            TUKU_HOTFIX_ROOT: dir.current,
            ...(hasServer ? { TUKU_HOTFIX_ENTRY: path.join(serverDir, 'standalone.js') } : {}),
            ...(out.webOverlay ? { TUKU_WEB_OVERLAY: out.webOverlay } : {}),
          };
          // 销账要等服务真的就绪（见 markReady），这里先记「这次在试它」。
          // tries 必须沿用上一步累加的结果：归零等于永远凑不满两次，看门狗形同虚设。
          const tries = st.boot && st.boot.seq === manifest.seq ? Number(st.boot.tries) || 0 : 0;
          st.boot = { seq: manifest.seq, tries };
          writeState(st);
        }
      }
    }
    return out;
  };

  /** 服务已就绪：销掉启动期的尝试记录 */
  const markReady = () => {
    if (!enabled) return;
    const st = readState();
    if (!st.boot) return;
    if (st.active && st.active.seq === st.boot.seq) st.active = { ...st.active, at: new Date().toISOString() };
    st.boot = null;
    writeState(st);
  };

  /** 当前生效的包不可用：隔离（留目录便于排查，下次启动不再加载） */
  function quarantine(st) {
    const seq = st.active?.seq || st.boot?.seq || 0;
    if (fs.existsSync(dir.current)) {
      const trash = path.join(root, `broken-${Date.now()}-${seq}`);
      try {
        fs.renameSync(dir.current, trash);
        console.warn('[hotfix] 坏包已隔离：', trash);
      } catch {
        rmrf(dir.current);
      }
    }
    if (seq) st.bad = [...new Set([...(st.bad || []), seq])];
    st.active = null;
    st.pending = null;
    st.boot = null;
  }

  /** 手动降级（服务启动失败时的补救）：隔离当前热更并返回内置入口 */
  const fallbackToBuiltin = (reason) => {
    const st = readState();
    if (!st.active) return boot();
    console.error('[hotfix] 热更版本启动失败，退回内置版本：', reason);
    quarantine(st);
    writeState(st);
    return boot();
  };

  /** pending 目录换入 current（原子 rename，失败就放弃这批） */
  function promote(st) {
    const seq = Number(st.pending?.seq) || 0;
    const from = dir.pending(seq);
    if (!seq || !fs.existsSync(from)) {
      st.pending = null;
      writeState(st);
      return;
    }
    const { manifest, error } = readManifestDir(from);
    if (error) {
      console.warn('[hotfix] 待生效的包损坏，丢弃：', error);
      rmrf(from);
      st.pending = null;
      writeState(st);
      return;
    }
    // 顺序很讲究：old current 先让位，再把 pending 顶上，中间不留空窗
    if (fs.existsSync(dir.current)) {
      rmrf(dir.previous);
      try {
        fs.renameSync(dir.current, dir.previous);
      } catch {
        rmrf(dir.current);
      }
    }
    try {
      fs.renameSync(from, dir.current);
    } catch (err) {
      // 换不进去（跨盘/占用）：保持原样，等下次启动再试
      console.warn('[hotfix] 换入失败：', err?.message || err);
      return;
    }
    st.active = { seq: manifest.seq, shellVersion: manifest.shellVersion, at: new Date().toISOString() };
    st.pending = null;
    st.lastSeq = Math.max(Number(st.lastSeq) || 0, manifest.seq);
    writeState(st);
    console.info(`[hotfix] 已换入热更 #${manifest.seq}`);
  }

  /* ----------------------------- 下载与落盘 ----------------------------- */

  const doFetch = fetchImpl || ((url, init) => globalThis.fetch(url, init));

  const fetchBuf = async (url, { json = false } = {}) => {
    const res = await doFetch(url, {
      headers: {
        // 有些镜像/网关会拒掉默认 UA，带一个明确身份便于排查
        'User-Agent': `TuKu/${shellVersion} (hotfix)`,
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return json ? res.json() : Buffer.from(await res.arrayBuffer());
  };

  /** 依次试候选地址取清单；验签不过或版本不符就换下一个 */
  const fetchManifest = async (lastSeq) => {
    let last = '没有可用的清单';
    for (const url of feedUrls) {
      try {
        const manifest = await fetchBuf(url, { json: true });
        if (!verifyManifest(manifest, publicKeyPem)) {
          last = `${url} 验签失败`;
          continue;
        }
        const problem = manifestProblem(manifest, { shellVersion, schemaVersion, lastSeq });
        if (problem) {
          last = `${url}：${problem}`;
          continue;
        }
        return { manifest, error: '' };
      } catch (err) {
        last = `${url}：${err?.message || err}`;
      }
    }
    return { manifest: null, error: last };
  };

  /** 把 zip 解到 staging 并逐文件校验；成功返回 staging 路径 */
  const extractVerified = async (buf, manifest) => {
    const staging = dir.staging(manifest.seq);
    rmrf(staging);
    fs.mkdirSync(staging, { recursive: true });
    const zip = await JSZip.loadAsync(buf);
    for (const f of manifest.files) {
      const entry = zip.file(f.path);
      if (!entry) throw new Error(`包里缺文件 ${f.path}`);
      const data = await entry.async('nodebuffer');
      if (data.length !== f.size) throw new Error(`大小不符 ${f.path}`);
      if (sha256(data) !== String(f.sha256).toLowerCase()) throw new Error(`sha256 不符 ${f.path}`);
      const abs = path.join(staging, f.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
    }
    // 清单本身也落盘：启动时靠它验签 + 判断版本，不依赖外部文件
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return staging;
  };

  /**
   * 检查并准备好（不换入）。返回 { updated, seq, notes, error }
   * - 只下载、验、放到 pending-<seq>，真正生效由 boot() 或 applyPending() 负责
   */
  /**
   * @param {{ lastSeqHint?: number }} [opts]
   */
  const check = async ({ lastSeqHint = 0 } = {}) => {
    if (!enabled) return { updated: false, error: '未配置热更公钥' };
    const st = readState();
    const lastSeq = Math.max(Number(st.lastSeq) || 0, Number(st.active?.seq) || 0, Number(lastSeqHint) || 0);
    const { manifest, error } = await fetchManifest(lastSeq);
    if (!manifest) return { updated: false, error };

    // 不校验「整包 sha256」：清单本身就在包里，写不进自己的哈希。
    // 完整性由解包时逐文件比对 sha256 保证（见 extractVerified），不用多一层假检查。
    let buf;
    let packError = '没有可用的下载地址';
    for (const url of manifest.urls) {
      try {
        buf = await fetchBuf(url);
        break;
      } catch (err) {
        packError = `${url}：${err?.message || err}`;
        buf = null;
      }
    }
    if (!buf) return { updated: false, error: packError };

    /** @type {string} */
    let staging;
    try {
      staging = await extractVerified(buf, manifest);
    } catch (err) {
      rmrf(dir.staging(manifest.seq));
      return { updated: false, error: `解包校验失败：${err?.message || err}` };
    }

    // 旧 pending 让位（同一时间只留一份待生效）
    if (st.pending && Number(st.pending.seq) !== manifest.seq) rmrf(dir.pending(Number(st.pending.seq)));
    rmrf(dir.pending(manifest.seq));
    try {
      fs.renameSync(staging, dir.pending(manifest.seq));
    } catch (err) {
      rmrf(staging);
      return { updated: false, error: `落盘失败：${err?.message || err}` };
    }
    const next = readState();
    next.pending = { seq: manifest.seq, at: new Date().toISOString(), notes: manifest.notes || '' };
    next.lastSeq = Math.max(Number(next.lastSeq) || 0, manifest.seq);
    writeState(next);
    return { updated: true, seq: manifest.seq, notes: manifest.notes || '', files: manifest.files.length };
  };

  /** 本地 zip 导入（完全断网时的后路）：用户拿到的包同样要过验签 */
  const importZip = async (zipPath) => {
    if (!enabled) return { updated: false, error: '未配置热更公钥' };
    let buf;
    try {
      buf = fs.readFileSync(zipPath);
    } catch (err) {
      return { updated: false, error: `读不到文件：${err?.message || err}` };
    }
    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file('manifest.json');
    if (!entry) return { updated: false, error: '包里没有 manifest.json' };
    const manifest = JSON.parse(await entry.async('string'));
    if (!verifyManifest(manifest, publicKeyPem)) return { updated: false, error: '验签失败' };
    const st = readState();
    const lastSeq = Math.max(Number(st.lastSeq) || 0, Number(st.active?.seq) || 0);
    const problem = manifestProblem(manifest, { shellVersion, schemaVersion, lastSeq });
    if (problem) return { updated: false, error: problem };
    try {
      const staging = await extractVerified(buf, manifest);
      rmrf(dir.pending(manifest.seq));
      fs.renameSync(staging, dir.pending(manifest.seq));
    } catch (err) {
      // 解包到一半失败会留下半成品目录：按 seq 精确定位清掉，别让它下次被当成包
      rmrf(dir.staging(manifest.seq));
      return { updated: false, error: `解包校验失败：${err?.message || err}` };
    }
    const next = readState();
    next.pending = { seq: manifest.seq, at: new Date().toISOString(), notes: manifest.notes || '' };
    next.lastSeq = Math.max(Number(next.lastSeq) || 0, manifest.seq);
    writeState(next);
    return { updated: true, seq: manifest.seq, notes: manifest.notes || '' };
  };

  /** 「立即生效」用：把 pending 换入。调用方负责先停服、后启服 */
  const applyPending = () => {
    const st = readState();
    if (!st.pending) return { applied: false, seq: 0 };
    const seq = Number(st.pending.seq);
    promote(st);
    return { applied: readState().active?.seq === seq, seq };
  };

  const state = () => {
    const st = readState();
    return {
      enabled,
      activeSeq: Number(st.active?.seq) || 0,
      pendingSeq: Number(st.pending?.seq) || 0,
      pendingNotes: st.pending?.notes || '',
      lastSeq: Number(st.lastSeq) || 0,
      badSeqs: st.bad || [],
    };
  };

  return { boot, markReady, fallbackToBuiltin, check, importZip, applyPending, state, dir };
}

/**
 * manifest 候选地址：Gitee 镜像优先 → GitHub 官方。
 *
 * 顺序按「国内能不能打开」排，不按「哪个更官方」排：GitHub 域名在部分网络下会卡到超时，
 * 先试它等于每次检查都白等 20 秒。Gitee 镜像可能晚几分钟，但旧清单会因为 seq 不涨被拒，
 * 于是自然落到下一个地址 —— 顺序不影响正确性，只影响速度。
 * 两处都必须验签才算数，所以镜像挂了最多是「这次没更新」。
 * @param {{ owner?: string, repo?: string, gitee?: string }} opts gitee 形如 'mr-awei/gallery'
 */
export function defaultFeedUrls({ owner = 'mr-awei', repo = 'gallery', gitee = '' } = {}) {
  const urls = [];
  if (gitee) urls.push(`https://gitee.com/${gitee}/raw/hotfix/manifest.json`);
  urls.push(`https://github.com/${owner}/${repo}/releases/download/hotfix/manifest.json`);
  return urls;
}
