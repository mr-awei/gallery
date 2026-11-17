import { useCallback, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { api } from '../api';
import type { Filters, ImageItem } from '../types';
import { confirmDialog } from '../components/Dialogs';
import i18n from '../i18n';

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
      const scope = folderIdRef.current ? i18n.t('k7f827d38') : i18n.t('k10265f4e');
      showToast(
        r.truncated
          ? i18n.t('k41a42244', { p0: r.total, p1: r.ids.length })
          : r.total > items.length
            ? i18n.t('k50976f3d', { p0: scope, p1: r.total, p2: items.length })
            : i18n.t('k1c23d9d6', { p0: scope, p1: r.total })
      );
    } catch (err) {
      showToast(i18n.t('ka4ae6f84', { p0: (err as Error).message }));
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
      if (action === 'delete' && !(await confirmDialog(i18n.t('k513a2249', { p0: ids.length })))) return;
      bulkBusyRef.current = true;
      try {
        await api.batch(ids, action, tag);
        showToast(action === 'delete' ? i18n.t('k29d27075', { p0: ids.length }) : i18n.t('k7f3a62b2', { p0: ids.length }));
        setSelected(new Set());
        pageRef.current = 1;
        load(1, true);
        refreshStats();
      } catch (err) {
        // 之前失败是静默的：用户以为删了/收藏了，实际什么都没发生
        showToast(i18n.t('kcf6313ff', { p0: (err as Error).message }));
      } finally {
        bulkBusyRef.current = false;
      }
    },
    [selected, load, refreshStats, showToast, pageRef]
  );

  return { selected, setSelected, toggleSelect, clearSelection, selectAll, selectAllMatching, bulk };
}
