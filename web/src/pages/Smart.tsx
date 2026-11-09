import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, downloadFile, type SmartFolder } from '../api';
import type { ImageItem } from '../types';
import ImageCard from '../components/ImageCard';
import { confirmDialog, promptDialog } from '../components/Dialogs';
import MasonryGrid from '../components/MasonryGrid';
import SmartFolderEditor from '../components/SmartFolderEditor';

interface Props {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  /** 标签改名/删除/合并后通知上层：侧栏 TagPanel 用的是 App 那份 tags，不能只更新本页 */
  onTagsChanged?: () => void;
  /** 打开大图预览（App 级 Lightbox，可在预览列表间导航） */
  onOpenItem?: (item: ImageItem, pool?: ImageItem[]) => void;
}

export default function Smart({ onToast, onTagsChanged, onOpenItem }: Props) {
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [tagOffset, setTagOffset] = useState(0);
  const [tagTotal, setTagTotal] = useState(0);
  const [tagLoading, setTagLoading] = useState(false);
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

  const TAG_PAGE = 100;
  /** 标签分页：标签几千条时不一次拉完，初始拉一页，改名/合并/删除后回到第一页 */
  const loadTags = useCallback(
    async (reset: boolean) => {
      setTagLoading(true);
      try {
        const offset = reset ? 0 : tagOffset;
        const r = await api.tags({ limit: TAG_PAGE, offset });
        if (reset) {
          setTags(r.tags);
          setTagOffset(r.tags.length);
        } else {
          setTags((prev) => [...prev, ...r.tags]);
          setTagOffset((o) => o + r.tags.length);
        }
        setTagTotal(r.total ?? 0);
      } catch (err) {
        onToast((err as Error).message, 'error');
      } finally {
        setTagLoading(false);
      }
    },
    [tagOffset, onToast]
  );

  const load = useCallback(async () => {
    try {
      await loadTags(true);
      const f = await api.smartFolders();
      setFolders(f);
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  }, [loadTags, onToast]);

  useEffect(() => {
    load();
  }, [load]);

  /** 标签变更后：本页重新拉第一页，同时通知 App 刷新侧栏用的那份 */
  const refreshTags = () => {
    loadTags(true);
    onTagsChanged?.();
  };

  const renameTag = async (oldName: string) => {
    const nn = await promptDialog('重命名为：', oldName);
    if (!nn || nn === oldName) return;
    try {
      await api.renameTag(oldName, nn);
      refreshTags();
      onToast(`已重命名 ${oldName} → ${nn}`);
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };
  const deleteTag = async (t: string) => {
    if (!(await confirmDialog(`删除标签「${t}」（会从所有图片上摘除）？`))) return;
    try {
      await api.deleteTag(t);
      refreshTags();
      onToast(`已删除标签 ${t}`);
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };
  const mergeTag = async (from: string) => {
    const to = await promptDialog(`把「${from}」合并到（输入目标标签名）：`, from);
    if (!to || to === from) return;
    try {
      await api.mergeTags(from, to);
      refreshTags();
      onToast(`已合并 ${from} → ${to}`);
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };

  /** 新建 / 编辑共用：以前只有新建，建完规则就再也改不了 */
  const saveFolder = async (payload: { name: string; rules: Record<string, unknown>; autoTags: string[] }) => {
    try {
      if (editing) {
        const r = await api.updateSmartFolder(editing.id, payload);
        setFolders(r.folders);
        onToast(`已更新「${payload.name}」`);
        // 改完条件，正在看的预览要按新条件重查，否则标题变了内容还是旧的
        const next = r.folders.find((f) => f.id === editing.id);
        if (next && previewFolder?.id === editing.id) void preview(next);
      } else {
        const r = await api.createSmartFolder(payload);
        setFolders(r.folders);
        onToast('已创建智能文件夹');
      }
      // 成功才关编辑器：失败时用户填的条件不能被清掉
      setEditing(undefined);
    } catch (err) {
      onToast(`保存智能文件夹失败：${(err as Error).message}`, 'error');
    }
  };

  const applyTags = async (id: number, fname: string) => {
    try {
      const r = await api.applySmartFolderTags(id);
      refreshTags();
      onToast(`已把「${fname}」的标签继承到 ${r.changed} 张图`);
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };

  /**
   * 预览请求序号：连点 A、B 两个智能文件夹时，A 的响应可能晚于 B。
   * 没有序号校验的话会出现「标题是 B、内容还是 A」，随后「加载更多」还会
   * 用 A 的条数当 offset 去查 B —— 列表整个错位。
   */
  const previewSeq = useRef(0);

  const preview = async (f: SmartFolder) => {
    const seq = ++previewSeq.current;
    setPreviewLoading(true);
    try {
      const r = await api.previewSmartFolder(f.id, { limit: 200 });
      if (seq !== previewSeq.current) return; // 已经切到别的文件夹
      setPreviewItems(r.items);
      setPreviewSel(new Set());
      setPreviewFolder(f);
      setPreviewTotal(r.total);
      setPreviewName(f.name);
    } catch (err) {
      if (seq === previewSeq.current) onToast((err as Error).message, 'error');
    } finally {
      if (seq === previewSeq.current) setPreviewLoading(false);
    }
  };

  const loadMorePreview = async () => {
    if (!previewFolder || previewLoading) return;
    const seq = previewSeq.current; // 记住目标：期间切换了文件夹就丢弃这批结果
    setPreviewLoading(true);
    try {
      const r = await api.previewSmartFolder(previewFolder.id, {
        limit: 200,
        offset: previewItems?.length || 0,
      });
      if (seq !== previewSeq.current) return;
      setPreviewItems((prev) => {
        const seen = new Set((prev || []).map((x) => x.id));
        return [...(prev || []), ...r.items.filter((x) => !seen.has(x.id))];
      });
      setPreviewTotal(r.total);
    } catch (err) {
      if (seq === previewSeq.current) onToast((err as Error).message, 'error');
    } finally {
      if (seq === previewSeq.current) setPreviewLoading(false);
    }
  };

  /** 预览网格里直接收藏/取消收藏（原来按钮点了没有任何反应） */
  const togglePreviewFav = async (it: ImageItem) => {
    try {
      const updated = await api.patch(it.id, { favorite: !it.favorite });
      setPreviewItems((prev) => (prev ? prev.map((x) => (x.id === updated.id ? updated : x)) : prev));
      onToast(updated.favorite ? '已加入收藏' : '已取消收藏');
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };

  const delFolder = async (id: number) => {
    if (!(await confirmDialog('删除该智能文件夹？'))) return;
    try {
      const r = await api.deleteSmartFolder(id);
      setFolders(r.folders);
      // 删掉的正是预览中的那个夹子：必须把预览一起关掉，否则"还没有智能文件夹"
      // 与 7541 张旧结果同屏显示，用户会以为删不掉
      if (previewFolder?.id === id) {
        previewSeq.current++;
        setPreviewItems(null);
        setPreviewFolder(null);
        setPreviewName('');
        setPreviewTotal(0);
        setPreviewSel(new Set());
      }
      onToast('已删除智能文件夹');
    } catch (err) {
      onToast(`删除失败：${(err as Error).message}`, 'error');
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
      {tagTotal > tags.length && (
        <button className="btn sm" disabled={tagLoading} onClick={() => loadTags(false)} style={{ marginTop: 8 }}>
          {tagLoading ? '加载中…' : `加载更多标签（还剩 ${tagTotal - tags.length} 个）`}
        </button>
      )}

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
            {/* 内容区自己滚（.lb-body），MasonryGrid 探测这个滚动容器做虚拟化 */}
            <div className="lb-body" style={{ padding: 16 }}>
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
                  <button
                    className="btn sm"
                    disabled={previewLoading}
                    title={previewLoading ? '上一页还在加载' : '继续加载这个智能文件夹里的图片'}
                    onClick={loadMorePreview}
                  >
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
