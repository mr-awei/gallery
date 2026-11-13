import { useState } from 'react';
import { api } from '../api';

/**
 * 资源库锁定屏。
 *
 * 当前库设了密码、本次运行还没解锁时，整页停在这里：侧栏、时间线、所有请求都没有数据
 * （服务端对这些接口一律 423），所以这里不能是弹窗——底下什么都没有。
 *
 * 解锁成功后直接 reload：锁定期间统计、文件夹、标签、列表全是空的缓存，逐个复位不如整页重来。
 */
export default function LibraryLockScreen({
  library,
  onUnlocked,
}: {
  library: { id: number; name: string };
  onUnlocked: () => void;
}) {
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!pwd) {
      setErr('请输入密码');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await api.unlockLibrary(library.id, pwd);
      onUnlocked();
    } catch (e) {
      setErr((e as Error).message || '解锁失败');
      setPwd('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lock-screen">
      <div className="lock-card">
        <div className="lock-badge" aria-hidden="true">
          🔒
        </div>
        <h2 className="lock-title">{library.name || '资源库'}</h2>
        <div className="lock-hint">这个资源库已加锁，输入密码才能查看里面的照片</div>
        <input
          className="input lock-input"
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
          placeholder="资源库密码"
          disabled={busy}
        />
        {err && <div className="lock-err">{err}</div>}
        <button className="btn primary lock-submit" disabled={busy} onClick={() => void submit()}>
          {busy ? '解锁中…' : '解锁'}
        </button>
        <div className="lock-note">
          密码在服务端校验，本机只存 scrypt 哈希。解锁只在本次运行有效，重启或切到别的库后要重新输入。
        </div>
      </div>
    </div>
  );
}
