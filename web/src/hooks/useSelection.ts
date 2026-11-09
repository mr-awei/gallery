import { useCallback, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { api } from '../api';
import type { Filters, ImageItem } from '../types';
import { confirmDialog } from '../components/Dialogs';

type Toast = (msg: string, kind?: 'info' | 'error') => void;

/**
 * 多选与批量操作。
 * 选中集合必须在「换筛选 / 换文件夹 / 换库」时清空：批量删除直接取 [...selected]，
 * 不清空会删掉用户当前看不见的那批图。
 */
export function useSelection({
  showToast,
  items,
  filtersRef,
  folderIdRef,
  pageRef,
  load,
  refreshStats,
}: {
  showToast: Toast;
  items: ImageItem[];
  filtersRef: MutableRefObject<Filters>;
  folderIdRef: MutableRefObject<number | null>;
  pageRef: MutableRefObject<number>;
  load: (page: number, reset: boolean) => Promise<void>;
  refreshStats: () => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const selectingAllRef = useRef(false);
  const bulkBusyRef = useRef(false);

  const toggleSelect = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set<number>()), []);

  /**
   * 全选 = 选中「当前筛选条件下的全部图片」，不只是已经加载的那一页。
   * 原来 Ctrl+A 只 setSelected(items)，用户以为选全了，批量删/移动其实只处理一页。
   */
  const selectAllMatching = useCallback(async () => {
    if (selectingAllRef.current) return;
    selectingAllRef.current = true;
    try {
      // 文件夹视图必须把 folderId 一起带上：只传 filters 会选中全库匹配项，
      // 用户以为只选了当前文件夹，批量删除却波及范围外的图
      const r = await api.imageIds(filtersRef.current, { folderId: folderIdRef.current });
      setSelected(new Set(r.ids));
      const scope = folderIdRef.current ? '当前文件夹（含子文件夹）' : '当前筛选';
      showToast(
        r.truncated
          ? `范围共 ${r.total} 张，已选中前 ${r.ids.length} 张（超出上限，请先缩小筛选）`
          : r.total > items.length
            ? `已选中${scope}全部 ${r.total} 张（当前只显示 ${items.length} 张）`
            : `已选中${scope} ${r.total} 张`
      );
    } catch (err) {
      showToast(`全选失败：${(err as Error).message}`);
    } finally {
      selectingAllRef.current = false;
    }
  }, [items.length, showToast, filtersRef, folderIdRef]);

  const selectAll = useCallback(() => void selectAllMatching(), [selectAllMatching]);

  const bulk = useCallback(
    async (action: string, tag?: string) => {
      if (bulkBusyRef.current) return; // 批量任务进行中忽略重复触发（双击 / 回车重放）
      const ids = [...selected];
      if (!ids.length) return;
      if (action === 'delete' && !(await confirmDialog(`确定删除选中的 ${ids.length} 张图片？`))) return;
      bulkBusyRef.current = true;
      try {
        await api.batch(ids, action, tag);
        showToast(action === 'delete' ? `已删除 ${ids.length} 张` : `已更新 ${ids.length} 张`);
        setSelected(new Set());
        pageRef.current = 1;
        load(1, true);
        refreshStats();
      } catch (err) {
        // 之前失败是静默的：用户以为删了/收藏了，实际什么都没发生
        showToast(`批量操作失败：${(err as Error).message}`);
      } finally {
        bulkBusyRef.current = false;
      }
    },
    [selected, load, refreshStats, showToast, pageRef]
  );

  return { selected, setSelected, toggleSelect, clearSelection, selectAll, selectAllMatching, bulk };
}
