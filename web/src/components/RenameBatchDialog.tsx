import { useMemo, useState } from 'react';
import { api } from '../api';
import type { ImageItem } from '../types';
import { IconClose } from './Icons';

/**
 * 批量重命名（对标 Eagle Batch Rename）：
 * - 模板占位符：{name} {keyword} {source} {date} {index} {width} {height} {ext}
 * - 起始序号可调，带实时预览；真正的重命名走 /api/images/rename-batch（硬盘文件名同步改）
 */
interface Props {
  ids: number[];
  /** 当前页能取到的选中项，仅用于预览 */
  items: ImageItem[];
  onClose: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  onDone: () => void;
}

const TOKENS = [
  { key: '{name}', label: '原名' },
  { key: '{keyword}', label: '关键词' },
  { key: '{source}', label: '来源' },
  { key: '{date}', label: '日期' },
  { key: '{index}', label: '序号' },
  { key: '{width}', label: '宽' },
  { key: '{height}', label: '高' },
  { key: '{ext}', label: '扩展名' },
];

interface ExtraOpts {
  pad: number;
  find: string;
  replace: string;
  caseMode: 'keep' | 'lower' | 'upper' | 'title';
}

/** 与服务端 renderTemplate 保持一致的预览实现（模板 → 查找替换 → 大小写 → 剃非法字符） */
function renderPreview(tpl: string, item: ImageItem | undefined, index: number, opts: ExtraOpts) {
  if (!item) return tpl.replace(/\{\w+\}/g, '…');
  const d = item.createdAt ? new Date(item.createdAt) : new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const ext = /\.([a-z0-9]+)$/i.exec(item.path || item.url)?.[1] || 'jpg';
  const map: Record<string, string> = {
    name: (item.title || '').replace(new RegExp(`\\.${ext}$`, 'i'), ''),
    keyword: (item.tags || [])[0] || '',
    source: item.source || '',
    date: `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`,
    index: String(index).padStart(opts.pad, '0'),
    width: String(item.width || 0),
    height: String(item.height || 0),
    ext: ext.toLowerCase(),
  };
  let out = tpl.replace(/\{(name|keyword|source|date|index|width|height|ext)\}/g, (_, k: string) => map[k] ?? '');
  if (opts.find) out = out.split(opts.find).join(opts.replace);
  if (opts.caseMode === 'lower') out = out.toLowerCase();
  else if (opts.caseMode === 'upper') out = out.toUpperCase();
  else if (opts.caseMode === 'title')
    out = out.replace(/(^|\s)(\S)/g, (_, sp: string, ch: string) => sp + ch.toUpperCase());
  return out.replace(/[\\/:*?"<>|\r\n\t]/g, '').slice(0, 120);
}

const CASE_OPTIONS: Array<{ value: ExtraOpts['caseMode']; label: string }> = [
  { value: 'keep', label: '保持原样' },
  { value: 'lower', label: '全小写' },
  { value: 'upper', label: '全大写' },
  { value: 'title', label: '首字母大写' },
];

export default function RenameBatchDialog({ ids, items, onClose, onToast, onDone }: Props) {
  const [template, setTemplate] = useState('{name}');
  const [start, setStart] = useState(1);
  const [pad, setPad] = useState(3);
  const [find, setFind] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [caseMode, setCaseMode] = useState<ExtraOpts['caseMode']>('keep');
  const [busy, setBusy] = useState(false);

  const opts: ExtraOpts = { pad, find, replace: replaceText, caseMode };

  const previews = useMemo(() => {
    const picked = ids.map((id) => items.find((x) => x.id === id));
    return picked.slice(0, 5).map((it, i) => renderPreview(template, it, start + i, opts));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, items, template, start, pad, find, replaceText, caseMode]);

  const insert = (token: string) => setTemplate((t) => `${t}${token}`);

  const submit = async () => {
    if (busy) return;
    if (!template.trim()) return onToast('模板不能为空');
    setBusy(true);
    try {
      const r = await api.renameBatch(ids, template.trim(), start, opts);
      onToast(r.failed ? `重命名完成：成功 ${r.renamed}，失败 ${r.failed}` : `已重命名 ${r.renamed} 张`);
      onDone();
      onClose();
    } catch (err) {
      onToast((err as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal-card" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>批量重命名 · 已选 {ids.length} 张</b>
          <button className="btn ghost sm" onClick={onClose} disabled={busy}>
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div className="field">
            <label>文件名模板</label>
            <input
              className="input"
              style={{ width: '100%' }}
              value={template}
              autoFocus
              placeholder="例如：{date}_{keyword}_{index}"
              onChange={(e) => setTemplate(e.target.value)}
            />
          </div>

          <div className="field">
            <label>插入占位符</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {TOKENS.map((t) => (
                <button key={t.key} className="chip" onClick={() => insert(t.key)} title={t.key} type="button">
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>起始序号与位数（{'{index}'} 从这里开始递增）</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="input"
                type="number"
                min={0}
                style={{ width: 100 }}
                value={start}
                onChange={(e) => setStart(Math.max(0, Number(e.target.value) || 0))}
              />
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>位数</span>
              <select
                className="input"
                style={{ width: 88 }}
                value={pad}
                onChange={(e) => setPad(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n} 位
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                示例 {String(start).padStart(pad, '0')}
              </span>
            </div>
          </div>

          <div className="field">
            <label>查找替换（对生成的名字生效，可留空）</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="input"
                style={{ flex: 1, minWidth: 120 }}
                placeholder="查找"
                value={find}
                onChange={(e) => setFind(e.target.value)}
              />
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>→</span>
              <input
                className="input"
                style={{ flex: 1, minWidth: 120 }}
                placeholder="替换为（留空即删除）"
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label>大小写</label>
            <select
              className="input"
              style={{ width: 160 }}
              value={caseMode}
              onChange={(e) => setCaseMode(e.target.value as ExtraOpts['caseMode'])}
            >
              {CASE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>预览（前 5 个）</label>
            <div className="rename-preview">
              {previews.map((p, i) => (
                <div key={i} className="rename-preview-row">
                  <span className="n">{i + 1}</span>
                  <span className="t">{p || '（空名称会被跳过）'}</span>
                </div>
              ))}
              {!previews.length && <div className="rename-preview-row">当前页没有可预览的选中项</div>}
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>会同步修改硬盘上的文件名，重名自动追加序号</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button
              className="btn"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              disabled={busy}
              onClick={submit}
            >
              {busy ? '重命名中…' : '开始重命名'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
