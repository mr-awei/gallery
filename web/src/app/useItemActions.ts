import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { api, downloadFile, quiet } from '../api';
import { reasonLabel } from '../components/DeleteReasonDialog';
import type { LightboxState } from '../hooks/useLightbox';
import type { ImageItem, Stats, TagNode } from '../types';
import type { Toast } from './types';

type Options = {
  patchItem: (updated: ImageItem) => void;
  setStats: Dispatch<SetStateAction<Stats | null>>;
  setItems: Dispatch<SetStateAction<ImageItem[]>>;
  setLb: Dispatch<SetStateAction<LightboxState>>;
  setTags: Dispatch<SetStateAction<TagNode[]>>;
  setTagGroups: Dispatch<SetStateAction<string[]>>;
  refreshStats: () => void;
  showToast: Toast;
};

/**
 * 单张素材上的用户操作：收藏 / 改标签 / 删除（带原因）/ 设壁纸 / 下载。
 * 全部是回调、没有 effect，所以调用位置不影响任何 effect 的执行顺序。
 */
export function useItemActions({
  patchItem,
  setStats,
  setItems,
  setLb,
  setTags,
  setTagGroups,
  refreshStats,
  showToast,
}: Options) {
  const [pendingDelete, setPendingDelete] = useState<ImageItem | null>(null);

  const toggleFavorite = useCallback(
    async (item: ImageItem) => {
      const updated = await api.patch(item.id, { favorite: !item.favorite });
      patchItem(updated);
      setStats((prev) =>
        prev ? { ...prev, favorite: prev.favorite + (updated.favorite ? 1 : -1) } : prev
      );
    },
    [patchItem, setStats]
  );

  const saveTags = useCallback(
    async (item: ImageItem, tagList: string[]) => {
      const updated = await api.patch(item.id, { tags: tagList });
      patchItem(updated);
      api
        .tags()
        .then((r) => {
          setTags(r.tags);
          setTagGroups(r.groups);
        })
        .catch(quiet);
    },
    [patchItem, setTags, setTagGroups]
  );

  /** 请求删除：弹出「为什么不满意」对话框，让 AI 学习 */
  const requestDelete = useCallback((item: ImageItem) => {
    setPendingDelete(item);
  }, []);

  const confirmDelete = useCallback(
    async (payload: { reasons: string[]; note: string; aiAnalysis: string; learn: boolean }) => {
      const item = pendingDelete;
      if (!item) return;
      setPendingDelete(null);
      try {
        if (!payload.learn) {
          await api.remove(item.id);
          showToast('已删除（未记录反馈）');
        } else {
          await api.deleteWithReason(item.id, payload);
          showToast(
            payload.reasons.length
              ? `已删除并记录：${payload.reasons.map(reasonLabel).join('、')}（可在 AI 知识库一键归纳）`
              : '已删除'
          );
        }
      } catch (err) {
        showToast((err as Error).message);
      }
      setItems((prev) => prev.filter((it) => it.id !== item.id));
      setLb((prev) => {
        if (!prev) return prev;
        const rest = prev.items.filter((it) => it.id !== item.id);
        if (!rest.length) return null;
        return { items: rest, index: Math.min(prev.index, rest.length - 1) };
      });
      refreshStats();
    },
    [pendingDelete, refreshStats, showToast, setItems, setLb]
  );

  const setWallpaper = useCallback(
    async (item: ImageItem, style?: string) => {
      try {
        const res = await api.wallpaper(item.id, style);
        showToast(
          res.generated
            ? `已设为壁纸：按屏幕 ${res.screen.width}×${res.screen.height} 合成，竖版完整居中不裁切`
            : '已设为桌面壁纸（原图铺满）'
        );
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [showToast]
  );

  const download = useCallback((item: ImageItem) => {
    downloadFile(item.downloadUrl);
  }, []);

  /** 图库网格里删除一张：先本地摘掉再对账，别让用户等接口回来 */
  const deleteFromGrid = useCallback(
    (item: ImageItem) => {
      setItems((prev) => prev.filter((it) => it.id !== item.id));
      setLb((prev) => {
        if (!prev) return prev;
        const rest = prev.items.filter((it) => it.id !== item.id);
        if (!rest.length) return null;
        return { items: rest, index: Math.min(prev.index, rest.length - 1) };
      });
      refreshStats();
    },
    [refreshStats, setItems, setLb]
  );

  return {
    pendingDelete,
    setPendingDelete,
    requestDelete,
    confirmDelete,
    toggleFavorite,
    saveTags,
    deleteFromGrid,
    setWallpaper,
    download,
  };
}
