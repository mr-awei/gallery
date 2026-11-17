import { useCallback, useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { api } from '../api';
import type { LightboxState } from '../hooks/useLightbox';
import type { ImageItem } from '../types';
import type { LoadGallery, Toast } from './types';
import i18n from '../i18n';

/** 覆盖写回的操作名 → 提示语（撤销/重做共用）；文案要跟语言走，t 由调用点传入 */
function editKindLabel(kind: string): string {
  switch (kind) {
    case 'rotate': return i18n.t('k79b5a656');
    case 'crop': return i18n.t('k096cbe88');
    case 'color': return i18n.t('k9e368d03');
    case 'enhance': return i18n.t('k9a5e2729');
    default: return i18n.t('k95b351c8');
  }
}

type Options = {
  setItems: Dispatch<SetStateAction<ImageItem[]>>;
  setLb: Dispatch<SetStateAction<LightboxState>>;
  load: LoadGallery;
  refreshStats: () => void;
  reloadTags: () => void;
  showToast: Toast;
};

/**
 * 单张素材的「就地替换」与编辑撤销/重做。
 *
 * patchItem 是列表、灯箱、卡片共用的行内更新入口（引用必须稳定，Gallery 是 memo 的）；
 * 撤销栈的 Ctrl+Z / Ctrl+Shift+Z 监听（effect）也在这里，位于 job 事件订阅之后 ——
 * 与拆分前一致。
 */
export function useEditHistory({ setItems, setLb, load, refreshStats, reloadTags, showToast }: Options) {
  const patchItem = useCallback(
    (updated: ImageItem) => {
      setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
      setLb((prev) =>
        prev
          ? {
              items: prev.items.map((it) => (it.id === updated.id ? updated : it)),
              index: prev.index,
            }
          : prev
      );
    },
    [setItems, setLb]
  );

  /** 侧栏标签拖到卡片上：追加这个标签（不清空原有标签） */
  const dropTagOnImage = useCallback(
    async (item: ImageItem, tag: string) => {
      const tagName = String(tag || '').trim();
      if (!tagName) return;
      if ((item.tags || []).includes(tagName)) return showToast(i18n.t('k9c349926', { p0: tagName }));
      try {
        const updated = await api.patch(item.id, { tags: [...(item.tags || []), tagName] });
        patchItem(updated);
        showToast(i18n.t('k95f7f2d8', { p0: item.title, p1: tagName }));
        reloadTags();
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [patchItem, reloadTags, showToast]
  );

  /**
   * 撤销最近一次「覆盖写回」编辑。
   * 裁切/旋转/调色/增强都是原地覆盖，以前误操作只能去 Eagle 备份里捞文件；
   * 现在服务端每次写回前都会留一份备份（edit_history），这里一键还原。
   * 撤销是可逆的：撤掉的这一步进重做栈，反复误操作可以连着退好几步。
   */
  const undoEdit = useCallback(async () => {
    try {
      const st = await api.lastUndo();
      if (!st.canUndo || !st.last) {
        showToast(i18n.t('kd9e078d5'));
        return;
      }
      const res = await api.undo(st.last.imageId);
      if (res.item) patchItem(res.item);
      else load(1, true);
      const label = editKindLabel(res.kind, );
      const more = res.canUndo
        ? i18n.t('kf7f4bea2', { p0: res.canUndo })
        : i18n.t('k1860ab45');
      showToast(i18n.t('k069f0b3f', { p0: label, p1: more, p2: res.canRedo ? i18n.t('ke88e0bf5') : '' }));
      refreshStats();
    } catch (err) {
      showToast(i18n.t('k5b0be54d', { p0: (err as Error).message }));
    }
  }, [load, patchItem, refreshStats, showToast]);

  /** 重做刚撤销的一步（服务端保留 redo 栈，不是「撤销就没了」） */
  const redoEdit = useCallback(async () => {
    try {
      const st = await api.lastUndo();
      if (!st.canRedo) {
        showToast(i18n.t('k8ab7bb6e'));
        return;
      }
      const res = await api.redo();
      if (res.item) patchItem(res.item);
      else load(1, true);
      showToast(i18n.t('k9b963315', { p0: editKindLabel(res.kind, ), p1: res.canRedo ? i18n.t('kcc545933', { p0: res.canRedo }) : '' }));
      refreshStats();
    } catch (err) {
      showToast(i18n.t('k2d7db579', { p0: (err as Error).message }));
    }
  }, [load, patchItem, refreshStats, showToast]);

  /**
   * Ctrl+Z / Ctrl+Shift+Z（Ctrl+Y）走编辑撤销栈。
   * 用冒泡阶段监听：调色台与标注层在弹窗内部 stopPropagation，就不会被这里抢走；
   * 有任何弹窗打开时也不接管，避免在「正在编辑」的上下文里偷偷回滚文件。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (document.querySelector('.modal-card')) return;
      e.preventDefault();
      if (k === 'y' || e.shiftKey) void redoEdit();
      else void undoEdit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [redoEdit, undoEdit]);

  return { patchItem, dropTagOnImage, undoEdit, redoEdit };
}
