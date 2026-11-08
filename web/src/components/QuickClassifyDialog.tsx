/**
 * 快速分类（快捷键 F）：选中一批素材后，不用离开网格就能「放进文件夹 + 打标签」。
 *
 * Eagle 的手感是按一下键、鼠标走两下就分完类；这里把最常用的两个动作放在同一个面板：
 * 文件夹（单选，整批一起进）+ 标签（逗号分隔，逐个追加，不清空原有标签）。
 */
import { useMemo, useState } from 'react';
import { api } from '../api';
import { useEscClose } from '../lib/useEscClose';
import type { FolderNode } from '../types';
import { IconClose } from './Icons';

interface Props {
  ids: number[];
  folders: FolderNode[];
  currentFolderId?: number | null;
  onClose: () => void;
  onDone: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

export default function QuickClassifyDialog({ ids, folders, currentFolderId, onClose, onDone, onToast }: Props) {
  const [folderId, setFolderId] = useState<number | null>(currentFolderId ?? null);
  const [keyword, setKeyword] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);

  useEscClose(onClose);

  const list = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const byParent = new Map<number | null, FolderNode[]>();
    for (const f of folders) {
      const key = f.parent_id ?? null;
      const arr = byParent.get(key) || [];
      arr.push(f);
      byParent.set(key, arr);
    }
    for (const arr of byParent.values()) {
      arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    }
    const out: { f: FolderNode; depth: number }[] = [];
    const walk = (parent: number | null, depth: number) => {
      for (const f of byParent.get(parent) || []) {
        const hit = !kw || f.name.toLowerCase().includes(kw);
        // 命中子夹时父夹也保留（否则树断开，看不出它属于哪里）
        if (hit) out.push({ f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [folders, keyword]);

  const submit = async () => {
    const tagList = tags
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t, i, a) => a.indexOf(t) === i);
    if (!folderId && !tagList.length) return onToast('选一个文件夹，或填至少一个标签');
    setBusy(true);
    try {
      let added = 0;
      if (folderId) {
        const r = await api.addToFolder(folderId, ids);
        added = r.added;
      }
      for (const t of tagList) await api.batch(ids, 'addTag', t);
      const parts = [];
      if (folderId) parts.push(`放入文件夹（新增 ${added} 条归属）`);
      if (tagList.length) parts.push(`打上 ${tagList.length} 个标签`);
      onToast(`已给 ${ids.length} 张素材${parts.join('、')}`);
      onDone();
      onClose();
    } catch (err) {
      onToast((err as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>⚡ 快速分类 · {ids.length} 张</b>
          <button className="btn ghost sm" onClick={onClose} title="关闭（Esc）">
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div className="qc-section">
            <h4>放进文件夹</h4>
            <input
              className="input"
              style={{ width: '100%', marginBottom: 8 }}
              placeholder="搜索文件夹…"
              value={keyword}
              autoFocus
              onChange={(e) => setKeyword(e.target.value)}
            />
            <div className="qc-chips">
              <button
                className={`qc-chip${folderId === null ? ' on' : ''}`}
                onClick={() => setFolderId(null)}
                title="不放进任何文件夹"
              >
                不归类
              </button>
              {list.map(({ f, depth }) => (
                <button
                  key={f.id}
                  className={`qc-chip${folderId === f.id ? ' on' : ''}`}
                  style={{ marginLeft: depth ? 8 : 0 }}
                  onClick={() => setFolderId(folderId === f.id ? null : f.id)}
                  title={`${f.name}（${f.total || 0} 张）`}
                >
                  {f.icon ? `${f.icon} ` : ''}
                  {f.name}
                </button>
              ))}
              {!list.length && <span className="qc-hint">没有匹配的文件夹</span>}
            </div>
          </div>

          <div className="qc-section">
            <h4>追加标签</h4>
            <input
              className="input"
              style={{ width: '100%' }}
              placeholder="多个用逗号分隔，例如：主视觉, 参考"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
            <div className="qc-hint" style={{ marginTop: 6 }}>
              标签是追加，不会清掉素材已有的标签。
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>回车直接应用</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button
              className="btn"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? '应用中…' : '应用'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
