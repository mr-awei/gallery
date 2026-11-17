import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, downloadFile, type SmartFolder } from '../api';
import type { ImageItem } from '../types';
import ImageCard from '../components/ImageCard';
import { confirmDialog, promptDialog } from '../components/Dialogs';
import MasonryGrid from '../components/MasonryGrid';
import SmartFolderEditor from '../components/SmartFolderEditor';
import i18n from '../i18n';

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
    const nn = await promptDialog(i18n.t('k7b415503'), oldName);
    if (!nn || nn === oldName) return;
    try {
      await api.renameTag(oldName, nn);
      refreshTags();
      onToast(i18n.t('k61a9fc03', { p0: oldName, p1: nn }));
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };
  const deleteTag = async (t: string) => {
    if (!(await confirmDialog(i18n.t('ke5f8ed00', { p0: t })))) return;
    try {
      await api.deleteTag(t);
      refreshTags();
      onToast(i18n.t('k06026f97', { p0: t }));
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };
  const mergeTag = async (from: string) => {
    const to = await promptDialog(i18n.t('kb3accc80', { p0: from }), from);
    if (!to || to === from) return;
    try {
      await api.mergeTags(from, to);
      refreshTags();
      onToast(i18n.t('kefd18f07', { p0: from, p1: to }));
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
        onToast(i18n.t('k8c62ab12', { p0: payload.name }));
        // 改完条件，正在看的预览要按新条件重查，否则标题变了内容还是旧的
        const next = r.folders.find((f) => f.id === editing.id);
        if (next && previewFolder?.id === editing.id) void preview(next);
      } else {
        const r = await api.createSmartFolder(payload);
        setFolders(r.folders);
        onToast(i18n.t('k70e90cb3'));
      }
      // 成功才关编辑器：失败时用户填的条件不能被清掉
      setEditing(undefined);
    } catch (err) {
      onToast(i18n.t('k3ce5eb8f', { p0: (err as Error).message }), 'error');
    }
  };

  const applyTags = async (id: number, fname: string) => {
    try {
      const r = await api.applySmartFolderTags(id);
      refreshTags();
      onToast(i18n.t('kef08d54d', { p0: fname, p1: r.changed }));
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
      onToast(updated.favorite ? i18n.t('k15128612') : i18n.t('k3a906c71'));
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };

  const delFolder = async (id: number) => {
    if (!(await confirmDialog(i18n.t('k622a3fa4')))) return;
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
      onToast(i18n.t('k78cd2a13'));
    } catch (err) {
      onToast(i18n.t('k94229cac', { p0: (err as Error).message }), 'error');
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>{i18n.t('k5587994f')}</h2>
        <p className="page-sub">{i18n.t('k6943ee8c')}</p>
      </div>

      <h3>{i18n.t('k14d34236')}</h3>
      <div className="tag-cloud">
        {tags.length === 0 && <span className="muted">{i18n.t('kae1a5e64')}</span>}
        {tags.map((t) => (
          <div className="tag-chip" key={t.tag}>
            <span className="tname">{t.tag}</span>
            <span className="tcount">{t.count}</span>
            <span className="tactions">
              <button className="mini" title={i18n.t('kc8ce4b36')} onClick={() => renameTag(t.tag)}>
                {i18n.t('kfc242f92')}
              </button>
              <button className="mini" title={i18n.t('k95144b30')} onClick={() => mergeTag(t.tag)}>
                {i18n.t('k65698012')}
              </button>
              <button className="mini danger" title={i18n.t('k2f4aaddd')} onClick={() => deleteTag(t.tag)}>
                {i18n.t('kfe5c38f2')}
              </button>
            </span>
          </div>
        ))}
      </div>
      {tagTotal > tags.length && (
        <button className="btn sm" disabled={tagLoading} onClick={() => loadTags(false)} style={{ marginTop: 8 }}>
          {tagLoading ? i18n.t('kfb4ca1cf') : i18n.t('kb8d4835a', { p0: tagTotal - tags.length })}
        </button>
      )}

      <h3>{i18n.t('k04ff0a57')}</h3>
      <div className="sf-form">
        <button className="btn primary" onClick={() => setEditing(null)}>
          {i18n.t('k1bc362a1')}
        </button>
        <span className="muted small">{i18n.t('k86f85ad7')}</span>
      </div>

      <div className="sf-list">
        {folders.length === 0 && <span className="muted">{i18n.t('k6c8401ed')}</span>}
        {folders.map((f) => (
          <div className="sf-item" key={f.id}>
            <div className="sf-main">
              <b>{f.name}</b>
              {f.autoTags.length > 0 && (
                <span className="sf-tags">自动标签：{f.autoTags.join('、')}</span>
              )}
              <span className="muted small">{Object.keys(f.rules).length ? i18n.t('k0217ad9f') : i18n.t('k16d53389')}</span>
            </div>
            <div className="sf-actions">
              <button className="btn sm" onClick={() => preview(f)}>
                {i18n.t('k607e7a4f')}
              </button>
              <button className="btn sm" onClick={() => setEditing(f)}>
                {i18n.t('k95b351c8')}
              </button>
              <button className="btn sm" onClick={() => applyTags(f.id, f.name)}>
                {i18n.t('k8f5f2631')}
              </button>
              <button className="btn sm ghost" onClick={() => delFolder(f.id)}>
                {i18n.t('k2f4aaddd')}
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
                {i18n.t('kb15d9127')}
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
                    title={previewLoading ? i18n.t('k2c893495') : i18n.t('kf848e50c')}
                    onClick={loadMorePreview}
                  >
                    {previewLoading ? i18n.t('kfb4ca1cf') : i18n.t('k77281549')}
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
