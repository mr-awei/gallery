/**
 * 批量创建：一行一个名字，一次建一批文件夹或标签。
 * Eagle 里整理素材经常要「先铺好分类」——逐个新建太慢，这里支持换行 / 逗号分隔。
 */
import { useState } from 'react';
import { api } from '../api';
import { useEscClose } from '../lib/useEscClose';
import type { FolderNode, TagNode } from '../types';
import { IconClose } from './Icons';

interface Props {
  /** folder = 建文件夹；tag = 建标签 */
  mode: 'folder' | 'tag';
  /** 文件夹：父夹（null = 根级）；标签：所属分组 */
  parentId?: number | null;
  group?: string;
  parentName?: string;
  onClose: () => void;
  onFolders?: (folders: FolderNode[]) => void;
  onTags?: (r: { tags: TagNode[]; groups: string[] }) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

export default function BatchCreateDialog({
  mode,
  parentId = null,
  group = '',
  parentName = '',
  onClose,
  onFolders,
  onTags,
  onToast,
}: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEscClose(onClose);

  const names = text
    .split(/[\r\n,，]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const submit = async () => {
    if (!names.length) return onToast('先填写至少一个名称');
    setBusy(true);
    try {
      if (mode === 'folder') {
        const r = await api.createFoldersBatch(names, parentId);
        onFolders?.(r.folders);
        const skipped = r.skipped?.length ? `，跳过 ${r.skipped.length} 个同名` : '';
        onToast(`已新建 ${r.created.length} 个文件夹${skipped}`);
      } else {
        const r = await api.createTagsBatch(names, group || undefined);
        onTags?.({ tags: r.tags, groups: r.groups });
        onToast(`已新建 ${r.created.length} 个标签${group ? `（分组：${group}）` : ''}`);
      }
      onClose();
    } catch (err) {
      onToast((err as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 500 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>
            {mode === 'folder' ? '＋ 批量新建文件夹' : '＋ 批量新建标签'}
            {mode === 'folder' && parentName ? ` · 在「${parentName}」下` : ''}
          </b>
          <button className="btn ghost sm" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div className="field">
            <label>名称（一行一个，也可以用逗号分隔）</label>
            <textarea
              className="input"
              style={{ width: '100%', minHeight: 150, resize: 'vertical', fontFamily: 'inherit' }}
              value={text}
              autoFocus
              placeholder={mode === 'folder' ? '2508季\n白底图\n参考图' : '主视觉\n详情页\n模特'}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </div>
          <div className="qc-hint">
            {mode === 'folder'
              ? '同名文件夹已存在时会跳过，不会建出两个一样的夹。'
              : '空标签也会出现在侧栏，方便先把分类铺好再往里放图。'}
            当前将创建 <b>{names.length}</b> 个。
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>Ctrl+Enter 提交</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button
              className="btn"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              disabled={busy || !names.length}
              onClick={() => void submit()}
            >
              {busy ? '创建中…' : `创建 ${names.length} 个`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
