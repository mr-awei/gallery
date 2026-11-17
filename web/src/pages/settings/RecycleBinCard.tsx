import React, { useCallback, useEffect, useState } from 'react';
import { api, formatSize as fmtSize } from '../../api';
import { confirmDialog } from '../../components/Dialogs';
import type { TrashItem } from '../../types';
import { IconTrash } from '../../components/Icons';
import Card from './Card';
import i18n from '../../i18n';

interface Props {
  onLibraryChanged: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

const PAGE = 50;

function fmtWhen(iso: string) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return i18n.t('k4181f7fe');
  if (diff < 3600_000) return i18n.t('kca5ca1bf', { p0: Math.floor(diff / 60_000) });
  if (diff < 86400_000) return i18n.t('kb64b6d77', { p0: Math.floor(diff / 3600_000) });
  return i18n.t('k9c3df85c', { p0: Math.floor(diff / 86400_000) });
}

/** 「回收站」卡片：最近删除的图片，可恢复 / 彻底删除 */
export default function RecycleBinCard({ onLibraryChanged, onToast }: Props) {
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  /* 服务端分页：每页 50 条，可继续加载。以前是把整个 trash 表一次读进渲染进程。 */
  const [loadingMore, setLoadingMore] = useState(false);

  /* 读取失败必须说清楚：否则列表为空会被当成「回收站里没东西」 */
  const [loadErr, setLoadErr] = useState('');
  const loadTrash = useCallback(
    (offset = 0, append = false) => {
      if (append) setLoadingMore(true);
      return api
        .trash({ limit: PAGE, offset, q: q.trim() })
        .then((r) => {
          const page = Array.isArray(r) ? r : r.items;
          const all = Array.isArray(r) ? r.length : r.total;
          setTrash((prev) => (append ? [...prev, ...page] : page));
          setTotal(all);
          setLoadErr('');
        })
        .catch((err) => setLoadErr((err as Error).message))
        .finally(() => setLoadingMore(false));
    },
    [q]
  );

  useEffect(() => {
    // 关键词改了就重新拉第一页（250ms 防抖，边打字边查也不至于每键一次请求）
    const t = window.setTimeout(() => void loadTrash(0, false), q ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [loadTrash, q]);

  const restore = async (t: TrashItem) => {
    try {
      await api.restoreTrash(t.id);
      onToast(i18n.t('k4bfc16f3'));
      loadTrash();
      onLibraryChanged();
    } catch (err) {
      // 原文件夹被删/盘符离线等情况以前是静默失败，用户以为恢复了
      onToast(i18n.t('k29923a84', { p0: (err as Error).message }), 'error');
    }
  };

  const purge = async (t: TrashItem) => {
    // 应用内统一用 confirmDialog：window.confirm 在 Electron 里是系统弹窗，样式与其它确认框不一致
    if (!(await confirmDialog(i18n.t('k99479387', { p0: t.title })))) return;
    try {
      await api.deleteTrash(t.id);
      loadTrash();
    } catch (err) {
      onToast(i18n.t('k30a26b4f', { p0: (err as Error).message }), 'error');
    }
  };

  return (
    <Card title={i18n.t('k3fcef687', { p0: total })} desc={i18n.t('k7ea12fc3')}>
      {loadErr && (
        <div style={{ color: 'var(--err, #e5484d)', fontSize: 12.5, marginBottom: 8 }}>
          回收站读取失败：{loadErr}
          <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={() => void loadTrash()}>
            {i18n.t('k132c5cdc')}
          </button>
        </div>
      )}
      {!trash.length && !loadErr && (
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>{i18n.t('kc625167b')}</span>
      )}

      {trash.length > 0 && (
        <div className="kw-row" style={{ marginBottom: 8 }}>
          <input
            className="input"
            placeholder={i18n.t('ka82baaa1')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ flex: 1 }}
          />
          <span style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
            命中 {total} 条
          </span>
        </div>
      )}

      <div style={{ maxHeight: 340, overflowY: 'auto' }}>
        {trash.map((t) => (
          <div className="kw-row" key={t.id} style={{ marginBottom: 6 }}>
            <span style={{ flex: 1, fontSize: 12.5, minWidth: 0 }}>
              <span
                title={t.originPath || ''}
                style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {t.title}
              </span>
              <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                {t.width}×{t.height}
                {t.sizeBytes ? ` · ${fmtSize(t.sizeBytes)}` : ''} · {t.reason || i18n.t('k1868aef7')}
                {t.deletedAt ? ` · ${fmtWhen(t.deletedAt)}` : ''}
              </span>
            </span>
            <button className="btn sm" onClick={() => void restore(t)}>
              {i18n.t('kc7db6d4f')}
            </button>
            <button className="del" title={i18n.t('k73279665')} onClick={() => void purge(t)}>
              <IconTrash />
            </button>
          </div>
        ))}
        {!trash.length && total > 0 && !loadErr && (
          <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>{i18n.t('kf7d44a46')}</span>
        )}
      </div>

      {trash.length < total && (
        <button
          className="btn sm"
          style={{ marginTop: 8 }}
          disabled={loadingMore}
          title={i18n.t('kdff7ad9a', { p0: trash.length, p1: total })}
          onClick={() => void loadTrash(trash.length, true)}
        >
          {loadingMore ? i18n.t('k768bbcdb') : i18n.t('k064c05b0', { p0: total - trash.length })}
        </button>
      )}

      {total > 0 && (
        <button
          className="btn danger"
          style={{ marginTop: 10 }}
          onClick={async () => {
            if (!(await confirmDialog(i18n.t('k0ad9b2ad', { p0: total })))) return;
            try {
              const res = await api.emptyTrash();
              if (res.failed?.length) {
                onToast(
                  i18n.t('k5afaa998', { p0: res.removed, p1: res.failed.length }),
                  'error'
                );
              } else {
                onToast(i18n.t('ka1996aba', { p0: res.removed }));
              }
              loadTrash();
            } catch (err) {
              onToast((err as Error).message, 'error');
            }
          }}
        >
          {i18n.t('k8cd6bc18')}
        </button>
      )}
    </Card>
  );
}
