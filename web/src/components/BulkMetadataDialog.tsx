import React, { useState } from 'react';
import { api } from '../api';
import type { ImageItem } from '../types';
import { IconClose } from './Icons';
import i18n from '../i18n';

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

/** 颜色旗标：与评分互补，表达流程状态（待修 / 已选 / 已交付…） */
const COLORS: { key: string; hex: string }[] = [
  { key: 'red', hex: '#e5484d' },
  { key: 'orange', hex: '#f76b15' },
  { key: 'yellow', hex: '#e2a300' },
  { key: 'green', hex: '#30a46c' },
  { key: 'blue', hex: '#3b82f6' },
  { key: 'purple', hex: '#8b5cf6' },
  { key: 'gray', hex: '#8b8b8b' },
];

export default function BulkMetadataDialog({ ids, onClose, onToast, onUpdated }: Props) {
  const [busy, setBusy] = useState(false);
  const [rating, setRating] = useState<string>('');
  const [favorite, setFavorite] = useState<string>('');
  const [tagMode, setTagMode] = useState<TagMode>('add');
  const [tagsText, setTagsText] = useState('');
  const [note, setNote] = useState('');
  const [clearNote, setClearNote] = useState(false);
  /** '' = 不修改；'none' = 清除；其余是颜色名 */
  const [colorLabel, setColorLabel] = useState('');
  /** '' = 不修改；'1' 移入 / '0' 移出 */
  const [inbox, setInbox] = useState('');

  const tagList = tagsText
    .split(/[,，\n]/)
    .map((t) => t.trim())
    .filter(Boolean);

  const dirty =
    rating !== '' ||
    favorite !== '' ||
    tagsText.trim() !== '' ||
    note.trim() !== '' ||
    clearNote ||
    colorLabel !== '' ||
    inbox !== '';

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
      if (colorLabel !== '') body.colorLabel = colorLabel === 'none' ? '' : colorLabel;
      if (inbox !== '') body.inbox = inbox === '1';
      const r = await api.bulkMetadata(body);
      onUpdated(r.items || []);
      const skipped = r.skipped ? i18n.t('kfc0cec8c', { p0: r.skipped }) : '';
      onToast(i18n.t('ke59b8731', { p0: r.updated, p1: skipped }));
      onClose();
    } catch (e) {
      onToast((e as Error)?.message || i18n.t('k24182b23'), 'error');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal-card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>批量编辑信息 · 已选 {ids.length} 张</b>
          <button className="btn ghost sm" onClick={onClose} disabled={busy} aria-label={i18n.t('kb15d9127')}>
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div className="field">
            <label>{i18n.t('k108db12e')}</label>
            <select className="input" style={{ width: 180 }} value={rating} onChange={(e) => setRating(e.target.value)}>
              <option value="">{i18n.t('k8229ad29')}</option>
              {RATINGS.map((r) => (
                <option key={r} value={r}>
                  {r === 0 ? i18n.t('k4b944119') : i18n.t('kedadd8b7', { p0: '★'.repeat(r), p1: r })}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>{i18n.t('kae336cd0')}</label>
            <select
              className="input"
              style={{ width: 180 }}
              value={favorite}
              onChange={(e) => setFavorite(e.target.value)}
            >
              <option value="">{i18n.t('k8229ad29')}</option>
              <option value="1">{i18n.t('k05b72da9')}</option>
              <option value="0">{i18n.t('kf22cec28')}</option>
            </select>
          </div>

          <div className="field">
            <label>{i18n.t('k7c3f1b03')}</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {COLORS.map((c) => (
                <button
                  type="button"
                  key={c.key}
                  title={i18n.t(`k7c3f1b0${9 + COLORS.indexOf(c)}`)}
                  onClick={() => setColorLabel(colorLabel === c.key ? '' : c.key)}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    border: colorLabel === c.key ? '2px solid var(--ink)' : '2px solid transparent',
                    background: c.hex,
                    cursor: 'pointer',
                  }}
                />
              ))}
              <button
                type="button"
                className={colorLabel === 'none' ? 'btn sm primary' : 'btn sm'}
                onClick={() => setColorLabel(colorLabel === 'none' ? '' : 'none')}
              >
                {i18n.t('k7c3f1b08')}
              </button>
            </div>
          </div>

          <div className="field">
            <label>{i18n.t('k7c3f1b04')}</label>
            <select className="input" style={{ width: 200 }} value={inbox} onChange={(e) => setInbox(e.target.value)}>
              <option value="">{i18n.t('k7c3f1b05')}</option>
              <option value="0">{i18n.t('k7c3f1b06')}</option>
              <option value="1">{i18n.t('k7c3f1b07')}</option>
            </select>
          </div>

          <div className="field">
            <label>{i18n.t('k14d34236')}</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <select
                className="input"
                style={{ width: 130 }}
                value={tagMode}
                onChange={(e) => setTagMode(e.target.value as TagMode)}
              >
                <option value="add">{i18n.t('kb58c7549')}</option>
                <option value="remove">{i18n.t('k86048b4f')}</option>
                <option value="set">{i18n.t('k1605701e')}</option>
              </select>
              <input
                className="input"
                style={{ flex: 1, minWidth: 140 }}
                placeholder={i18n.t('kc379e80c')}
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
              />
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {tagsText.trim() === ''
                ? i18n.t('keef0e802')
                : tagMode === 'add'
                  ? i18n.t('k78f04785', { p0: tagList.join('、') })
                  : tagMode === 'remove'
                    ? i18n.t('kbf35580d', { p0: tagList.join('、') })
                    : i18n.t('k8e04077a', { p0: tagList.join('、') || i18n.t('k27c4e28d') })}
            </div>
          </div>

          <div className="field">
            <label>{i18n.t('k2432b575')}</label>
            <textarea
              className="input"
              style={{ width: '100%', minHeight: 64, resize: 'vertical' }}
              placeholder={i18n.t('k3d37b042')}
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
              {i18n.t('k10355e1f')}
            </label>
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{i18n.t('kdc5ef80a')}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={busy}>
              {i18n.t('k625fb26b')}
            </button>
            <button
              className="btn"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              disabled={busy || !dirty}
              onClick={submit}
            >
              {busy ? i18n.t('k9b5d32d1') : i18n.t('kd9067042', { p0: ids.length })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
