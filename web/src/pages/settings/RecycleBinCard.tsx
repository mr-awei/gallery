import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { confirmDialog } from '../../components/Dialogs';
import type { TrashItem } from '../../types';
import { IconTrash } from '../../components/Icons';
import Card from './Card';

interface Props {
  onLibraryChanged: () => void;
  onToast: (msg: string) => void;
}

const PAGE = 50;

function fmtSize(n: number) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtWhen(iso: string) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

/** 「回收站」卡片：最近删除的图片，可恢复 / 彻底删除 */
export default function RecycleBinCard({ onLibraryChanged, onToast }: Props) {
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [q, setQ] = useState('');
  /* 不再硬截断前 20 条：默认铺 50 条，可继续加载，也能按标题/原因/原路径搜 */
  const [shown, setShown] = useState(PAGE);

  /* 读取失败必须说清楚：否则列表为空会被当成「回收站里没东西」 */
  const [loadErr, setLoadErr] = useState('');
  const loadTrash = () =>
    api
      .trash()
      .then((list) => {
        setTrash(list);
        setLoadErr('');
      })
      .catch((err) => setLoadErr((err as Error).message));

  useEffect(() => {
    loadTrash();
  }, []);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return trash;
    return trash.filter((t) =>
      `${t.title || ''} ${t.reason || ''} ${t.originPath || ''} ${t.keyword || ''}`
        .toLowerCase()
        .includes(kw)
    );
  }, [trash, q]);

  useEffect(() => {
    setShown(PAGE);
  }, [q]);

  const restore = async (t: TrashItem) => {
    try {
      await api.restoreTrash(t.id);
      onToast('已恢复到原位置');
      loadTrash();
      onLibraryChanged();
    } catch (err) {
      // 原文件夹被删/盘符离线等情况以前是静默失败，用户以为恢复了
      onToast(`恢复失败：${(err as Error).message}`);
    }
  };

  const purge = async (t: TrashItem) => {
    // 应用内统一用 confirmDialog：window.confirm 在 Electron 里是系统弹窗，样式与其它确认框不一致
    if (!(await confirmDialog(`彻底删除「${t.title}」？此操作不可恢复。`))) return;
    try {
      await api.deleteTrash(t.id);
      loadTrash();
    } catch (err) {
      onToast(`彻底删除失败：${(err as Error).message}`);
    }
  };

  return (
    <Card title={`回收站（${trash.length}）`} desc="删除的图片先进入这里，可随时恢复到原文件夹。">
      {loadErr && (
        <div style={{ color: 'var(--err, #e5484d)', fontSize: 12.5, marginBottom: 8 }}>
          回收站读取失败：{loadErr}
          <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={loadTrash}>
            重试
          </button>
        </div>
      )}
      {!trash.length && !loadErr && (
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>暂无被删除的图片</span>
      )}

      {trash.length > 0 && (
        <div className="kw-row" style={{ marginBottom: 8 }}>
          <input
            className="input"
            placeholder="搜索标题 / 原因 / 原路径"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ flex: 1 }}
          />
          <span style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
            命中 {filtered.length} 条
          </span>
        </div>
      )}

      <div style={{ maxHeight: 340, overflowY: 'auto' }}>
        {filtered.slice(0, shown).map((t) => (
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
                {t.sizeBytes ? ` · ${fmtSize(t.sizeBytes)}` : ''} · {t.reason || '未记录原因'}
                {t.deletedAt ? ` · ${fmtWhen(t.deletedAt)}` : ''}
              </span>
            </span>
            <button className="btn sm" onClick={() => void restore(t)}>
              恢复
            </button>
            <button className="del" title="彻底删除" onClick={() => void purge(t)}>
              <IconTrash />
            </button>
          </div>
        ))}
        {!filtered.length && trash.length > 0 && (
          <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>没有匹配的项目</span>
        )}
      </div>

      {filtered.length > shown && (
        <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setShown((n) => n + PAGE)}>
          显示更多（还有 {filtered.length - shown} 条）
        </button>
      )}

      {trash.length > 0 && (
        <button
          className="btn danger"
          style={{ marginTop: 10 }}
          onClick={async () => {
            if (!window.confirm(`清空回收站？将永久删除 ${trash.length} 个文件，不可恢复。`)) return;
            try {
              const res = await api.emptyTrash();
              onToast(`已彻底删除 ${res.removed} 个文件`);
              loadTrash();
            } catch (err) {
              onToast((err as Error).message);
            }
          }}
        >
          清空回收站
        </button>
      )}
    </Card>
  );
}
