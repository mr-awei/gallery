import { useMemo, useState } from 'react';
import { api } from '../api';
import type { TagNode } from '../types';
import { IconClose } from './Icons';

/**
 * 标签元数据编辑（Eagle 式：分组 / 颜色 / 父标签）。
 * - 只写 tag_meta，标签本体（images.tags 逗号串）不动，避免双写不一致
 * - 分组可新建，颜色支持预设色板，父标签用于两级层级
 */
interface Props {
  tag: TagNode;
  tags: TagNode[];
  onClose: () => void;
  onSaved: (r: { tags: TagNode[]; groups: string[] }) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

const PRESET_COLORS = [
  '#ff4d8d',
  '#ff8a3d',
  '#ffcf5c',
  '#5cd68a',
  '#4db8ff',
  '#8a7dff',
  '#c45cff',
  '#a0a8b8',
];

export default function TagMetaDialog({ tag, tags, onClose, onSaved, onToast }: Props) {
  const [group, setGroup] = useState(tag.group || '');
  const [color, setColor] = useState(tag.color || '');
  const [parent, setParent] = useState(tag.parent || '');
  const [busy, setBusy] = useState(false);

  /** 可选父标签：排除自己与自己的子孙，避免成环 */
  const parentOptions = useMemo(() => {
    const children = new Map<string, string[]>();
    for (const t of tags) {
      if (!t.parent) continue;
      const arr = children.get(t.parent);
      if (arr) arr.push(t.tag);
      else children.set(t.parent, [t.tag]);
    }
    const banned = new Set<string>([tag.tag]);
    const walk = (name: string) => {
      for (const c of children.get(name) || []) {
        if (banned.has(c)) continue;
        banned.add(c);
        walk(c);
      }
    };
    walk(tag.tag);
    return tags.filter((t) => !banned.has(t.tag)).map((t) => t.tag);
  }, [tags, tag.tag]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.tagMeta({ tag: tag.tag, group: group.trim(), color: color.trim(), parent });
      onSaved({ tags: r.tags, groups: r.groups });
      onToast('标签设置已保存');
    } catch (err) {
      onToast((err as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>
            <span className="tag-dot" style={color ? { background: color } : undefined} /> 标签设置 · {tag.tag}
          </b>
          <button className="btn ghost sm" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div className="field">
            <label>分组（留空 = 未分组，可输入新分组名）</label>
            <input
              className="input"
              style={{ width: '100%' }}
              value={group}
              list="tuku-tag-groups"
              placeholder="例如：人物 / 场景 / 服装"
              autoFocus
              onChange={(e) => setGroup(e.target.value)}
            />
            <datalist id="tuku-tag-groups">
              {[...new Set(tags.map((t) => t.group).filter(Boolean))].map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>

          <div className="field">
            <label>颜色</label>
            <div className="tag-color-row">
              <button
                className={`tag-color-chip${!color ? ' active' : ''}`}
                onClick={() => setColor('')}
                title="不设置颜色"
              >
                ∅
              </button>
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  className={`tag-color-chip${color.toLowerCase() === c ? ' active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  title={c}
                />
              ))}
              <input
                className="input"
                style={{ width: 100 }}
                value={color}
                placeholder="#ff4d8d"
                onChange={(e) => setColor(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label>父标签（做二级层级，留空 = 顶层）</label>
            <select className="input" style={{ width: '100%' }} value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">（顶层）</option>
              {parentOptions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>改动只影响侧栏展示与筛选，不改变已打的标签</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button
              className="btn"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              disabled={busy}
              onClick={save}
            >
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
