// @ts-check
/**
 * 多端同步的决策层（纯函数，可离线单测）。
 *
 * 产品边界：不自建云账号、不做实时行级合并。传输层是用户自己的同步文件夹
 * （任意网盘 / 共享盘 / U 盘），两端显式「发布 / 拉取」一个带 revision 的库快照。
 * 「增量」体现在：内容没变不写同步盘、revision 相同不重复拉取、按 sha256
 * 校验并只复制变化的文件 —— 不谎称行级增量合并。
 */
import crypto from 'node:crypto';

export const SYNC_FORMAT = 'tuku.sync';
export const SYNC_VERSION = 1;
export const SNAPSHOT_FILES = ['gallery.db', 'library.json'];

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '同步清单为空' };
  if (raw.format !== SYNC_FORMAT) return { error: '这不是图库同步文件夹（找不到 tuku.sync 清单）' };
  if (Number(raw.version) > SYNC_VERSION) {
    return { error: `同步清单版本 ${raw.version} 高于当前支持的 ${SYNC_VERSION}，请先升级应用` };
  }
  const revision = Number(raw.revision);
  if (!Number.isInteger(revision) || revision < 1) return { error: '同步清单的 revision 不合法' };
  if (!Array.isArray(raw.files) || raw.files.length !== SNAPSHOT_FILES.length) {
    return { error: '同步清单里的文件列表不完整' };
  }
  for (const f of raw.files) {
    if (!SNAPSHOT_FILES.includes(f?.name) || !/^[a-f0-9]{64}$/.test(String(f?.sha256 || ''))) {
      return { error: `同步清单里的文件校验和不合法：${String(f?.name || '?')}` };
    }
  }
  // 两条都写成 gallery.db 也能通过上面的循环；必须保证每个必需文件恰好出现一次，
  // 否则 pull 会跳过 library.json 的校验，最后在 restoreLibrary 处 500。
  const names = raw.files.map((f) => f.name);
  if (SNAPSHOT_FILES.some((n) => names.filter((x) => x === n).length !== 1)) {
    return { error: '同步清单里的文件列表有重复或缺失' };
  }
  return {
    manifest: {
      ...raw,
      revision,
      deviceId: String(raw.deviceId || ''),
      libraryName: String(raw.libraryName || '同步的资源库').slice(0, 80),
      files: raw.files.map((f) => ({ name: f.name, sha256: f.sha256, size: Number(f.size) || 0 })),
    },
  };
}

/**
 * 本机是否已有同步基线。
 * 以前写成 lastPublishedRevision > 0，导致「本机只拉取过、之后又改了数据」
 * 永远判成不脏，冲突分支形同虚设；从未发布也从未拉取的全新机器则不该报冲突。
 */
export function hasLocalBaseline(st) {
  return Number(st?.lastPublishedRevision) > 0 || Number(st?.lastPulledRevision) > 0;
}

/** 本机数据指纹：用于判断「上次发布之后本地是否又改过」 */
export function fingerprintOf(snapshot) {
  const s = snapshot || {};
  return [s.images ?? 0, s.maxImage ?? 0, s.maxOp ?? 0, s.folders ?? 0].join(':');
}

/**
 * 拉取决策：已经是最新就 0 字节跳过；本地有未发布改动则默认拒绝覆盖，
 * force 才允许（并会在响应里明确说明放弃了本机改动）。
 */
export function syncDecision({ localRevision = 0, remoteRevision = 0, dirty = false, force = false } = {}) {
  if (!remoteRevision || remoteRevision <= localRevision) {
    return { action: 'up-to-date', reason: '本机已是最新，无需拉取' };
  }
  if (dirty && !force) {
    return {
      action: 'conflict',
      reason: '本机在上次发布之后还有改动；请先发布本机改动，或确认放弃后使用「强制拉取」',
    };
  }
  return { action: 'pull', reason: `从第 ${localRevision} 版拉取到第 ${remoteRevision} 版` };
}

/** 发布决策：别的设备发布了更新的版本且本机没拉过，禁止本机覆盖 */
export function canPublish({ deviceId = '', lastPulledRevision = 0, remote = null } = {}) {
  if (!remote || !remote.revision) return { ok: true, reason: '' };
  if (remote.deviceId && remote.deviceId !== deviceId && lastPulledRevision < remote.revision) {
    return { ok: false, reason: `其它设备已发布第 ${remote.revision} 版，请先拉取再发布，避免覆盖对方的改动` };
  }
  return { ok: true, reason: '' };
}
