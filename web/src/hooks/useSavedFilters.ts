import { useCallback, useState } from 'react';
import { api, quiet } from '../api';
import type { Filters, SavedFilter } from '../types';
import { confirmDialog, promptDialog } from '../components/Dialogs';

type Toast = (msg: string, kind?: 'info' | 'error') => void;

/**
 * 保存的筛选器：存 / 改 / 覆盖 / 删 + 列表重载。
 * 每个资源库各存一份（server 侧在各自的 gallery.db 里），所以切库时要调 reload()。
 */
export function useSavedFilters({
  filters,
  folderId,
  showToast,
}: {
  filters: Filters;
  folderId: number | null;
  showToast: Toast;
}) {
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [activeSavedId, setActiveSavedId] = useState<number | null>(null);

  /** 切库 / 建库后重取：筛选器是按库存的，不重载就会显示上一个库的条目 */
  const reload = useCallback(() => {
    api
      .savedFilters()
      .then((r) => setSavedFilters(r.filters))
      .catch(quiet);
  }, []);

  const saveCurrentFilter = useCallback(async () => {
    const name = await promptDialog('保存当前筛选', '', '给这组筛选起个名字（例：4K 风景待修）');
    if (name === null) return;
    if (!name.trim()) return showToast('名称不能为空');
    try {
      const r = await api.createSavedFilter(name.trim(), { ...filters, folderId });
      setSavedFilters(r.filters);
      setActiveSavedId(r.id);
      showToast(`已保存筛选「${name.trim()}」`);
    } catch (err) {
      showToast((err as Error).message);
    }
  }, [filters, folderId, showToast]);

  const editSavedFilter = useCallback(
    async (f: SavedFilter) => {
      const name = await promptDialog('重命名筛选器', f.name, '新名称');
      if (name === null || !name.trim()) return;
      try {
        const r = await api.updateSavedFilter(f.id, { name: name.trim() });
        setSavedFilters(r.filters);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [showToast]
  );

  /** 用当前筛选覆盖已保存的那一条：Eagle 里改完条件顺手存回去，不必删了重存 */
  const overwriteSavedFilter = useCallback(
    async (f: SavedFilter) => {
      if (!(await confirmDialog(`用当前筛选条件覆盖「${f.name}」？原来的条件会被替换。`))) return;
      try {
        const r = await api.updateSavedFilter(f.id, { query: { ...filters, folderId } });
        setSavedFilters(r.filters);
        setActiveSavedId(f.id);
        showToast(`已用当前筛选更新「${f.name}」`);
      } catch (err) {
        showToast((err as Error).message, 'error');
      }
    },
    [filters, folderId, showToast]
  );

  const deleteSavedFilter = useCallback(
    async (f: SavedFilter) => {
      if (!(await confirmDialog(`删除筛选器「${f.name}」？只删这条筛选记录，不会动任何素材。`))) return;
      try {
        const r = await api.deleteSavedFilter(f.id);
        setSavedFilters(r.filters);
        if (activeSavedId === f.id) setActiveSavedId(null);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [activeSavedId, showToast]
  );

  return {
    savedFilters,
    setSavedFilters,
    activeSavedId,
    setActiveSavedId,
    reload,
    saveCurrentFilter,
    editSavedFilter,
    overwriteSavedFilter,
    deleteSavedFilter,
  };
}
