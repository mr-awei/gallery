/**
 * 堆叠查看器：一张「组主」卡上的 ×N 角标点开后，看这一摞里都有哪些版本。
 *
 * 堆叠成员不在主网格里显示（后端列表只返回组主），否则同素材的几个版本会把网格占满。
 * 这里可以：设某张为组主（其实就是把整组重新以它为主）、把某张移出堆叠、解散整组。
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useEscClose } from '../lib/useEscClose';
import type { ImageItem } from '../types';
import { IconClose } from './Icons';

interface Props {
  stackId: number;
  onClose: () => void;
  onChanged: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  onOpenItem?: (item: ImageItem) => void;
}

export default function StackViewer({ stackId, onClose, onChanged, onToast, onOpenItem }: Props) {
  const [items, setItems] = useState<ImageItem[]>([]);
  const [busy, setBusy] = useState(false);
  // 换封面 / 移出组主都会让「组主 id」变，这里跟着走，避免继续拿旧 id 查空
  const [sid, setSid] = useState(stackId);
  /** 并入其他堆叠：点按钮才拉列表，避免每开一次查看器都多打一个请求 */
  const [picker, setPicker] = useState<{ stackId: number; title: string; count: number; thumbUrl: string }[] | null>(
    null
  );

  useEscClose(onClose);

  const reload = async (id = sid) => {
    try {
      const r = await api.stackMembers(id);
      setItems(r.items);
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };

  useEffect(() => {
    void reload(stackId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackId]);

  const ungroup = async () => {
    setBusy(true);
    try {
      const r = await api.ungroupStack(sid);
      onToast(`已解散堆叠（${r.removed} 张恢复为独立素材）`);
      onChanged();
      onClose();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeOne = async (item: ImageItem) => {
    setBusy(true);
    try {
      const r = await api.removeFromStack(item.id);
      onToast(`「${item.title}」已移出堆叠`);
      onChanged();
      const rest = items.filter((x) => x.id !== item.id);
      setItems(rest);
      if (rest.length < 2) return onClose();
      if (r.stackId) {
        setSid(r.stackId);
        await reload(r.stackId);
      }
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const openPicker = async () => {
    if (picker) return setPicker(null);
    try {
      const r = await api.stacksList();
      // 排除自己这一组（别把组并进自己）
      const mine = new Set(items.map((x) => Number(x.stackId) || Number(x.id)));
      setPicker(r.stacks.filter((s) => s.stackId !== sid && !mine.has(s.stackId)));
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };

  const mergeInto = async (target: { stackId: number; count: number }) => {
    setBusy(true);
    try {
      const r = await api.mergeStacks(sid, target.stackId);
      setPicker(null);
      onToast(`已并入另一个堆叠，现在共 ${r.stacks.length} 张`);
      onChanged();
      setSid(r.stackId);
      await reload(r.stackId);
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const makePrimary = async (item: ImageItem) => {
    setBusy(true);
    try {
      // 明确设封面，不走 createStack 的「按评分挑组主」
      const r = await api.setStackPrimary(sid, item.id);
      onToast(`已把「${item.title}」设为堆叠封面`);
      onChanged();
      setSid(r.stackId);
      await reload(r.stackId);
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-viewer" onClick={onClose}>
      <div className="stack-viewer-card" onClick={(e) => e.stopPropagation()}>
        <div className="stack-viewer-head">
          <b>⧉ 堆叠 · {items.length} 张</b>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm ghost" disabled={busy} onClick={() => void openPicker()}>
              {picker ? '收起列表' : '并入其他堆叠…'}
            </button>
            <button className="btn sm ghost" disabled={busy} onClick={() => void ungroup()}>
              解散堆叠
            </button>
            <button className="btn ghost sm" onClick={onClose} title="关闭">
              <IconClose />
            </button>
          </div>
        </div>
        {picker && (
          <div className="stack-picker">
            {picker.length === 0 && <div className="qc-hint">库里没有其他堆叠可并入。</div>}
            {picker.map((s) => (
              <button
                key={s.stackId}
                className="stack-pick-row"
                disabled={busy}
                title={`并入「${s.title}」这一组（${s.count} 张）`}
                onClick={() => void mergeInto(s)}
              >
                <img src={s.thumbUrl} alt="" loading="lazy" />
                <span className="stack-pick-name">{s.title}</span>
                <span className="stack-pick-count">{s.count} 张</span>
              </button>
            ))}
          </div>
        )}
        <div className="stack-viewer-grid">
          {items.map((it) => (
            <div
              key={it.id}
              className={`stack-tile${it.id === sid || it.stackPrimary ? ' on' : ''}`}
              title={`${it.title}\n点击打开大图`}
              onClick={() => onOpenItem?.(it)}
            >
              <img src={it.thumbUrl} alt={it.title} loading="lazy" />
              <div className="stack-tile-name">{it.title}</div>
              <div style={{ display: 'flex', gap: 4, padding: '0 8px 8px' }}>
                <button
                  className="btn sm ghost"
                  disabled={busy || it.stackPrimary}
                  title="把这版设为堆叠封面（组主）"
                  onClick={(e) => {
                    e.stopPropagation();
                    void makePrimary(it);
                  }}
                >
                  设封面
                </button>
                <button
                  className="btn sm ghost"
                  disabled={busy}
                  title="移出堆叠（不删素材）"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeOne(it);
                  }}
                >
                  移出
                </button>
              </div>
            </div>
          ))}
          {!items.length && <div className="qc-hint">读取堆叠成员…</div>}
        </div>
      </div>
    </div>
  );
}
