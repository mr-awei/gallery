import { useCallback, useState } from 'react';
import { api, quiet } from '../api';
import type { Filters, SavedFilter } from '../types';
import { confirmDialog, promptDialog } from '../components/Dialogs';
import i18n from '../i18n';

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
    const name = await promptDialog(i18n.t('k0a1293d4'), '', i18n.t('k340fc085'));
    if (name === null) return;
    if (!name.trim()) return showToast(i18n.t('kdf09fff7'));
    try {
      const r = await api.createSavedFilter(name.trim(), { ...filters, folderId });
      setSavedFilters(r.filters);
      setActiveSavedId(r.id);
      showToast(i18n.t('k49cdc5cd', { p0: name.trim() }));
    } catch (err) {
      showToast((err as Error).message);
    }
  }, [filters, folderId, showToast]);

  const editSavedFilter = useCallback(
    async (f: SavedFilter) => {
      const name = await promptDialog(i18n.t('kb5133207'), f.name, i18n.t('ke4decf94'));
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
      if (!(await confirmDialog(i18n.t('k467039d7', { p0: f.name })))) return;
      try {
        const r = await api.updateSavedFilter(f.id, { query: { ...filters, folderId } });
        setSavedFilters(r.filters);
        setActiveSavedId(f.id);
        showToast(i18n.t('kf90d66ba', { p0: f.name }));
      } catch (err) {
        showToast((err as Error).message, 'error');
      }
    },
    [filters, folderId, showToast]
  );

  const deleteSavedFilter = useCallback(
    async (f: SavedFilter) => {
      if (!(await confirmDialog(i18n.t('k61a52b63', { p0: f.name })))) return;
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
