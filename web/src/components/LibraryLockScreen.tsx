import { IconLock } from './Icons';
import { useState } from 'react';
import { api } from '../api';
import i18n from '../i18n';

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
      setErr(i18n.t('ke39ffe99'));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await api.unlockLibrary(library.id, pwd);
      onUnlocked();
    } catch (e) {
      setErr((e as Error).message || i18n.t('k984ac362'));
      setPwd('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lock-screen">
      <div className="lock-card">
        <div className="lock-badge" aria-hidden="true">
          <IconLock size={26} />
        </div>
        <h2 className="lock-title">{library.name || i18n.t('kc99f5cf1')}</h2>
        <div className="lock-hint">{i18n.t('k19bf01f5')}</div>
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
          placeholder={i18n.t('kbcea7593')}
          disabled={busy}
        />
        {err && <div className="lock-err">{err}</div>}
        <button className="btn primary lock-submit" disabled={busy} onClick={() => void submit()}>
          {busy ? i18n.t('k684549b1') : i18n.t('kfa7ffa2d')}
        </button>
        <div className="lock-note">
          {i18n.t('k9e925fba')}
          <br />
          <b>{i18n.t('ke9ba4687')}</b>：库文件夹里的 gallery.db 与缩略图仍是明文，用别的软件或直接拷走都能读。
          要防「整个文件夹被拷走」，请配合系统级磁盘加密（如 BitLocker / FileVault）。
        </div>
      </div>
    </div>
  );
}
