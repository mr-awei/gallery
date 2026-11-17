// @ts-check
/**
 * 多端同步 API：同步文件夹 + 带 revision 的库快照。
 *
 * 不做在线账号 / 实时行级合并。发布走 backupLibrary（VACUUM INTO 干净快照），
 * 拉取走 restoreLibrary（登记为新资源库 + 路径重映射），两者都是已有且验证过的链路。
 * 原图不进快照：原图由用户自己的同步盘 / 素材目录负责，README 里说清楚。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { db } from '../db.js';
import { getActiveLibrary } from '../libraries.js';
import { backupLibrary, restoreLibrary } from '../lib/transfer.js';
import {
  SYNC_FORMAT,
  SYNC_VERSION,
  SNAPSHOT_FILES,
  sha256,
  validateManifest,
  fingerprintOf,
  syncDecision,
  canPublish,
  hasLocalBaseline,
} from '../lib/sync.js';

const STATE_FILE = path.join(DATA_DIR, 'sync-state.json');

function defaultState() {
  return {
    syncDir: '',
    deviceId: crypto.randomUUID(),
    lastPublishedRevision: 0,
    lastPulledRevision: 0,
    lastPublishedFingerprint: '',
  };
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { ...defaultState(), ...raw };
  } catch {
    const fresh = defaultState();
    writeState(fresh);
    return fresh;
  }
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function localFingerprint() {
  const a = db.prepare('SELECT COUNT(*) AS c, COALESCE(MAX(id),0) AS m FROM images').get() || {};
  let ops = 0;
  let folders = 0;
  try {
    ops = Number(db.prepare('SELECT COALESCE(MAX(id),0) AS o FROM op_log').get()?.o || 0);
  } catch {
    /* 旧库可能还没有撤销栈 */
  }
  try {
    folders = Number(db.prepare('SELECT COUNT(*) AS c FROM image_folders').get()?.c || 0);
  } catch {
    /* 旧库可能还没有文件夹表 */
  }
  return fingerprintOf({ images: Number(a.c || 0), maxImage: Number(a.m || 0), maxOp: ops, folders });
}

function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return { manifest: null, error: '' };
  try {
    const parsed = validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.error ? { manifest: null, error: parsed.error } : { manifest: parsed.manifest, error: '' };
  } catch (err) {
    return { manifest: null, error: `同步清单读取失败：${err?.message || err}` };
  }
}

