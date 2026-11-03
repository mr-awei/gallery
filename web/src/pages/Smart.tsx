import React, { useCallback, useEffect, useState } from 'react';
import { api, downloadFile, type SmartFolder } from '../api';
import type { ImageItem } from '../types';
import ImageCard from '../components/ImageCard';
import { promptDialog } from '../components/Dialogs';
import MasonryGrid from '../components/MasonryGrid';
import SmartFolderEditor from '../components/SmartFolderEditor';

interface Props {
  onToast: (msg: string) => void;
  /** 打开大图预览（App 级 Lightbox，可在预览列表间导航） */
  onOpenItem?: (item: ImageItem, pool?: ImageItem[]) => void;
}

export default function Smart({ onToast, onOpenItem }: Props) {
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [folders, setFolders] = useState<SmartFolder[]>([]);
  const [previewItems, setPreviewItems] = useState<ImageItem[] | null>(null);
  const [previewName, setPreviewName] = useState('');
  /* 预览网格的选择态与收藏：以前传的是空函数，勾选框点了没反应 */
  const [previewSel, setPreviewSel] = useState<Set<number>>(new Set());
  /* 预览分页：大库下不再一次全拉回来 */
  const [previewFolder, setPreviewFolder] = useState<SmartFolder | null>(null);
  const [previewTotal, setPreviewTotal] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);

  /** 编辑器：undefined = 关闭，null = 新建，对象 = 编辑 */
  const [editing, setEditing] = useState<SmartFolder | null | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [t, f] = await Promise.all([api.tags(), api.smartFolders()]);
      setTags(t.tags);
      setFolders(f);
    } catch (err) {
      onToast((err as Error).message);
    }
  }, [onToast]);

  useEffect(() => {
    load();
  }, [load]);

  const refreshTags = (r: { tags: { tag: string; count: number }[] }) => setTags(r.tags);

  const renameTag = async (oldName: string) => {
    const nn = await promptDialog('重命名为：', oldName);
    if (!nn || nn === oldName) return;
    try {
      refreshTags(await api.renameTag(oldName, nn));
      onToast(`已重命名 ${oldName} → ${nn}`);
    } catch (err) {
      onToast((err as Error).message);
    }
  };
  const deleteTag = async (t: string) => {
    if (!window.confirm(`删除标签「${t}」（会从所有图片上摘除）？`)) return;
    try {
      refreshTags(await api.deleteTag(t));
      onToast(`已删除标签 ${t}`);
    } catch (err) {
      onToast((err as Error).message);
    }
  };
  const mergeTag = async (from: string) => {
    const to = await promptDialog(`把「${from}」合并到（输入目标标签名）：`, from);
    if (!to || to === from) return;
    try {
      refreshTags(await api.mergeTags(from, to));
      onToast(`已合并 ${from} → ${to}`);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  /** 新建 / 编辑共用：以前只有新建，建完规则就再也改不了 */
  const saveFolder = async (payload: { name: string; rules: Record<string, unknown>; autoTags: string[] }) => {
    if (editing) {
      const r = await api.updateSmartFolder(editing.id, payload);
      setFolders(r.folders);
      onToast(`已更新「${payload.name}」`);
    } else {
      const r = await api.createSmartFolder(payload);
      setFolders(r.folders);
      onToast('已创建智能文件夹');
    }
    setEditing(undefined);
  };

  const applyTags = async (id: number, fname: string) => {
    try {
      const r = await api.applySmartFolderTags(id);
      setTags(r.tags);
      onToast(`已把「${fname}」的标签继承到 ${r.changed} 张图`);
      load();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const preview = async (f: SmartFolder) => {
    setPreviewLoading(true);
    try {
      const r = await api.previewSmartFolder(f.id, { limit: 200 });
      setPreviewItems(r.items);
      setPreviewSel(new Set());
      setPreviewFolder(f);
      setPreviewTotal(r.total);
      setPreviewName(f.name);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setPreviewLoading(false);
    }
  };

  const loadMorePreview = async () => {
    if (!previewFolder || previewLoading) return;
    setPreviewLoading(true);
    try {
      const r = await api.previewSmartFolder(previewFolder.id, {
        limit: 200,
        offset: previewItems?.length || 0,
      });
      setPreviewItems((prev) => {
        const seen = new Set((prev || []).map((x) => x.id));
        return [...(prev || []), ...r.items.filter((x) => !seen.has(x.id))];
      });
      setPreviewTotal(r.total);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setPreviewLoading(false);
    }
  };

  /** 预览网格里直接收藏/取消收藏（原来按钮点了没有任何反应） */
  const togglePreviewFav = async (it: ImageItem) => {
    try {
      const updated = await api.patch(it.id, { favorite: !it.favorite });
      setPreviewItems((prev) => (prev ? prev.map((x) => (x.id === updated.id ? updated : x)) : prev));
      onToast(updated.favorite ? '已加入收藏' : '已取消收藏');
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const delFolder = async (id: number) => {
    if (!window.confirm('删除该智能文件夹？')) return;
    try {
      const r = await api.deleteSmartFolder(id);
      setFolders(r.folders);
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>标签与智能文件夹</h2>
        <p className="page-sub">标签管理（改名 / 合并 / 删除）· 智能文件夹按条件自动归类 + 文件夹标签继承</p>
      </div>

      <h3>标签</h3>
      <div className="tag-cloud">
        {tags.length === 0 && <span className="muted">还没有标签，可在大图预览里给图片加标签。</span>}
        {tags.map((t) => (
          <div className="tag-chip" key={t.tag}>
            <span className="tname">{t.tag}</span>
            <span className="tcount">{t.count}</span>
            <span className="tactions">
              <button className="mini" title="重命名" onClick={() => renameTag(t.tag)}>
                改
              </button>
              <button className="mini" title="合并到…" onClick={() => mergeTag(t.tag)}>
                并
              </button>
              <button className="mini danger" title="删除" onClick={() => deleteTag(t.tag)}>
                删
              </button>
            </span>
          </div>
        ))}
      </div>

      <h3>智能文件夹</h3>
      <div className="sf-form">
        <button className="btn primary" onClick={() => setEditing(null)}>
          新建智能文件夹
        </button>
        <span className="muted small">按条件自动归类；建好后可随时改条件</span>
      </div>

      <div className="sf-list">
        {folders.length === 0 && <span className="muted">还没有智能文件夹。</span>}
        {folders.map((f) => (
          <div className="sf-item" key={f.id}>
            <div className="sf-main">
              <b>{f.name}</b>
              {f.autoTags.length > 0 && (
                <span className="sf-tags">自动标签：{f.autoTags.join('、')}</span>
              )}
              <span className="muted small">{Object.keys(f.rules).length ? '含规则' : '仅自动标签'}</span>
            </div>
            <div className="sf-actions">
              <button className="btn sm" onClick={() => preview(f)}>
                查看
              </button>
              <button className="btn sm" onClick={() => setEditing(f)}>
                编辑
              </button>
              <button className="btn sm" onClick={() => applyTags(f.id, f.name)}>
                应用标签(继承)
              </button>
              <button className="btn sm ghost" onClick={() => delFolder(f.id)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {previewItems && (
        <div className="lb-overlay" onClick={() => setPreviewItems(null)}>
          <div className="lb-box wide" onClick={(e) => e.stopPropagation()}>
            <div className="lb-head">
              <b>
                {previewName}（{previewTotal} 张）
              </b>
              <button className="btn sm ghost" onClick={() => setPreviewItems(null)}>
                关闭
              </button>
            </div>
            {/* 弹窗内容超出 90vh 滚动，MasonryGrid 会自动探测滚动容器做虚拟化 */}
            <div style={{ padding: 16 }}>
              <MasonryGrid
                items={previewItems}
                renderItem={(it) => (
                  <ImageCard
                    item={it}
                    selected={previewSel.has(it.id)}
                    onOpen={(i) => onOpenItem?.(i, previewItems ?? undefined)}
                    onToggleSelect={() =>
                      setPreviewSel((prev) => {
                        const next = new Set(prev);
                        if (next.has(it.id)) next.delete(it.id);
                        else next.add(it.id);
                        return next;
                      })
                    }
                    onToggleFavorite={() => void togglePreviewFav(it)}
                    onDownload={(x) => downloadFile(x.downloadUrl || x.url)}
                  />
                )}
              />
              <div className="sf-preview-foot">
                <span className="muted small">
                  已显示 {previewItems.length} / {previewTotal} 张
                </span>
                {previewItems.length < previewTotal && (
                  <button className="btn sm" disabled={previewLoading} onClick={loadMorePreview}>
                    {previewLoading ? '加载中…' : '加载更多'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {editing !== undefined && (
        <SmartFolderEditor
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSubmit={saveFolder}
        />
      )}
    </div>
  );
}
