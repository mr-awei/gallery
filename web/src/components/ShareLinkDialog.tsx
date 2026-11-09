/**
 * 库内分享：直接从图库顶栏为「整库 / 当前文件夹 / 选中的素材」生成只读链接。
 * 与设置页的「手机投送」共用同一套令牌：链接只能浏览与搜索，不能上传、不能改库。
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { LanShare, LanStatus } from '../types';
import { IconClose, IconGlobe } from './Icons';

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
  library: '整个资源库',
  folder: '指定文件夹',
  selection: '选中的素材',
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
  const [title, setTitle] = useState(folderName || defaultTitle || '图库分享');
  const [minutes, setMinutes] = useState(60);
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
      onToast(`读取投送状态失败：${(err as Error).message}`, 'error');
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const scopes: { key: Scope; label: string; hint: string }[] = [
    { key: 'library', label: '整个资源库', hint: '对方能看到库里全部可见素材' },
    ...(folderId ? [{ key: 'folder' as Scope, label: '当前文件夹', hint: folderName || '只分享这个文件夹' }] : []),
    ...(hasSelection
      ? [{ key: 'selection' as Scope, label: `已选 ${selectedIds!.length} 张`, hint: '只分享当前选中的素材' }]
      : []),
  ];

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.createLanShare({
        minutes,
        scope,
        ids: scope === 'selection' ? selectedIds : undefined,
        folderId: scope === 'folder' ? Number(folderId) : undefined,
        title: title.trim() || '图库分享',
      });
      setQr(await api.lanShareQrUrl(r.token));
      await refresh();
      onToast('只读分享链接已生成，手机扫码即可浏览');
    } catch (err) {
      onToast(`生成失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: string) => {
    try {
      await api.revokeLanShare(token);
      if (qr.includes(token)) setQr('');
      await refresh();
      onToast('这条分享链接已撤销，对方立即无法访问');
    } catch (err) {
      onToast(`撤销失败：${(err as Error).message}`, 'error');
    }
  };

  const copy = (text: string) =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => onToast('链接已复制'))
      .catch(() => onToast('复制失败，请手动选中', 'error'));

  const enableLan = async () => {
    setBusy(true);
    try {
      await api.setLanAccess(true);
      await refresh();
      onToast('已开启局域网访问，可以生成分享链接了');
    } catch (err) {
      onToast(`开启失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>
            <IconGlobe /> 只读分享链接
          </b>
          <button className="btn ghost sm" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div className="hint" style={{ lineHeight: 1.8, marginBottom: 14 }}>
            生成一条手机扫码即可打开的链接：对方只能浏览与搜索，<b>不能上传、不能修改</b>。
            链接只在内存里，应用重启、到期或手动撤销后立即失效。手机需要与电脑连同一个 Wi-Fi。
          </div>

          {status && !status.enabled && (
            <div className="field" style={{ padding: 12, border: '1px solid var(--warn)', borderRadius: 10 }}>
              <b>局域网访问还没开启</b>
              <div className="hint" style={{ margin: '6px 0 10px' }}>分享链接需要一个独立的投送端口；开启后主服务仍然只监听 127.0.0.1。</div>
              <button className="btn sm" disabled={busy} onClick={() => void enableLan()}>
                开启局域网访问
              </button>
            </div>
          )}

          <div className="field">
            <label>分享范围</label>
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
              <label>标题（手机页顶部显示）</label>
              <input
                className="input"
                style={{ width: '100%' }}
                maxLength={60}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 130 }}>
              <label>有效期</label>
              <select
                className="select"
                style={{ width: '100%', padding: '7px 8px', borderRadius: 8 }}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              >
                <option value={30}>30 分钟</option>
                <option value={60}>1 小时</option>
                <option value={180}>3 小时</option>
                <option value={1440}>1 天</option>
                <option value={10080}>7 天</option>
              </select>
            </div>
          </div>

          <button className="btn" disabled={busy || !status?.enabled} onClick={() => void create()}>
            生成只读链接
          </button>

          {qr && (
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginTop: 16, flexWrap: 'wrap' }}>
              <img key={qr} src={qr} alt="分享二维码" style={{ width: 148, height: 148, background: '#fff', padding: 4, borderRadius: 8 }} />
              <div className="hint" style={{ flex: 1, minWidth: 220, lineHeight: 1.8 }}>
                <b>扫这个码打开只读页面</b>
                <br />
                手机浏览器支持「添加到主屏幕」，之后不用再扫码；离线浏览需要 HTTPS 访问。
                <br />
                列表与单张缩略图都会按上面的范围校验，换个 id 也看不到范围外的素材。
              </div>
            </div>
          )}

          {shares.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div className="settings-subhead">已生成的链接（{shares.length}）</div>
              {shares.map((s) => (
                <div key={s.token} style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 13 }}>{s.title || '未命名分享'}</b>
                    <span className="hint">
                      {SCOPE_LABEL[s.scope || 'library']}
                      {s.scope === 'selection' ? ` · ${s.ids?.length || 0} 张` : ''} · 到{' '}
                      {new Date(s.expiresAt).toLocaleString()}
                    </span>
                    <button className="btn sm ghost" onClick={() => void copy(s.urls[0] || '')}>复制链接</button>
                    <button className="btn sm ghost" onClick={() => void revoke(s.token)}>撤销</button>
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
                  onToast('已撤销全部分享链接');
                }}
              >
                全部撤销
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