function requireDir(state, res) {
  if (!state.syncDir) {
    res.status(400).json({ error: '还没有设置同步文件夹' });
    return false;
  }
  if (!fs.existsSync(state.syncDir)) {
    res.status(400).json({ error: `同步文件夹不存在：${state.syncDir}` });
    return false;
  }
  return true;
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get(
    '/api/sync/status',
    asyncRoute(async (_req, res) => {
      const st = readState();
      const { manifest, error } = st.syncDir ? readManifest(st.syncDir) : { manifest: null, error: '' };
      const fp = localFingerprint();
      res.json({
        ok: true,
        enabled: !!st.syncDir,
        syncDir: st.syncDir,
        deviceId: st.deviceId,
        localRevision: Math.max(st.lastPulledRevision, st.lastPublishedRevision),
        remoteRevision: manifest?.revision || 0,
        remoteDevice: manifest?.deviceId || '',
        publishedAt: manifest?.publishedAt || '',
        libraryName: manifest?.libraryName || '',
        dirty: hasLocalBaseline(st) && fp !== st.lastPublishedFingerprint,
        manifestError: error,
        note: '传输层是同步文件夹；快照只含元数据，原图由素材目录自行同步；拉取会登记为一个新资源库',
      });
    })
  );

  app.post(
    '/api/sync/configure',
    asyncRoute(async (req, res) => {
      const raw = String(req.body?.syncDir || '').trim();
      const st = readState();
      if (!raw) {
        writeState({ ...st, syncDir: '' });
        return res.json({ ok: true, enabled: false, note: '已关闭同步（同步文件夹里的快照保留）' });
      }
      if (!path.isAbsolute(raw) || raw.includes('..')) {
        return res.status(400).json({ error: '同步文件夹必须是绝对路径' });
      }
      try {
        fs.mkdirSync(raw, { recursive: true });
        fs.accessSync(raw, fs.constants.W_OK);
      } catch (err) {
        return res.status(400).json({ error: `同步文件夹不可写：${err?.message || err}` });
      }
      writeState({ ...st, syncDir: raw });
      res.json({ ok: true, enabled: true, syncDir: raw });
    })
  );

  app.post(
    '/api/sync/publish',
    asyncRoute(async (req, res) => {
      const st = readState();
      if (!requireDir(st, res)) return;
      const { manifest, error } = readManifest(st.syncDir);
      if (error) return res.status(400).json({ error });
      const gate = canPublish({
        deviceId: st.deviceId,
        lastPulledRevision: st.lastPulledRevision,
        remote: manifest,
      });
      if (!gate.ok) return res.status(409).json({ error: gate.reason });

      // 用「数据指纹」而不是文件字节判断是否变化：library.json 里带导出时间，
      // 每次备份的字节必然不同，按文件 hash 比会永远判成「有变化」。
      // 指纹没变时连 VACUUM INTO 都不跑，真正 0 字节传输。
      const fp = localFingerprint();
      const unchanged =
        !!manifest && manifest.deviceId === st.deviceId && manifest.fingerprint === fp;
      if (unchanged && !req.body?.force) {
        return res.json({
          ok: true,
          unchanged: true,
          revision: manifest.revision,
          note: '本机数据与上一版相同，未写同步盘（增量跳过，0 字节传输）',
        });
      }

      // 临时目录放在本机数据目录，不能放同步盘：否则网盘会把半成品也同步走
      const tmpRoot = path.join(DATA_DIR, 'sync-tmp');
      fs.mkdirSync(tmpRoot, { recursive: true });
      let backup;
      try {
        backup = backupLibrary({ targetDir: tmpRoot, includeThumbs: false });
      } catch (err) {
        return res.status(500).json({ error: `生成快照失败：${err?.message || err}` });
      }
      const files = SNAPSHOT_FILES.map((name) => {
        const buffer = fs.readFileSync(path.join(backup.dir, name));
        return { name, buffer, sha256: sha256(buffer), size: buffer.length };
      });

      const snapDir = path.join(st.syncDir, 'snapshot');
      fs.mkdirSync(snapDir, { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(snapDir, f.name), f.buffer);
      const revision = (manifest?.revision || 0) + 1;
      const active = getActiveLibrary();
      const next = {
        format: SYNC_FORMAT,
        version: SYNC_VERSION,
        revision,
        publishedAt: new Date().toISOString(),
        deviceId: st.deviceId,
        libraryId: active?.id || '',
        libraryName: active?.name || '图库',
        rootPath: active?.root_path || '',
        counts: backup.counts,
        fingerprint: fp,
        files: files.map((f) => ({ name: f.name, sha256: f.sha256, size: f.size })),
      };
      fs.writeFileSync(path.join(st.syncDir, 'manifest.json'), JSON.stringify(next, null, 2), 'utf8');
      writeState({
        ...st,
        lastPublishedRevision: revision,
        lastPulledRevision: revision,
        lastPublishedFingerprint: fp,
      });
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      res.json({
        ok: true,
        unchanged: false,
        revision,
        bytes: files.reduce((n, f) => n + f.size, 0),
        counts: backup.counts,
        note: '已发布元数据快照；原图不会进同步盘，请让素材目录自行同步',
      });
    })
  );

  app.post(
    '/api/sync/pull',
    asyncRoute(async (req, res) => {
      const st = readState();
      if (!requireDir(st, res)) return;
      const { manifest, error } = readManifest(st.syncDir);
      if (error) return res.status(400).json({ error });
      if (!manifest) return res.status(404).json({ error: '同步文件夹里还没有任何设备发布过快照' });

      // 逐个校验 sha256：网盘经常只同步了一半文件，不能拿半截 DB 去建库
      for (const f of manifest.files) {
        const p = path.join(st.syncDir, 'snapshot', f.name);
        if (!fs.existsSync(p)) {
          return res.status(409).json({ error: `快照文件 ${f.name} 还没同步到本机，请等网盘传完再拉取` });
        }
        if (sha256(fs.readFileSync(p)) !== f.sha256) {
          return res.status(409).json({ error: `快照文件 ${f.name} 校验和不匹配，可能只传了一半，请重新同步` });
        }
      }
      const fp = localFingerprint();
      const dirty = hasLocalBaseline(st) && fp !== st.lastPublishedFingerprint;
      const force = req.body?.force === true;
      const decision = syncDecision({
        localRevision: st.lastPulledRevision,
        remoteRevision: manifest.revision,
        dirty,
        force,
      });
      if (decision.action === 'up-to-date') {
        return res.json({ ok: true, skipped: true, reason: decision.reason, revision: manifest.revision });
      }
      if (decision.action === 'conflict') {
        return res.status(409).json({ error: decision.reason, revision: manifest.revision });
      }

      const tmp = path.join(DATA_DIR, `sync-pull-${Date.now()}`);
      fs.mkdirSync(tmp, { recursive: true });
      try {
        for (const f of manifest.files) {
          fs.copyFileSync(path.join(st.syncDir, 'snapshot', f.name), path.join(tmp, f.name));
        }
        const active = getActiveLibrary();
        const restored = restoreLibrary({
          sourceDir: tmp,
          name: String(req.body?.name || `${manifest.libraryName}（同步 r${manifest.revision}）`).slice(0, 80),
          rootPath: String(req.body?.rootPath || active?.root_path || '').trim(),
        });
        writeState({
          ...st,
          lastPulledRevision: manifest.revision,
          lastPublishedRevision: manifest.revision,
          lastPublishedFingerprint: fp,
        });
        res.json({
          ok: true,
          skipped: false,
          revision: manifest.revision,
          reason: decision.reason,
          forced: force,
          libraryId: restored.id,
          libraryName: restored.name,
          remapped: restored.remapped,
          missing: restored.missing,
          note: restored.note,
        });
      } catch (err) {
        return res.status(500).json({ error: `拉取失败：${err?.message || err}` });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    })
  );
}
