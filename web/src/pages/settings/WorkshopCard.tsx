import { useEffect, useRef, useState } from 'react';
import { api, type ThemePackBrief } from '../../api';
import { applyThemePack, getStoredTheme, type ThemePackTheme } from '../../theme';
import Card from './Card';
import i18n from '../../i18n';

const COLORS: { key: '--accent' | '--bg' | '--panel' | '--text'; label: string; fallback: string }[] = [
  { key: '--accent', label: i18n.t('kb157dabe'), fallback: '#7c5cff' },
  { key: '--bg', label: i18n.t('k8e1b944f'), fallback: '#f6f7fb' },
  { key: '--panel', label: i18n.t('kcd6f79e7'), fallback: '#ffffff' },
  { key: '--text', label: i18n.t('k58378f0d'), fallback: '#1f2430' },
];

interface Props {
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
}

/** 创意工坊（本地）：把配色 + 壁纸设置 + 少量图片打成一个 .tuku-pack 文件分享 */
export default function WorkshopCard({ onToast }: Props) {
  const [items, setItems] = useState<ThemePackBrief[]>([]);
  const [dir, setDir] = useState('');
  const [name, setName] = useState(i18n.t('ka791c2af'));
  const [author, setAuthor] = useState('');
  const [fontFamily, setFontFamily] = useState('');
  const [colors, setColors] = useState<Record<string, string>>(
    Object.fromEntries(COLORS.map((c) => [c.key, c.fallback]))
  );
  const [withSettings, setWithSettings] = useState(true);
  const [assets, setAssets] = useState<{ name: string; dataUrl: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      const r = await api.workshopPacks();
      setItems(r.items);
      setDir(r.dir);
    } catch (err) {
      onToast?.(i18n.t('k943f3583', { p0: (err as Error).message }), 'error');
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exportPack = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const theme: ThemePackTheme = {
        base: getStoredTheme() === 'dark' ? 'dark' : 'light',
        variables: colors,
        fontFamily,
      };
      const r = await api.workshopExport({
        name,
        author,
        theme,
        includeSettings: withSettings,
        assets,
      });
      const blob = new Blob([JSON.stringify(r.pack, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${r.pack.name}.tuku-pack`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onToast?.(
        i18n.t('k77f5afde', { p0: r.pack.name, p1: r.skipped.length ? i18n.t('k62cf2fd5', { p0: r.skipped.length }) : '' }),
        'info'
      );
      await refresh();
    } catch (err) {
      onToast?.(i18n.t('k246e218d', { p0: (err as Error).message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const importPack = async (file: File) => {
    if (busy) return;
    setBusy(true);
    try {
      const text = await file.text();
      const r = await api.workshopImport(text);
      applyThemePack(r.theme);
      onToast?.(
        i18n.t('kef84c1d6', { p0: r.pack.name, p1: r.appliedSettings.length, p2: r.assetPaths.length }) +
          (r.skipped.length ? i18n.t('k3f6fd28f', { p0: r.skipped.length }) : ''),
        'info'
      );
      await refresh();
    } catch (err) {
      onToast?.(i18n.t('kdfcff80b', { p0: (err as Error).message }), 'error');
    } finally {
      setBusy(false);
      if (importRef.current) importRef.current.value = '';
    }
  };

  const applyPack = async (id: string) => {
    try {
      const r = await api.workshopApply(id);
      applyThemePack(r.theme);
      onToast?.(i18n.t('k8657fe7e', { p0: r.appliedSettings.length }), 'info');
    } catch (err) {
      onToast?.(i18n.t('k6af6e03b', { p0: (err as Error).message }), 'error');
    }
  };

  const removePack = async (id: string) => {
    try {
      await api.workshopDelete(id);
      await refresh();
    } catch (err) {
      onToast?.(i18n.t('k94229cac', { p0: (err as Error).message }), 'error');
    }
  };

  const addImages = async (files: FileList | null) => {
    if (!files) return;
    const next = [...assets];
    for (const f of Array.from(files)) {
      if (next.length >= 4) break;
      if (f.size > 2 * 1024 * 1024) {
        onToast?.(i18n.t('k6b97a1a2', { p0: f.name }), 'error');
        continue;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(f);
      });
      next.push({ name: f.name, dataUrl });
    }
    setAssets(next);
  };

  return (
    <Card
      title={i18n.t('k40ac9cfe')}
      desc={i18n.t('kb02cd612')}
    >
      <div className="field">
        <label>{i18n.t('k1c7b91ec')}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={i18n.t('k4b95189e')} />
          <input className="input" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder={i18n.t('k94b9b806')} />
        </div>
      </div>
      <div className="field">
        <label>{i18n.t('k1a403453')}</label>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {COLORS.map((c) => (
            <label key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input
                type="color"
                value={colors[c.key] || c.fallback}
                onChange={(e) => setColors({ ...colors, [c.key]: e.target.value })}
              />
              {c.label}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <label>{i18n.t('ka6170ea6')}</label>
        <input
          className="input"
          value={fontFamily}
          onChange={(e) => setFontFamily(e.target.value)}
          placeholder={i18n.t('kb7090365')}
        />
      </div>
      <div className="switch-row">
        <span>{i18n.t('k79127b1c')}</span>
        <input type="checkbox" checked={withSettings} onChange={(e) => setWithSettings(e.target.checked)} />
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label>{i18n.t('k76ac9943')}</label>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(e) => void addImages(e.target.files)} />
        {assets.length > 0 && (
          <div className="hint">{assets.map((a) => a.name).join('、')} <button className="btn sm" onClick={() => setAssets([])}>{i18n.t('k288f0c40')}</button></div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn sm primary" onClick={() => void exportPack()} disabled={busy}>{i18n.t('k9d8be9c9')}</button>
        <button className="btn sm" onClick={() => importRef.current?.click()} disabled={busy}>{i18n.t('k174fb259')}</button>
        <input
          ref={importRef}
          type="file"
          accept=".tuku-pack,.json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importPack(f);
          }}
        />
        <button className="btn sm" onClick={() => void refresh()} disabled={busy}>{i18n.t('k694fc5ef')}</button>
      </div>

      <div className="field" style={{ marginTop: 14 }}>
        <label>本机工坊（{items.length}）</label>
        {dir && <div className="hint">{dir}</div>}
        {items.length === 0 && <div className="hint">{i18n.t('k7a4de0ef')}</div>}
        {items.map((p) => (
          <div key={p.id} className="switch-row" style={{ alignItems: 'flex-start' }}>
            <span>
              <b>{p.name}</b>{p.author ? ` · ${p.author}` : ''}
              <div className="hint">
                {p.base === 'dark' ? i18n.t('k41e8e8b9') : i18n.t('k48d0a09b')} · {p.varCount} 项配色 · {p.settingKeys.length} 项壁纸设置 · {p.assetNames.length} 张图片
              </div>
            </span>
            <span style={{ display: 'inline-flex', gap: 6 }}>
              <button className="btn sm" onClick={() => void applyPack(p.id)}>{i18n.t('k5b0520a9')}</button>
              <button className="btn sm danger" onClick={() => void removePack(p.id)}>{i18n.t('k2f4aaddd')}</button>
            </span>
          </div>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        {i18n.t('kbd8dcb3d')}
      </div>
    </Card>
  );
}
