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
import { IconClose, IconStack } from './Icons';
import i18n from '../i18n';

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
      onToast(i18n.t('k0403886e', { p0: r.removed }));
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
      onToast(i18n.t('k16557bc1', { p0: item.title }));
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
      onToast(i18n.t('k15136e57', { p0: r.stacks.length }));
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
      onToast(i18n.t('k125d386b', { p0: item.title }));
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
    <div className="stack-viewer" onClick={onClose} data-a11y-dialog="esc" aria-label={i18n.t('kc6856b30')}>
      <div className="stack-viewer-card" onClick={(e) => e.stopPropagation()}>
        <div className="stack-viewer-head">
          <b>
            <IconStack size={14} /> {i18n.t('k3c932e60')}
            {items.length}
            {i18n.t('k6499fc74')}
          </b>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm ghost" disabled={busy} onClick={() => void openPicker()}>
              {picker ? i18n.t('k3d283f1d') : i18n.t('k06bbf175')}
            </button>
            <button className="btn sm ghost" disabled={busy} onClick={() => void ungroup()}>
              {i18n.t('k7228c050')}
            </button>
            <button className="btn ghost sm" onClick={onClose} title={i18n.t('kb15d9127')}>
              <IconClose />
            </button>
          </div>
        </div>
        {picker && (
          <div className="stack-picker">
            {picker.length === 0 && <div className="qc-hint">{i18n.t('k6a10e6ec')}</div>}
            {picker.map((s) => (
              <button
                key={s.stackId}
                className="stack-pick-row"
                disabled={busy}
                title={i18n.t('ka13fd96c', { p0: s.title, p1: s.count })}
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
              title={i18n.t('k1f608e3f', { p0: it.title })}
              onClick={() => onOpenItem?.(it)}
            >
              <img src={it.thumbUrl} alt={it.title} loading="lazy" />
              <div className="stack-tile-name">{it.title}</div>
              <div style={{ display: 'flex', gap: 4, padding: '0 8px 8px' }}>
                <button
                  className="btn sm ghost"
                  disabled={busy || it.stackPrimary}
                  title={i18n.t('kdf044589')}
                  onClick={(e) => {
                    e.stopPropagation();
                    void makePrimary(it);
                  }}
                >
                  {i18n.t('kf2a3d97f')}
                </button>
                <button
                  className="btn sm ghost"
                  disabled={busy}
                  title={i18n.t('k665598f1')}
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeOne(it);
                  }}
                >
                  {i18n.t('k63ae0f6a')}
                </button>
              </div>
            </div>
          ))}
          {!items.length && <div className="qc-hint">{i18n.t('kd8382453')}</div>}
        </div>
      </div>
    </div>
  );
}
