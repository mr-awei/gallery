import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import type { EditOp, EditOpsInfo, ImageItem } from '../../types';
import { confirmDialog } from '../Dialogs';
import i18n from '../../i18n';

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
  const [info, setInfo] = useState<EditOpsInfo | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = () => {
    api
      .editOps(item.id)
      .then(setInfo)
      .catch((err: Error) => setError(err.message || i18n.t('k4d5f82a9')));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const kindLabel = (op: EditOp) =>
    op.kind === 'crop'
      ? i18n.t('k096cbe88')
      : op.kind === 'rotate'
        ? i18n.t('k79b5a656')
        : i18n.t('k9e368d03');

  const detail = (op: EditOp) => {
    if (op.kind === 'rotate') return op.params.dir === 'ccw' ? i18n.t('k757e4671') : i18n.t('k396455ab');
    if (op.kind === 'crop') {
      const r = op.params.rect;
      const pct = r ? `${Math.round(r.w * 100)}% × ${Math.round(r.h * 100)}%` : '';
      const out = op.params.outWidth ? ` · ${op.params.outWidth}×${op.params.outHeight}` : '';
      return `${pct}${out}`;
    }
    return i18n.t('k41c1931f');
  };

  const apply = async () => {
    if (busy) return;
    const ok = await confirmDialog(
      i18n.t('ka610e131')
    );
    if (!ok) return;
    setBusy('apply');
    setError('');
    try {
      const r = await api.applyEditOps(item.id);
      onUpdated(r.item);
      onToast?.(i18n.t('k0e21bf6d', { p0: r.ops }));
      onClose();
    } catch (err) {
      setError((err as Error).message || i18n.t('kefafd9a3'));
    } finally {
      setBusy('');
    }
  };

  const clear = async () => {
    if (busy) return;
    const ok = await confirmDialog(
      i18n.t('k1b909156')
    );
    if (!ok) return;
    setBusy('clear');
    setError('');
    try {
      const r = await api.clearEditOps(item.id);
      onUpdated(r.item);
      onToast?.(i18n.t('k5b47f691', { p0: r.cleared }));
      onClose();
    } catch (err) {
      setError((err as Error).message || i18n.t('k7bd43c80'));
    } finally {
      setBusy('');
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.stopPropagation()}
      // 灯箱里的二级面板没走 .modal-card，手动挂上对话框语义：焦点陷阱 + Esc 关闭 + 点空白关闭
      data-a11y-dialog="esc"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" style={{ width: 520, maxWidth: '92vw' }}>
        <div className="modal-head">
          <h3 style={{ margin: 0 }}>
            {i18n.t('k53e9e249')}
            {info?.ops.length ? ` · ${info.ops.length} ${'步'}` : ''}
          </h3>
        </div>
        <div className="modal-body">
          <div className="hint" style={{ marginBottom: 10 }}>
            {i18n.t('k65f5a4aa')}
          </div>
          {!info && !error && <div className="hint">{i18n.t('k8b5015f0')}</div>}
          {error && (
            <div className="hint" style={{ color: 'var(--danger, #ff6b6b)' }}>
              {error}
            </div>
          )}
          {info && info.ops.length === 0 && (
            <div className="hint">{i18n.t('kcc607cf6')}</div>
          )}
          {info && info.ops.length > 0 && (
            <>
              <div className="hint" style={{ marginBottom: 8 }}>
                {i18n.t('k4e11f63d')}：{info.width}×{info.height}
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
            {i18n.t('kb15d9127')}
          </button>
          <button className="btn" disabled={!info?.ops.length || !!busy} onClick={clear}>
            {busy === 'clear' ? i18n.t('k6c6ea850') : i18n.t('k2d44b04a')}
          </button>
          <button className="btn primary" disabled={!info?.ops.length || !!busy} onClick={apply}>
            {busy === 'apply' ? i18n.t('k568cfebf') : i18n.t('k2a3351d9')}
          </button>
        </div>
      </div>
    </div>
  );
}
