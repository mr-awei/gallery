import { useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import type { Library } from '../types';
import { IconClose } from './Icons';

/**
 * 资源库密码对话框（切换器行菜单与「切到加密库」共用）。
 *
 * 四态：
 * - unlock：点了一个加锁的库，输密码切过去（切库走 App 的完整流程，所以用 onSwitch）
 * - set：还没密码，设一个（≥4 位，两次确认）
 * - change：改密码（要原密码）
 * - remove：移除密码（要原密码）
 *
 * 与文件夹锁一致：密码只在服务端校验，前端拿不到哈希；忘记密码只能从磁盘上删库解锁。
 */
export default function LibraryLockDialog({
  library,
  mode,
  onClose,
  onChanged,
  onSwitch,
}: {
  library: Library;
  mode: 'unlock' | 'set' | 'change' | 'remove';
  onClose: () => void;
  /** 设置 / 修改 / 移除密码后回调，用来刷新库列表的锁状态 */
  onChanged: () => void;
  /** 解锁并切过去：成功返回 null，失败返回错误信息（由对话框自己显示） */
  onSwitch?: (id: number, password: string) => Promise<string | null>;
}) {
  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (mode === 'remove') {
      // 移除只问原密码：没有「新密码」这回事，多一个空框只会让人以为要填两遍
      if (!pwd2) {
        setErr('请输入原密码');
        return;
      }
    } else {
      if (!pwd) {
        setErr('请输入密码');
        return;
      }
      if (mode === 'set' && pwd !== pwd2) {
        setErr('两次输入的密码不一致');
        return;
      }
    }
    setBusy(true);
    setErr('');
    try {
      if (mode === 'unlock') {
        const msg = await onSwitch?.(library.id, pwd);
        if (msg) {
          setErr(msg);
          setBusy(false);
          return;
        }
        onClose();
        return;
      }
      if (mode === 'set') {
        await api.setLibraryPassword(library.id, pwd);
      } else if (mode === 'change') {
        await api.setLibraryPassword(library.id, pwd, pwd2); // 这种模式下第二个框装的是原密码
      } else {
        await api.clearLibraryPassword(library.id, pwd2);
      }
      onChanged();
      onClose();
    } catch (e) {
      setErr((e as Error).message || '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === 'unlock'
      ? `解锁「${library.name}」`
      : mode === 'set'
        ? `给「${library.name}」加密码`
        : mode === 'change'
          ? `修改「${library.name}」的密码`
          : `移除「${library.name}」的密码`;

  // 必须挂到 body：这个对话框由侧栏里的资源库切换器渲染，而 .sidebar 有
  // backdrop-filter（会把自己变成 fixed 后代的包含块）且 overflow-x:hidden，
  // 不 portal 出去时 fixed 遮罩只能铺满侧栏，输入框被侧栏右缘裁掉半截。
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{title}</b>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>
        <div className="modal-body lock-body">
          {mode === 'unlock' ? (
            <div className="field">
              <label>密码</label>
              <input
                className="input"
                type="password"
                autoFocus
                value={pwd}
                onChange={(e) => {
                  setPwd(e.target.value);
                  if (err) setErr('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit();
                }}
                placeholder="输入资源库密码"
              />
            </div>
          ) : (
            <>
              {mode !== 'remove' && (
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
              <div className="field">
                <label>{mode === 'set' ? '再输一次' : '原密码'}</label>
                <input
                  className="input"
                  type="password"
                  autoFocus={mode === 'remove'}
                  value={pwd2}
                  onChange={(e) => setPwd2(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submit();
                  }}
                  placeholder={mode === 'set' ? '确认密码' : '当前密码'}
                />
              </div>
            </>
          )}

          {err && <div className="lock-err" style={{ marginTop: 8 }}>{err}</div>}

          <div className="settings-desc" style={{ margin: '10px 0 0' }}>
            {mode === 'unlock'
              ? '解锁只在本次运行有效；切到别的库或重启应用后会重新锁上。'
              : '加锁后打开/切换到这个库要输密码，其它库不受影响。密码只存 scrypt 哈希，忘记后只能从磁盘上删库解锁。'}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn sm" onClick={onClose}>
            取消
          </button>
          <button className="btn sm primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '处理中…' : mode === 'unlock' ? '解锁并切换' : mode === 'set' ? '加密码' : mode === 'change' ? '保存' : '确认移除'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
