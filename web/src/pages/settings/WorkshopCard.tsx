import { useEffect, useRef, useState } from 'react';
import { api, type ThemePackBrief } from '../../api';
import { applyThemePack, getStoredTheme, type ThemePackTheme } from '../../theme';
import Card from './Card';

const COLORS: { key: '--accent' | '--bg' | '--panel' | '--text'; label: string; fallback: string }[] = [
  { key: '--accent', label: '强调色', fallback: '#7c5cff' },
  { key: '--bg', label: '背景', fallback: '#f6f7fb' },
  { key: '--panel', label: '面板', fallback: '#ffffff' },
  { key: '--text', label: '正文', fallback: '#1f2430' },
];

interface Props {
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
}

/** 创意工坊（本地）：把配色 + 壁纸设置 + 少量图片打成一个 .tuku-pack 文件分享 */
export default function WorkshopCard({ onToast }: Props) {
  const [items, setItems] = useState<ThemePackBrief[]>([]);
  const [dir, setDir] = useState('');
  const [name, setName] = useState('我的主题');
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
      onToast?.(`读取工坊失败：${(err as Error).message}`, 'error');
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
        `已导出「${r.pack.name}」${r.skipped.length ? `（跳过 ${r.skipped.length} 项不合规内容）` : ''}`,
        'info'
      );
      await refresh();
    } catch (err) {
      onToast?.(`导出失败：${(err as Error).message}`, 'error');
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
        `已导入「${r.pack.name}」：还原 ${r.appliedSettings.length} 项壁纸设置、${r.assetPaths.length} 张图片` +
          (r.skipped.length ? `；跳过 ${r.skipped.length} 项` : ''),
        'info'
      );
      await refresh();
    } catch (err) {
      onToast?.(`导入失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
      if (importRef.current) importRef.current.value = '';
    }
  };

  const applyPack = async (id: string) => {
    try {
      const r = await api.workshopApply(id);
      applyThemePack(r.theme);
      onToast?.(`已应用主题包（${r.appliedSettings.length} 项壁纸设置）`, 'info');
    } catch (err) {
      onToast?.(`应用失败：${(err as Error).message}`, 'error');
    }
  };

  const removePack = async (id: string) => {
    try {
      await api.workshopDelete(id);
      await refresh();
    } catch (err) {
      onToast?.(`删除失败：${(err as Error).message}`, 'error');
    }
  };

  const addImages = async (files: FileList | null) => {
    if (!files) return;
    const next = [...assets];
    for (const f of Array.from(files)) {
      if (next.length >= 4) break;
      if (f.size > 2 * 1024 * 1024) {
        onToast?.(`${f.name} 超过 2MB，已跳过`, 'error');
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
      title="创意工坊 / 主题包"
      desc="把配色、壁纸设置和图片打包成 .tuku-pack 文件，用网盘或聊天工具发给别人；对方导入即可还原。本机工坊目录负责收集导入过的包。"
    >
      <div className="field">
        <label>包名称 / 作者</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="主题名称" />
          <input className="input" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="作者（可选）" />
        </div>
      </div>
      <div className="field">
        <label>配色（只覆盖这几项，布局与安全相关变量不动）</label>
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
        <label>界面字体（可选）</label>
        <input
          className="input"
          value={fontFamily}
          onChange={(e) => setFontFamily(e.target.value)}
          placeholder="如 'Microsoft YaHei', sans-serif"
        />
      </div>
      <div className="switch-row">
        <span>附带当前壁纸设置（模式 / 参数 / 着色器，不含凭据与路径）</span>
        <input type="checkbox" checked={withSettings} onChange={(e) => setWithSettings(e.target.checked)} />
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label>附带图片（最多 4 张，每张 ≤ 2MB）</label>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(e) => void addImages(e.target.files)} />
        {assets.length > 0 && (
          <div className="hint">{assets.map((a) => a.name).join('、')} <button className="btn sm" onClick={() => setAssets([])}>清空</button></div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn sm primary" onClick={() => void exportPack()} disabled={busy}>导出并下载主题包</button>
        <button className="btn sm" onClick={() => importRef.current?.click()} disabled={busy}>导入主题包</button>
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
        <button className="btn sm" onClick={() => void refresh()} disabled={busy}>刷新</button>
      </div>

      <div className="field" style={{ marginTop: 14 }}>
        <label>本机工坊（{items.length}）</label>
        {dir && <div className="hint">{dir}</div>}
        {items.length === 0 && <div className="hint">还没有导入过主题包</div>}
        {items.map((p) => (
          <div key={p.id} className="switch-row" style={{ alignItems: 'flex-start' }}>
            <span>
              <b>{p.name}</b>{p.author ? ` · ${p.author}` : ''}
              <div className="hint">
                {p.base === 'dark' ? '深色' : '浅色'} · {p.varCount} 项配色 · {p.settingKeys.length} 项壁纸设置 · {p.assetNames.length} 张图片
              </div>
            </span>
            <span style={{ display: 'inline-flex', gap: 6 }}>
              <button className="btn sm" onClick={() => void applyPack(p.id)}>应用</button>
              <button className="btn sm danger" onClick={() => void removePack(p.id)}>删除</button>
            </span>
          </div>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        不做在线社区：包是一个普通 JSON 文件，导入时会过滤 CSS 值、图片类型与设置键，不执行任何脚本。
      </div>
    </Card>
  );
}
