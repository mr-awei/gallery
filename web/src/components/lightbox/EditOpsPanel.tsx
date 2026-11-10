import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import type { EditOp, EditOpsInfo, ImageItem } from '../../types';
import { confirmDialog } from '../Dialogs';
import { useLang } from '../../lib/i18n';

/**
 * 非破坏编辑面板：把「原图 + 操作链」摊开给用户看。
 *
 * 为什么需要一个面板：非破坏模式下裁切/旋转/调色都不写盘，用户点完保存画面变了、
 * 但磁盘上什么都没发生 —— 不给一个能看清单、能落盘、能整体还原的地方，
 * 这功能就会变成「我的编辑去哪了」。
 */
export default function EditOpsPanel({
  item,
  onClose,
  onUpdated,
  onToast,
}: {
  item: ImageItem;
  onClose: () => void;
  onUpdated: (item: ImageItem) => void;
  onToast?: (msg: string) => void;
}) {
  const { t } = useLang();
  const [info, setInfo] = useState<EditOpsInfo | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = () => {
    api
      .editOps(item.id)
      .then(setInfo)
      .catch((err: Error) => setError(err.message || '读取操作链失败'));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const kindLabel = (op: EditOp) =>
    op.kind === 'crop'
      ? t('裁切', 'Crop')
      : op.kind === 'rotate'
        ? t('旋转', 'Rotate')
        : t('调色', 'Adjust');

  const detail = (op: EditOp) => {
    if (op.kind === 'rotate') return op.params.dir === 'ccw' ? t('向左 90°', '90° left') : t('向右 90°', '90° right');
    if (op.kind === 'crop') {
      const r = op.params.rect;
      const pct = r ? `${Math.round(r.w * 100)}% × ${Math.round(r.h * 100)}%` : '';
      const out = op.params.outWidth ? ` · ${op.params.outWidth}×${op.params.outHeight}` : '';
      return `${pct}${out}`;
    }
    return t('参数已记录', 'Parameters recorded');
  };

  const apply = async () => {
    if (busy) return;
    const ok = await confirmDialog(
      t(
        '把操作链一次性写回原文件？写回后原图字节会改变，操作链清空，仍可用 Ctrl+Z 撤销这一批写回。',
        'Bake the operation chain into the original file? The file bytes will change and the chain will be cleared; Ctrl+Z still undoes this bake.'
      )
    );
    if (!ok) return;
    setBusy('apply');
    setError('');
    try {
      const r = await api.applyEditOps(item.id);
      onUpdated(r.item);
      onToast?.(t(`已应用到原文件（${r.ops} 步）`, `Baked ${r.ops} step(s) into the original`));
      onClose();
    } catch (err) {
      setError((err as Error).message || t('应用失败', 'Apply failed'));
    } finally {
      setBusy('');
    }
  };

  const clear = async () => {
    if (busy) return;
    const ok = await confirmDialog(
      t('丢掉整条操作链、回到原图？原图从未被改动，还原没有损失（可 Ctrl+Z 撤销还原）。', 'Discard the whole chain and go back to the original? The original was never modified (Ctrl+Z can undo this).')
    );
    if (!ok) return;
    setBusy('clear');
    setError('');
    try {
      const r = await api.clearEditOps(item.id);
      onUpdated(r.item);
      onToast?.(t(`已还原（丢弃 ${r.cleared} 步）`, `Reverted (${r.cleared} step(s) discarded)`));
      onClose();
    } catch (err) {
      setError((err as Error).message || t('还原失败', 'Revert failed'));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal" style={{ width: 520, maxWidth: '92vw' }}>
        <div className="modal-head">
          <h3 style={{ margin: 0 }}>
            {t('非破坏编辑', 'Non-destructive edits')}
            {info?.ops.length ? ` · ${info.ops.length} ${t('步', 'steps')}` : ''}
          </h3>
        </div>
        <div className="modal-body">
          <div className="hint" style={{ marginBottom: 10 }}>
            {t(
              '下面的操作只记在库里，原文件一个字节都没动。看图和导出会套用它们；想彻底落盘再点「应用到底片」。',
              'These steps live in the database only — the original file is untouched. Viewing and exporting apply them; use “Bake into original” to write them to disk.'
            )}
          </div>
          {!info && !error && <div className="hint">{t('读取中…', 'Loading…')}</div>}
          {error && (
            <div className="hint" style={{ color: 'var(--danger, #ff6b6b)' }}>
              {error}
            </div>
          )}
          {info && info.ops.length === 0 && (
            <div className="hint">{t('这张图没有待应用的编辑。', 'No pending edits for this image.')}</div>
          )}
          {info && info.ops.length > 0 && (
            <>
              <div className="hint" style={{ marginBottom: 8 }}>
                {t('成品尺寸', 'Result size')}：{info.width}×{info.height}
              </div>
              <ol style={{ margin: 0, paddingLeft: 22, maxHeight: 240, overflow: 'auto', lineHeight: 1.9 }}>
                {info.ops.map((op) => (
                  <li key={op.id}>
                    <b>{kindLabel(op)}</b> <span className="hint">{detail(op)}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
        <div className="modal-foot" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" disabled={!!busy} onClick={onClose}>
            {t('关闭', 'Close')}
          </button>
          <button className="btn" disabled={!info?.ops.length || !!busy} onClick={clear}>
            {busy === 'clear' ? t('还原中…', 'Reverting…') : t('还原全部', 'Revert all')}
          </button>
          <button className="btn primary" disabled={!info?.ops.length || !!busy} onClick={apply}>
            {busy === 'apply' ? t('写入中…', 'Baking…') : t('应用到底片', 'Bake into original')}
          </button>
        </div>
      </div>
    </div>
  );
}
