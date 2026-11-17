import { useState } from 'react';
import { api } from '../api';
import type { FolderNode } from '../types';
import { IconClose } from './Icons';
import i18n from '../i18n';

/**
 * 文件夹密码锁 / 隐私空间。
 *
 * 三态：
 * - 未加锁 → 设一个密码（≥4 位）
 * - 已加锁、本次会话未解锁 → 输入密码解锁
 * - 已加锁、已解锁 → 重新上锁 / 改密码 / 移除密码
 *
 * 密码永远只在服务端校验，前端拿不到哈希；「未解锁」时服务端连素材列表都不返回。
 */
export default function FolderLockDialog({
  folder,
  onClose,
  onFolders,
  onToast,
}: {
  folder: FolderNode;
  onClose: () => void;
  onFolders: (folders: FolderNode[]) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}) {
  const [mode, setMode] = useState<'unlock' | 'set' | 'change' | 'remove'>(
    folder.locked ? (folder.unlocked ? 'change' : 'unlock') : 'set'
  );
  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<{ folders: FolderNode[] }>, okMsg: string) => {
    setBusy(true);
    try {
      const r = await fn();
      onFolders(r.folders);
      onToast(okMsg);
      onClose();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const need = () => {
    if (!pwd) {
      onToast(i18n.t('ke39ffe99'), 'error');
      return false;
    }
    if ((mode === 'set' || mode === 'change') && pwd !== pwd2) {
      onToast(i18n.t('k6046d642'), 'error');
      return false;
    }
    return true;
  };

  const submit = () => {
    if (!need()) return;
    // 改密码 / 移除密码都要旧密码，第二个输入框在那种模式下装的就是旧密码
    const old = mode === 'change' || mode === 'remove' ? pwd2 : '';
    if (mode === 'unlock') return void run(() => api.unlockFolder(folder.id, pwd), i18n.t('k050c7433'));
    if (mode === 'set') return void run(() => api.setFolderPassword(folder.id, pwd), i18n.t('k3dc28e89'));
    if (mode === 'change') return void run(() => api.setFolderPassword(folder.id, pwd, old), i18n.t('kfd5a3cf1'));
    return void run(() => api.clearFolderPassword(folder.id, old), i18n.t('kabc87225'));
  };

  const title =
    mode === 'unlock'
      ? i18n.t('kf7469344', { p0: folder.name })
      : mode === 'set'
        ? i18n.t('ke6205fc0', { p0: folder.name })
        : mode === 'change'
          ? i18n.t('k40aab159', { p0: folder.name })
          : i18n.t('k5badf86c', { p0: folder.name });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{title}</b>
          <button className="icon-btn" onClick={onClose} title={i18n.t('kb15d9127')}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          {folder.locked && folder.unlocked && mode === 'change' && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
              <button
                className="btn sm"
                disabled={busy}
                onClick={() => void run(() => api.sealFolder(folder.id), i18n.t('k10eff0fb'))}
              >
                {i18n.t('k81db78dc')}
              </button>
              <button className="btn sm" onClick={() => setMode('remove')}>
                {i18n.t('k7134b8c3')}
              </button>
            </div>
          )}

          {(mode === 'set' || mode === 'change') && (
            <div className="field">
              <label>{mode === 'change' ? i18n.t('kbf7da0bf') : i18n.t('ka8105204')}</label>
              <input
                className="input"
                type="password"
                autoFocus
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                placeholder={i18n.t('k552fd502')}
              />
            </div>
          )}

          {mode !== 'unlock' && (
            <div className="field">
              <label>{mode === 'set' ? i18n.t('k33372d21') : mode === 'change' ? i18n.t('k01e94436') : i18n.t('ka8105204')}</label>
              <input
                className="input"
                type="password"
                value={pwd2}
                onChange={(e) => setPwd2(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder={mode === 'set' ? i18n.t('k3fbdde13') : i18n.t('ka806ce95')}
              />
            </div>
          )}

          {mode === 'unlock' && (
            <div className="field">
              <label>{i18n.t('ka8105204')}</label>
              <input
                className="input"
                type="password"
                autoFocus
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder={i18n.t('k238bc5c4')}
              />
            </div>
          )}

          <div className="settings-desc" style={{ margin: '4px 0 0' }}>
            {mode === 'set' || mode === 'change'
              ? i18n.t('k90f81d9d')
              : i18n.t('kb36cd4ac')}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn sm" onClick={onClose}>
            {i18n.t('k625fb26b')}
          </button>
          <button className="btn sm primary" disabled={busy} onClick={submit}>
            {busy ? i18n.t('kcf978c02') : mode === 'unlock' ? i18n.t('kfa7ffa2d') : mode === 'set' ? i18n.t('kbba1928e') : mode === 'change' ? i18n.t('kbe5fbbe3') : i18n.t('ke2cfe794')}
          </button>
        </div>
      </div>
    </div>
  );
}
