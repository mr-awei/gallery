import { useEffect, useState } from 'react';
import { api } from '../../api';
import Card from './Card';

interface Props {
  value: string;
  applyToLocal: boolean;
  onChange: (patch: { importNameTemplate?: string; importNameTemplateForLocal?: boolean }) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

interface Meta {
  presets: { label: string; value: string }[];
  tokens: { token: string; desc: string }[];
}

/** 导入命名模板：占位符、预设、前 20 个目标名预览、本地扫描可选复制 */
export default function ImportNameTemplateCard({ value, applyToLocal, onChange, onToast }: Props) {
  const [meta, setMeta] = useState<Meta>({ presets: [], tokens: [] });
  const [names, setNames] = useState<string[]>([]);
  const [sample, setSample] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 空模板也会返回 presets / tokens，用一次请求把说明和预设都拿下来
    api
      .nameTemplatePreview('')
      .then((r) => setMeta({ presets: r.presets || [], tokens: r.tokens || [] }))
      .catch((err) => onToast(`读取命名模板说明失败：${(err as Error).message}`, 'error'));
  }, []);

  const preview = async () => {
    if (!value.trim()) {
      setNames([]);
      setSample(false);
      onToast('留空表示沿用内置默认文件名');
      return;
    }
    setBusy(true);
    try {
      const r = await api.nameTemplatePreview(value);
      setNames(r.names || []);
      setSample(!!r.sample);
      setMeta({ presets: r.presets || [], tokens: r.tokens || [] });
      onToast('已按库里最近的素材生成预览');
    } catch (err) {
      onToast(`预览失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="导入时命名模板"
      desc="新素材落盘时按模板命名；采集、拖拽/粘贴、手机投送、浏览器扩展与批量入库共用一套规则。"
      badge={<span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>按资源库独立保存</span>}
    >
      <div className="settings-subhead">模板</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="field" style={{ flex: 2, minWidth: 220, margin: 0 }}>
          <label>文件名模板（留空 = 内置默认「关键词_来源_尺寸_时间戳_随机」）</label>
          <input
            className="input"
            style={{ width: '100%' }}
            value={value}
            maxLength={200}
            placeholder="{date}-{index}{ext}"
            onChange={(e) => onChange({ importNameTemplate: e.target.value })}
          />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 180, margin: 0 }}>
          <label>套用预设（可保存复用）</label>
          <select
            className="select"
            style={{ width: '100%', padding: '7px 8px', borderRadius: 8 }}
            value=""
            onChange={(e) => onChange({ importNameTemplate: e.target.value })}
          >
            <option value="">选择一个预设…</option>
            {meta.presets.map((p) => (
              <option key={p.label} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <button className="btn sm" disabled={busy} onClick={() => void preview()}>
          预览前 20 个目标名
        </button>
      </div>

      <div className="hint" style={{ lineHeight: 1.9, marginTop: 10 }}>
        可用占位符：{' '}
        {meta.tokens.map((t) => (
          <code key={t.token} title={t.desc} style={{ marginRight: 8 }}>
            {t.token}
          </code>
        ))}
        <br />
        <code>{'{index}'}</code> 按本批顺序递增（4 位补零），重名自动追加 <code>-1 / -2</code>；
        扩展名没写 <code>{'{ext}'}</code> 也会自动补上。非法字符会被过滤。
      </div>

      {names.length > 0 && (
        <div className="field" style={{ marginTop: 10 }}>
          <label>
            目标文件名预览（{names.length} 个{sample ? '，库里还没有素材，用示例数据' : '，来自库里最近的素材'}）
          </label>
          <div
            className="hint"
            style={{ maxHeight: 180, overflowY: 'auto', background: 'var(--panel-strong)', borderRadius: 8, padding: 10 }}
          >
            {names.map((n, i) => (
              <div key={`${n}-${i}`} style={{ fontFamily: 'monospace' }}>
                {String(i + 1).padStart(2, '0')}. {n}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="settings-subhead">本地文件夹扫描</div>
      <div className="switch-row">
        <span>扫描本地文件夹时，复制一份并按模板命名</span>
        <input
          type="checkbox"
          checked={applyToLocal}
          onChange={(e) => onChange({ importNameTemplateForLocal: e.target.checked })}
        />
      </div>
      <div className="hint" style={{ lineHeight: 1.8 }}>
        默认关闭：本地扫描是<b>原地登记</b>，不会改名或移动你硬盘上的文件。
        开启后才会把素材复制一份到保存文件夹（保留目录层级，文件夹关联不丢）并按模板命名，原文件始终不动。
        <b>扫描保存文件夹本身时不要开启</b>，否则会不断产生副本。
      </div>
      <div className="hint">改完记得点右上角「保存设置」。</div>
    </Card>
  );
}
