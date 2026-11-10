import React, { useState } from 'react';
import { api } from '../api';
import type { ImageItem } from '../types';
import { IconClose } from './Icons';

/**
 * 批量元数据编辑（对标 Eagle 的多选「批量编辑」）。
 *
 * 三个约定：
 * - 每个字段都有「不修改」，没动过的字段不会出现在请求里——批量改评分时不该顺手清空备注；
 * - 标签支持添加 / 移除 / 替换三种集合运算，而不是只能覆盖（覆盖会毁掉原有分类）；
 * - 整批提交一次，服务端只记一条撤销（撤销一次回滚整批），不是 5000 条散记录。
 */
interface Props {
  ids: number[];
  onClose: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  /** 用服务端返回的最新 DTO 就地替换列表项 */
  onUpdated: (items: ImageItem[]) => void;
}

type TagMode = 'add' | 'remove' | 'set';

const RATINGS = [0, 1, 2, 3, 4, 5];

export default function BulkMetadataDialog({ ids, onClose, onToast, onUpdated }: Props) {
  const [busy, setBusy] = useState(false);
  const [rating, setRating] = useState<string>('');
  const [favorite, setFavorite] = useState<string>('');
  const [tagMode, setTagMode] = useState<TagMode>('add');
  const [tagsText, setTagsText] = useState('');
  const [note, setNote] = useState('');
  const [clearNote, setClearNote] = useState(false);

  const tagList = tagsText
    .split(/[,，\n]/)
    .map((t) => t.trim())
    .filter(Boolean);

  const dirty = rating !== '' || favorite !== '' || tagsText.trim() !== '' || note.trim() !== '' || clearNote;

  const submit = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    try {
      const body: Parameters<typeof api.bulkMetadata>[0] = { ids };
      if (rating !== '') body.rating = Number(rating);
      if (favorite !== '') body.favorite = favorite === '1';
      if (tagsText.trim() !== '') {
        body.tags = tagList;
        body.tagMode = tagMode;
      }
      if (clearNote) body.note = '';
      else if (note.trim() !== '') body.note = note.trim();
      const r = await api.bulkMetadata(body);
      onUpdated(r.items || []);
      const skipped = r.skipped ? `，${r.skipped} 张已不存在` : '';
      onToast(`已更新 ${r.updated} 张素材${skipped}`);
      onClose();
    } catch (e) {
      onToast((e as Error)?.message || '批量修改失败', 'error');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal-card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>批量编辑信息 · 已选 {ids.length} 张</b>
          <button className="btn ghost sm" onClick={onClose} disabled={busy}>
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div className="field">
            <label>评分</label>
            <select className="input" style={{ width: 180 }} value={rating} onChange={(e) => setRating(e.target.value)}>
              <option value="">不修改</option>
              {RATINGS.map((r) => (
                <option key={r} value={r}>
                  {r === 0 ? '清除评分' : `${'★'.repeat(r)}（${r} 星）`}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>收藏</label>
            <select
              className="input"
              style={{ width: 180 }}
              value={favorite}
              onChange={(e) => setFavorite(e.target.value)}
            >
              <option value="">不修改</option>
              <option value="1">加入收藏</option>
              <option value="0">取消收藏</option>
            </select>
          </div>

          <div className="field">
            <label>标签</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <select
                className="input"
                style={{ width: 130 }}
                value={tagMode}
                onChange={(e) => setTagMode(e.target.value as TagMode)}
              >
                <option value="add">添加</option>
                <option value="remove">移除</option>
                <option value="set">替换为</option>
              </select>
              <input
                className="input"
                style={{ flex: 1, minWidth: 140 }}
                placeholder="多个标签用逗号分隔"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
              />
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {tagsText.trim() === ''
                ? '留空则不改标签。每张图原有的其它标签都会保留（「替换为」除外）。'
                : tagMode === 'add'
                  ? `会给每张图补上：${tagList.join('、')}`
                  : tagMode === 'remove'
                    ? `会从每张图移除：${tagList.join('、')}`
                    : `会把每张图的标签整体改成：${tagList.join('、') || '（空）'}`}
            </div>
          </div>

          <div className="field">
            <label>备注</label>
            <textarea
              className="input"
              style={{ width: '100%', minHeight: 64, resize: 'vertical' }}
              placeholder="留空则不修改备注"
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                if (e.target.value) setClearNote(false);
              }}
            />
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={clearNote}
                onChange={(e) => {
                  setClearNote(e.target.checked);
                  if (e.target.checked) setNote('');
                }}
              />
              清空这批素材的备注
            </label>
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>整批一次提交，可以用 Ctrl+Z 一次性撤销</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button
              className="btn"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              disabled={busy || !dirty}
              onClick={submit}
            >
              {busy ? '保存中…' : `应用到 ${ids.length} 张`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
