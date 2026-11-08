import { useState } from 'react';
import { api } from '../api';
import type { FolderNode } from '../types';
import { IconClose } from './Icons';

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
      onToast('请输入密码', 'error');
      return false;
    }
    if ((mode === 'set' || mode === 'change') && pwd !== pwd2) {
      onToast('两次输入的密码不一致', 'error');
      return false;
    }
    return true;
  };

  const submit = () => {
    if (!need()) return;
    // 改密码 / 移除密码都要旧密码，第二个输入框在那种模式下装的就是旧密码
    const old = mode === 'change' || mode === 'remove' ? pwd2 : '';
    if (mode === 'unlock') return void run(() => api.unlockFolder(folder.id, pwd), '已解锁（仅本次会话）');
    if (mode === 'set') return void run(() => api.setFolderPassword(folder.id, pwd), '已加锁');
    if (mode === 'change') return void run(() => api.setFolderPassword(folder.id, pwd, old), '密码已更新');
    return void run(() => api.clearFolderPassword(folder.id, old), '已移除密码');
  };

  const title =
    mode === 'unlock'
      ? `解锁「${folder.name}」`
      : mode === 'set'
        ? `给「${folder.name}」加锁`
        : mode === 'change'
          ? `修改「${folder.name}」的密码`
          : `移除「${folder.name}」的密码`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{title}</b>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          {folder.locked && folder.unlocked && mode === 'change' && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
              <button
                className="btn sm"
                disabled={busy}
                onClick={() => void run(() => api.sealFolder(folder.id), '已重新上锁')}
              >
                重新上锁
              </button>
              <button className="btn sm" onClick={() => setMode('remove')}>
                移除密码
              </button>
            </div>
          )}

          {(mode === 'set' || mode === 'change') && (
            <div className="field">
              <label>{mode === 'change' ? '新密码' : '密码'}</label>
              <input
                className="input"
                type="password"
                autoFocus
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                placeholder="至少 4 位"
              />
            </div>
          )}

          {mode !== 'unlock' && (
            <div className="field">
              <label>{mode === 'set' ? '再输一次' : mode === 'change' ? '原密码' : '密码'}</label>
              <input
                className="input"
                type="password"
                value={pwd2}
                onChange={(e) => setPwd2(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder={mode === 'set' ? '确认密码' : '当前密码'}
              />
            </div>
          )}

          {mode === 'unlock' && (
            <div className="field">
              <label>密码</label>
              <input
                className="input"
                type="password"
                autoFocus
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="输入文件夹密码"
              />
            </div>
          )}

          <div className="settings-desc" style={{ margin: '4px 0 0' }}>
            {mode === 'set' || mode === 'change'
              ? '密码只保存在本机（scrypt 哈希），忘记后只能从磁盘上删库解锁，请记牢。'
              : '解锁只在本次运行期间有效；重启应用会自动回到锁定状态。'}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn sm" onClick={onClose}>
            取消
          </button>
          <button className="btn sm primary" disabled={busy} onClick={submit}>
            {busy ? '处理中…' : mode === 'unlock' ? '解锁' : mode === 'set' ? '加锁' : mode === 'change' ? '保存' : '确认移除'}
          </button>
        </div>
      </div>
    </div>
  );
}
