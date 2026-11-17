/**
 * 库内分享：直接从图库顶栏为「整库 / 当前文件夹 / 选中的素材」生成只读链接。
 * 与设置页的「手机投送」共用同一套令牌：链接只能浏览与搜索，不能上传、不能改库。
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { LanShare, LanStatus } from '../types';
import { IconClose, IconGlobe } from './Icons';
import i18n from '../i18n';

interface Props {
  defaultTitle: string;
  folderId?: number | null;
  folderName?: string;
  selectedIds?: number[];
  onClose: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

type Scope = 'library' | 'folder' | 'selection';

const SCOPE_LABEL: Record<Scope, string> = {
  library: i18n.t('kcff473ab'),
  folder: i18n.t('kde88d21d'),
  selection: i18n.t('k917ca133'),
};

export default function ShareLinkDialog({
  defaultTitle,
  folderId,
  folderName,
  selectedIds,
  onClose,
  onToast,
}: Props) {
  const hasSelection = !!selectedIds?.length;
  const [scope, setScope] = useState<Scope>(hasSelection ? 'selection' : folderId ? 'folder' : 'library');
  const [title, setTitle] = useState(folderName || defaultTitle || i18n.t('kd602cbf4'));
  const [minutes, setMinutes] = useState(60);
  const [password, setPassword] = useState('');
  const [allowDownload, setAllowDownload] = useState(true);
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [shares, setShares] = useState<LanShare[]>([]);
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const s = await api.lanStatus();
      setStatus(s);
      if (s.enabled) setShares((await api.lanShares()).shares || []);
      else setShares([]);
    } catch (err) {
      onToast(i18n.t('k47db8442', { p0: (err as Error).message }), 'error');
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const scopes: { key: Scope; label: string; hint: string }[] = [
    { key: 'library', label: i18n.t('kcff473ab'), hint: i18n.t('k00b7e4d8') },
    ...(folderId ? [{ key: 'folder' as Scope, label: i18n.t('k1f9ea1b1'), hint: folderName || i18n.t('k038092ba') }] : []),
    ...(hasSelection
      ? [{ key: 'selection' as Scope, label: i18n.t('kff8fd594', { p0: selectedIds!.length }), hint: i18n.t('k9304f0d7') }]
      : []),
  ];

  const create = async () => {
    if (busy) return;
    // 前端先挡一道：4 位以下等于没设密码，让用户以为设了最危险
    if (password && (password.length < 4 || password.length > 64)) {
      onToast(i18n.t('kaf948ce9'), 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await api.createLanShare({
        minutes,
        scope,
        ids: scope === 'selection' ? selectedIds : undefined,
        folderId: scope === 'folder' ? Number(folderId) : undefined,
        title: title.trim() || i18n.t('kd602cbf4'),
        password: password || undefined,
        allowDownload,
      });
      setQr(await api.lanShareQrUrl(r.token));
      await refresh();
      onToast(
        password
          ? i18n.t('k14d21f43')
          : i18n.t('kf5cfdb4d')
      );
    } catch (err) {
      onToast(i18n.t('k7f52ecb6', { p0: (err as Error).message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: string) => {
    try {
      await api.revokeLanShare(token);
      if (qr.includes(token)) setQr('');
      await refresh();
      onToast(i18n.t('kee0b2b27'));
    } catch (err) {
      onToast(i18n.t('k5b0be54d', { p0: (err as Error).message }), 'error');
    }
  };

  const copy = (text: string) =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => onToast(i18n.t('k4b7d6310')))
      .catch(() => onToast(i18n.t('k63e6737e'), 'error'));

  const enableLan = async () => {
    setBusy(true);
    try {
      await api.setLanAccess(true);
      await refresh();
      onToast(i18n.t('k6973ff7d'));
    } catch (err) {
      onToast(i18n.t('k4b4487c5', { p0: (err as Error).message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>
            <IconGlobe /> {i18n.t('ka14f1a96')}
          </b>
          <button className="btn ghost sm" onClick={onClose} title={i18n.t('kb15d9127')}>
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div className="hint" style={{ lineHeight: 1.8, marginBottom: 14 }}>
            {i18n.t('k87821561')}<b>{i18n.t('k0dd4389f')}</b>。
            链接只在内存里，应用重启、到期或手动撤销后立即失效。手机需要与电脑连同一个 Wi-Fi。
          </div>

          {status && !status.enabled && (
            <div className="field" style={{ padding: 12, border: '1px solid var(--warn)', borderRadius: 10 }}>
              <b>{i18n.t('kb6aa4563')}</b>
              <div className="hint" style={{ margin: '6px 0 10px' }}>{i18n.t('k32e14f66')}</div>
              <button className="btn sm" disabled={busy} onClick={() => void enableLan()}>
                {i18n.t('kb47f8792')}
              </button>
            </div>
          )}

          <div className="field">
            <label>{i18n.t('k9b91ed4b')}</label>
            <div className="export-scope">
              {scopes.map((s) => (
                <label key={s.key} className={`export-scope-item${scope === s.key ? ' active' : ''}`}>
                  <input type="radio" name="share-scope" checked={scope === s.key} onChange={() => setScope(s.key)} />
                  <span>
                    <b>{s.label}</b>
                    <i>{s.hint}</i>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div className="field" style={{ flex: 2, minWidth: 220 }}>
              <label>{i18n.t('kf58f141e')}</label>
              <input
                className="input"
                style={{ width: '100%' }}
                maxLength={60}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 130 }}>
              <label>{i18n.t('kbb114ab9')}</label>
              <select
                className="select"
                style={{ width: '100%', padding: '7px 8px', borderRadius: 8 }}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              >
                <option value={30}>{i18n.t('ke856b618')}</option>
                <option value={60}>{i18n.t('k7a3bc120')}</option>
                <option value={180}>{i18n.t('k1ee83072')}</option>
                <option value={1440}>{i18n.t('k78c2dcbe')}</option>
                <option value={10080}>{i18n.t('kfdef8c23')}</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <label>{i18n.t('k2dfb8f41')}</label>
              <input
                className="input"
                style={{ width: '100%' }}
                type="text"
                autoComplete="new-password"
                placeholder={i18n.t('k9b533f55')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                maxLength={64}
              />
              <div className="hint" style={{ marginTop: 4 }}>
                {i18n.t('k1ef52953')}
              </div>
            </div>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center', paddingBottom: 6 }}>
              <input type="checkbox" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} />
              {i18n.t('k84298930')}
            </label>
          </div>

          <button className="btn" disabled={busy || !status?.enabled} onClick={() => void create()}>
            {i18n.t('k2cd455f6')}
          </button>

          {qr && (
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginTop: 16, flexWrap: 'wrap' }}>
              <img key={qr} src={qr} alt={i18n.t('k2dc98e4a')} style={{ width: 148, height: 148, background: '#fff', padding: 4, borderRadius: 8 }} />
              <div className="hint" style={{ flex: 1, minWidth: 220, lineHeight: 1.8 }}>
                <b>{i18n.t('k6fb642a6')}</b>
                <br />
                {i18n.t('k4c582f25')}
                <br />
                {i18n.t('kccdefebd')}
              </div>
            </div>
          )}

          {shares.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div className="settings-subhead">已生成的链接（{shares.length}）</div>
              {shares.map((s) => (
                <div key={s.token} style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 13 }}>{s.title || i18n.t('ke852d4d5')}</b>
                    <span className="hint">
                      {SCOPE_LABEL[s.scope || 'library']}
                      {s.scope === 'selection' ? i18n.t('k12558f70', { p0: s.ids?.length || 0 }) : ''} · 到{' '}
                      {new Date(s.expiresAt).toLocaleString()}
                      {s.hasPassword ? i18n.t('k9e263c1b') : ''}
                      {s.allowDownload === false ? i18n.t('kc89af83f') : ''}
                    </span>
                    <button className="btn sm ghost" onClick={() => void copy(s.urls[0] || '')}>{i18n.t('k879058ce')}</button>
                    <button className="btn sm ghost" onClick={() => void revoke(s.token)}>{i18n.t('kbd9fcf46')}</button>
                  </div>
                  <input
                    className="input"
                    style={{ width: '100%', marginTop: 6 }}
                    readOnly
                    value={s.urls[0] || ''}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </div>
              ))}
              <button
                className="btn sm ghost"
                style={{ marginTop: 12 }}
                onClick={async () => {
                  await api.revokeLanShares();
                  setQr('');
                  await refresh();
                  onToast(i18n.t('kee8a4138'));
                }}
              >
                {i18n.t('kd80cec99')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
