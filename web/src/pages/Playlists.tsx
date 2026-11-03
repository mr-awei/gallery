import React, { useCallback, useEffect, useState } from 'react';
import { api, quiet } from '../api';
import type { ImageItem, Playlist } from '../types';
import { IconFolder, IconTrash, IconWallpaper } from '../components/Icons';
import { promptDialog } from '../components/Dialogs';
import { formatDate } from '../api';

export default function Playlists({
  onToast,
  onOpen,
  onSetWallpaper,
}: {
  onToast: (msg: string) => void;
  onOpen: (item: ImageItem, pool: ImageItem[]) => void;
  onSetWallpaper: (item: ImageItem) => void;
}) {
  const [lists, setLists] = useState<Playlist[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [items, setItems] = useState<ImageItem[]>([]);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
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
    if (!activeId) {
      setItems([]);
      return;
    }
    api.playlistImages(activeId).then(setItems).catch(quiet);
  }, [activeId]);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    // 描述一起提交：建完再补填的话，用户通常就直接忘了，字段永远空着
    const res = await api.createPlaylist(name, newDesc.trim());
    setLists(res.playlists);
    setNewName('');
    setNewDesc('');
    const created = res.playlists.find((p) => p.name === name);
    if (created) setActiveId(created.id);
    onToast(`已创建清单「${name}」`);
  };

  /** 清单改名：API 早就支持 PUT，界面上一直没有入口 */
  const renameList = async (p: Playlist) => {
    const nn = (await promptDialog('清单名称：', p.name))?.trim();
    if (!nn || nn === p.name) return;
    try {
      const res = await api.updatePlaylist(p.id, { name: nn });
      setLists(res.playlists);
      onToast(`已重命名为「${nn}」`);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  /** 保存描述（空串表示清空） */
  const saveDescription = async (p: Playlist) => {
    const text = descDraft.trim();
    if (text === (p.description || '')) return;
    try {
      const res = await api.updatePlaylist(p.id, { description: text });
      setLists(res.playlists);
      onToast(text ? '描述已保存' : '描述已清空');
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const removeList = async (p: Playlist) => {
    if (!window.confirm(`删除清单「${p.name}」？清单内的图片不会被删除。`)) return;
    const res = await api.deletePlaylist(p.id);
    setLists(res.playlists);
    if (activeId === p.id) setActiveId(null);
  };

  const removeItem = async (imageId: number) => {
    if (!activeId) return;
    const res = await api.removeFromPlaylist(activeId, imageId);
    setLists(res.playlists);
    setItems((prev) => prev.filter((i) => i.id !== imageId));
  };

  const useForAuto = async (p: Playlist) => {
    await api.saveAutoWallpaper({ scope: 'playlist', playlistId: p.id });
    onToast(`自动换壁纸已切换到清单「${p.name}」`);
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">清单</h1>
          <div className="page-sub">把喜欢的图收进不同清单，可作为定时换壁纸的切换范围</div>
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
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    void renameList(p);
                  }}
                >
                  改
                </button>
                <button
                  className="del"
                  title="删除清单"
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
                还没有清单。在下方输入名称创建，或到图库批量选中后「加入清单」。
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="新清单名称，如「演唱会壁纸」"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            <button className="btn primary" onClick={create}>
              新建
            </button>
          </div>
          <input
            className="input"
            style={{ width: '100%', marginTop: 8 }}
            placeholder="描述（可选，如「竖版手机壁纸」）"
            value={newDesc}
            maxLength={500}
            onChange={(e) => setNewDesc(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
        </div>

        <div className="card">
          <h4 className="section-title">
            {activeId ? lists.find((p) => p.id === activeId)?.name : '未选择清单'}
            {activeId && (
              <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
                {items.length} 张 · 创建于 {formatDate(lists.find((p) => p.id === activeId)?.created_at || '')}
              </span>
            )}
          </h4>

          {activeId && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button className="btn sm" onClick={() => lists.find((p) => p.id === activeId) && useForAuto(lists.find((p) => p.id === activeId)!)}>
                <IconWallpaper /> 设为自动换壁纸的范围
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  const p = lists.find((x) => x.id === activeId);
                  if (p) void renameList(p);
                }}
              >
                重命名清单
              </button>
            </div>
          )}

          {/* 描述：后端 PUT 支持了很久，之前界面没有入口，导致 description 永远是空串 */}
          {activeList && (
            <div style={{ marginBottom: 12 }}>
              <textarea
                className="input"
                style={{ width: '100%', minHeight: 54, resize: 'vertical', lineHeight: 1.6 }}
                placeholder="给这个清单写点说明，比如「演唱会现场竖版，用于手机壁纸」"
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
              <div className="big">📂</div>
              <h3>选择或新建一个清单</h3>
              <p>清单可以包含任意图片，用于分类收藏或作为定时换壁纸的来源范围。</p>
            </div>
          ) : !items.length ? (
            <div className="empty" style={{ padding: '50px 20px' }}>
              <div className="big">🖼️</div>
              <h3>这个清单还是空的</h3>
              <p>去图库勾选图片后点「加入清单」，就能把它们加进来。</p>
            </div>
          ) : (
            <div className="recent-grid">
              {items.map((item) => (
                <div key={item.id} style={{ position: 'relative' }}>
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
                    title="从清单移除"
                    onClick={() => removeItem(item.id)}
                  >
                    ×
                  </button>
                  <button
                    className="icon-btn"
                    style={{ position: 'absolute', bottom: 6, right: 6, width: 26, height: 26 }}
                    title="设为桌面壁纸"
                    onClick={() => onSetWallpaper(item)}
                  >
                    <IconWallpaper />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
