import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import type { EditOp, EditOpsInfo, ImageItem } from '../../types';
import { confirmDialog } from '../Dialogs';

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
      .catch((err: Error) => setError(err.message || '读取操作链失败'));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const kindLabel = (op: EditOp) =>
    op.kind === 'crop'
      ? '裁切'
      : op.kind === 'rotate'
        ? '旋转'
        : '调色';

  const detail = (op: EditOp) => {
    if (op.kind === 'rotate') return op.params.dir === 'ccw' ? '向左 90°' : '向右 90°';
    if (op.kind === 'crop') {
      const r = op.params.rect;
      const pct = r ? `${Math.round(r.w * 100)}% × ${Math.round(r.h * 100)}%` : '';
      const out = op.params.outWidth ? ` · ${op.params.outWidth}×${op.params.outHeight}` : '';
      return `${pct}${out}`;
    }
    return '参数已记录';
  };

  const apply = async () => {
    if (busy) return;
    const ok = await confirmDialog(
      '把操作链一次性写回原文件？写回后原图字节会改变，操作链清空，仍可用 Ctrl+Z 撤销这一批写回。'
    );
    if (!ok) return;
    setBusy('apply');
    setError('');
    try {
      const r = await api.applyEditOps(item.id);
      onUpdated(r.item);
      onToast?.(`已应用到原文件（${r.ops} 步）`);
      onClose();
    } catch (err) {
      setError((err as Error).message || '应用失败');
    } finally {
      setBusy('');
    }
  };

  const clear = async () => {
    if (busy) return;
    const ok = await confirmDialog(
      '丢掉整条操作链、回到原图？原图从未被改动，还原没有损失（可 Ctrl+Z 撤销还原）。'
    );
    if (!ok) return;
    setBusy('clear');
    setError('');
    try {
      const r = await api.clearEditOps(item.id);
      onUpdated(r.item);
      onToast?.(`已还原（丢弃 ${r.cleared} 步）`);
      onClose();
    } catch (err) {
      setError((err as Error).message || '还原失败');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal" style={{ width: 520, maxWidth: '92vw' }}>
        <div className="modal-head">
          <h3 style={{ margin: 0 }}>
            {'非破坏编辑'}
            {info?.ops.length ? ` · ${info.ops.length} ${'步'}` : ''}
          </h3>
        </div>
        <div className="modal-body">
          <div className="hint" style={{ marginBottom: 10 }}>
            {'下面的操作只记在库里，原文件一个字节都没动。看图和导出会套用它们；想彻底落盘再点「应用到底片」。'}
          </div>
          {!info && !error && <div className="hint">{'读取中…'}</div>}
          {error && (
            <div className="hint" style={{ color: 'var(--danger, #ff6b6b)' }}>
              {error}
            </div>
          )}
          {info && info.ops.length === 0 && (
            <div className="hint">{'这张图没有待应用的编辑。'}</div>
          )}
          {info && info.ops.length > 0 && (
            <>
              <div className="hint" style={{ marginBottom: 8 }}>
                {'成品尺寸'}：{info.width}×{info.height}
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
            {'关闭'}
          </button>
          <button className="btn" disabled={!info?.ops.length || !!busy} onClick={clear}>
            {busy === 'clear' ? '还原中…' : '还原全部'}
          </button>
          <button className="btn primary" disabled={!info?.ops.length || !!busy} onClick={apply}>
            {busy === 'apply' ? '写入中…' : '应用到底片'}
          </button>
        </div>
      </div>
    </div>
  );
}
