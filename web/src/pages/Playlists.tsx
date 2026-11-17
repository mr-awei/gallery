import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, quiet } from '../api';
import type { ImageItem, Playlist } from '../types';
import { IconClose, IconFolder, IconTrash, IconWallpaper } from '../components/Icons';
import { IconImages } from '../components/Icons';
import { confirmDialog, promptDialog } from '../components/Dialogs';
import VirtualGrid from '../components/VirtualGrid';
import { formatDate } from '../api';
import i18n from '../i18n';

export default function Playlists({
  onToast,
  onOpen,
  onSetWallpaper,
}: {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  onOpen: (item: ImageItem, pool: ImageItem[]) => void;
  onSetWallpaper: (item: ImageItem) => void;
}) {
  const [lists, setLists] = useState<Playlist[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [items, setItems] = useState<ImageItem[]>([]);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  /** 写操作进行中：按钮禁用，避免重复提交同名清单 */
  const [busy, setBusy] = useState(false);
  /** 拉图片的请求序号：快速切 A→B 时，A 的迟到响应不能覆盖 B 的列表 */
  const imageSeq = useRef(0);
  /** 描述草稿：后端 PUT 一直支持 description，界面上原来没有入口，字段永远是空串 */
  const [descDraft, setDescDraft] = useState('');
  const activeList = lists.find((p) => p.id === activeId) || null;

  const refresh = useCallback(() => {
    api.playlists().then(setLists).catch(quiet);
  }, []);

  useEffect(refresh, [refresh]);

  // 切换清单时把草稿同步成该清单的已保存描述（否则会把上一个清单的描述带过去）
  useEffect(() => {
    setDescDraft(activeList?.description || '');
  }, [activeId, activeList?.description]);

  useEffect(() => {
    const seq = ++imageSeq.current;
    if (!activeId) {
      setItems([]);
      return;
    }
    api
      .playlistImages(activeId)
      .then((r) => {
        if (seq === imageSeq.current) setItems(r);
      })
      .catch((err) => {
        if (seq !== imageSeq.current) return;
        setItems([]);
        onToast(i18n.t('k4139a7a1', { p0: (err as Error).message }), 'error');
      });
  }, [activeId, onToast]);

  const create = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      // 描述一起提交：建完再补填的话，用户通常就直接忘了，字段永远空着
      const res = await api.createPlaylist(name, newDesc.trim());
      setLists(res.playlists);
      setNewName('');
      setNewDesc('');
      const created = res.playlists.find((p) => p.name === name);
      if (created) setActiveId(created.id);
      onToast(i18n.t('k264a9434', { p0: name }));
    } catch (err) {
      onToast(i18n.t('k43cb7d41', { p0: (err as Error).message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** 清单改名：API 早就支持 PUT，界面上一直没有入口 */
  const renameList = async (p: Playlist) => {
    const nn = (await promptDialog(i18n.t('k7fece364'), p.name))?.trim();
    if (!nn || nn === p.name) return;
    try {
      const res = await api.updatePlaylist(p.id, { name: nn });
      setLists(res.playlists);
      onToast(i18n.t('k6c93680a', { p0: nn }));
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };

  /** 保存描述（空串表示清空） */
  const saveDescription = async (p: Playlist) => {
    const text = descDraft.trim();
    if (text === (p.description || '')) return;
    try {
      const res = await api.updatePlaylist(p.id, { description: text });
      setLists(res.playlists);
      onToast(text ? i18n.t('k14ffd770') : i18n.t('k926c10f2'));
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };

  const removeList = async (p: Playlist) => {
    if (busy) return;
    if (!(await confirmDialog(i18n.t('kab8f6b47', { p0: p.name })))) return;
    setBusy(true);
    try {
      const res = await api.deletePlaylist(p.id);
      setLists(res.playlists);
      if (activeId === p.id) setActiveId(null);
      onToast(i18n.t('ka4964850', { p0: p.name }));
    } catch (err) {
      onToast(i18n.t('k09d54780', { p0: (err as Error).message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeItem = async (imageId: number) => {
    if (!activeId) return;
    try {
      // 服务端确认成功后再动本地列表：失败时界面不能先「假装已移除」
      const res = await api.removeFromPlaylist(activeId, imageId);
      setLists(res.playlists);
      setItems((prev) => prev.filter((i) => i.id !== imageId));
    } catch (err) {
      onToast(i18n.t('kca479a51', { p0: (err as Error).message }), 'error');
    }
  };

  const useForAuto = async (p: Playlist) => {
    try {
      await api.saveAutoWallpaper({ scope: 'playlist', playlistId: p.id });
      onToast(i18n.t('k5f466f4e', { p0: p.name }));
    } catch (err) {
      onToast(i18n.t('k94a44610', { p0: (err as Error).message }), 'error');
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{i18n.t('k8d9a495b')}</h1>
          <div className="page-sub">{i18n.t('k8993f185')}</div>
        </div>
      </div>

      <div className="crawl-layout" style={{ gridTemplateColumns: '300px 1fr' }}>
        <div className="card">
          <h4 className="section-title">我的清单（{lists.length}）</h4>
          <div className="kw-list" style={{ maxHeight: 320 }}>
            {lists.map((p) => (
              <div
                className="kw-row"
                key={p.id}
                style={{
                  cursor: 'pointer',
                  background: activeId === p.id ? 'rgba(255,77,141,0.14)' : undefined,
                  borderColor: activeId === p.id ? 'rgba(255,77,141,0.45)' : undefined,
                }}
                onClick={() => setActiveId(p.id)}
              >
                <IconFolder />
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}
                  </span>
                  {p.description && (
                    <span
                      style={{
                        color: 'var(--muted)',
                        fontSize: 11,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={p.description}
                    >
                      {p.description}
                    </span>
                  )}
                </span>
                <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>{p.count}</span>
                <button
                  className="mini"
                  title={i18n.t('kc8ce4b36')}
                  onClick={(e) => {
                    e.stopPropagation();
                    void renameList(p);
                  }}
                >
                  {i18n.t('kfc242f92')}
                </button>
                <button
                  className="del"
                  title={i18n.t('k622bcdfe')}
                  aria-label={i18n.t('kd487d92c', { p0: p.name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeList(p);
                  }}
                >
                  <IconTrash />
                </button>
              </div>
            ))}
            {!lists.length && (
              <div style={{ color: 'var(--muted)', fontSize: 13, padding: '8px 4px' }}>
                {i18n.t('k480f58f9')}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder={i18n.t('k6885cb75')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            <button
              className="btn primary"
              disabled={busy || !newName.trim()}
              title={!newName.trim() ? i18n.t('kbd55fa36') : busy ? i18n.t('k9ba2c54c') : i18n.t('kb0afad39')}
              onClick={create}
            >
              {busy ? i18n.t('kd156b373') : i18n.t('k26bb8418')}
            </button>
          </div>
          <input
            className="input"
            style={{ width: '100%', marginTop: 8 }}
            placeholder={i18n.t('kb97bc477')}
            value={newDesc}
            maxLength={500}
            onChange={(e) => setNewDesc(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
        </div>

        <div className="card">
          <h4 className="section-title">
            {activeId ? lists.find((p) => p.id === activeId)?.name : i18n.t('k8a550842')}
            {activeId && (
              <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
                {items.length} 张 · 创建于 {formatDate(lists.find((p) => p.id === activeId)?.created_at || '')}
              </span>
            )}
          </h4>

          {activeId && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button className="btn sm" onClick={() => lists.find((p) => p.id === activeId) && useForAuto(lists.find((p) => p.id === activeId)!)}>
                <IconWallpaper /> {i18n.t('k17c2e0a0')}
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  const p = lists.find((x) => x.id === activeId);
                  if (p) void renameList(p);
                }}
              >
                {i18n.t('k88570a7f')}
              </button>
            </div>
          )}

          {/* 描述：后端 PUT 支持了很久，之前界面没有入口，导致 description 永远是空串 */}
          {activeList && (
            <div style={{ marginBottom: 12 }}>
              <textarea
                className="input"
                style={{ width: '100%', minHeight: 54, resize: 'vertical', lineHeight: 1.6 }}
                placeholder={i18n.t('k7f8a8318')}
                value={descDraft}
                maxLength={500}
                onChange={(e) => setDescDraft(e.target.value)}
                onBlur={() => void saveDescription(activeList)}
              />
              <div className="hint" style={{ margin: '4px 0 0' }}>
                描述会在清单列表里显示，切换清单或失焦时自动保存（{descDraft.length}/500）
              </div>
            </div>
          )}

          {!activeId ? (
            <div className="empty" style={{ padding: '50px 20px' }}>
              <div className="big"><IconFolder size={42} /></div>
              <h3>{i18n.t('kfc79198a')}</h3>
              <p>{i18n.t('k9c393085')}</p>
            </div>
          ) : !items.length ? (
            <div className="empty" style={{ padding: '50px 20px' }}>
              <div className="big"><IconImages size={42} /></div>
              <h3>{i18n.t('k94295a16')}</h3>
              <p>{i18n.t('k3df7bd83')}</p>
            </div>
          ) : (
            /* 清单可能有上千张，走窗口虚拟滚动（列宽 130 / 3:4 与 .recent-grid 一致） */
            <VirtualGrid
              className="recent-grid-v"
              items={items}
              keyOf={(item) => item.id}
              colWidth={130}
              gap={10}
              ratio={3 / 4}
              renderItem={(item) => (
                <div className="recent-cell">
                  <img
                    src={item.thumbUrl}
                    alt={item.title}
                    loading="lazy"
                    onClick={() => onOpen(item, items)}
                    title={`${item.width}×${item.height}`}
                  />
                  <button
                    className="icon-btn"
                    style={{ position: 'absolute', top: 6, right: 6, width: 26, height: 26 }}
                    title={i18n.t('k17212063')}
                    aria-label={i18n.t('k89ea35fe', { p0: item.title || i18n.t('k93e4b3b2') })}
                    onClick={() => removeItem(item.id)}
                  >
                    <IconClose size={13} />
                  </button>
                  <button
                    className="icon-btn"
                    style={{ position: 'absolute', bottom: 6, right: 6, width: 26, height: 26 }}
                    title={i18n.t('k25843df6')}
                    aria-label={i18n.t('k25843df6')}
                    onClick={() => onSetWallpaper(item)}
                  >
                    <IconWallpaper />
                  </button>
                </div>
              )}
            />
          )}
        </div>
      </div>
    </div>
  );
}
