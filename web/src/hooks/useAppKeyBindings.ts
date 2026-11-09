import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { desktop } from '../api';
import type { ImageItem, View } from '../types';
import { matchesBinding, useKeymap } from '../lib/keymap';
import type { LightboxState } from './useLightbox';

type Toast = (msg: string, kind?: 'info' | 'error') => void;

/**
 * 全局快捷键（可在设置里改键位）：命令面板 / 筛选器 / 新建窗口 / 帮助 / 搜索 /
 * 空格快速预览 / F 快速分类 / 全选 / 删除 / 撤销。
 *
 * 输入框内一律不拦（避免抢字）；大图与全屏工作台打开时让位给它们自己的快捷键。
 */
export function useAppKeyBindings({
  showToast,
  palette,
  setPalette,
  helpOpen,
  setHelpOpen,
  lb,
  setLb,
  setView,
  items,
  total,
  selected,
  setSelected,
  setQuickClassifyIds,
  bulk,
  openItem,
  selectAllMatching,
  undoEdit,
}: {
  showToast: Toast;
  palette: 'command' | 'filter' | null;
  setPalette: Dispatch<SetStateAction<'command' | 'filter' | null>>;
  helpOpen: boolean;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  lb: LightboxState;
  setLb: Dispatch<SetStateAction<LightboxState>>;
  setView: Dispatch<SetStateAction<View>>;
  items: ImageItem[];
  total: number;
  selected: Set<number>;
  setSelected: Dispatch<SetStateAction<Set<number>>>;
  setQuickClassifyIds: Dispatch<SetStateAction<number[] | null>>;
  bulk: (action: string, tag?: string) => Promise<void>;
  openItem: (item: ImageItem, pool?: ImageItem[], full?: boolean) => void;
  selectAllMatching: () => Promise<void>;
  undoEdit: () => Promise<void>;
}) {
  /* 全局快捷键表：默认值 + 用户在设置里改过的键位（改完立即生效，无需重启） */
  const { keymap } = useKeymap();

  /* 空格快速预览：记住光标底下的卡片（不改动每张卡的监听，鼠标划过即记录） */
  const hoverIdRef = useRef<number | null>(null);
  useEffect(() => {
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-image-id]') as HTMLElement | null;
      hoverIdRef.current = el ? Number(el.dataset.imageId) || null : null;
    };
    document.addEventListener('mouseover', onOver, { passive: true });
    return () => document.removeEventListener('mouseover', onOver);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      // 命令面板：即使在输入框里也要能开（Eagle 的同类入口也是全局的）
      if (matchesBinding(e, keymap.palette)) {
        e.preventDefault();
        setPalette((v) => (v === 'command' ? null : 'command'));
        return;
      }
      // 筛选器搜索：不用翻侧栏，直接搜「类型 / 星级 / 色系 / 文件夹」
      if (matchesBinding(e, keymap.filter)) {
        e.preventDefault();
        setPalette((v) => (v === 'filter' ? null : 'filter'));
        return;
      }
      // 新建窗口：同一图库多开（桌面端才有）
      if (matchesBinding(e, keymap.newWindow)) {
        e.preventDefault();
        if (desktop?.openNewWindow) {
          void desktop.openNewWindow().then((r) => {
            if (!r?.ok) showToast(r?.error || '打开新窗口失败');
          });
        } else {
          showToast('多窗口仅在桌面端可用');
        }
        return;
      }
      if (palette) return; // 面板自己处理 Esc / 方向键 / Enter
      // F1：教程随叫随到，输入框里也照样能开（F1 不会当文字输入）
      if (e.key === 'F1') {
        e.preventDefault();
        setLb(null);
        setView('tutorial');
        return;
      }
      if (!typing && matchesBinding(e, keymap.help)) {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (helpOpen && e.key === 'Escape') {
        e.preventDefault();
        setHelpOpen(false);
        return;
      }
      // 搜索框：Ctrl+F（可自定义），另外保留「/」这个手顺的备用入口
      if (matchesBinding(e, keymap.search) || (e.key === '/' && !mod)) {
        const el = document.querySelector<HTMLInputElement>('input[placeholder*="搜索"]');
        if (el) {
          e.preventDefault();
          el.focus();
          if (matchesBinding(e, keymap.search)) el.select();
        }
        return;
      }
      if (typing) return;
      if (lb) return; // 大图内自己的快捷键优先，别在这里抢
      // 全屏工作台（批量裁切 / 调色台）里按键归它自己：否则 Delete 会把背后的选中项删掉
      if (document.querySelector('.crop-studio, .cr-room')) return;
      // 空格快速预览（Eagle 的手感）：鼠标停在谁身上就预览谁；没悬停时用选中项 / 第一张。
      // 卡片自身聚焦时空格是「勾选」，让位给它，避免一次按键干两件事。
      if (matchesBinding(e, keymap.quickPreview)) {
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest?.('[data-image-id]')) return;
        const id = hoverIdRef.current;
        const target =
          (id != null ? items.find((it) => it.id === id) : undefined) ||
          (selected.size ? items.find((it) => selected.has(it.id)) : undefined) ||
          items[0];
        if (target) {
          e.preventDefault();
          openItem(target, items, true);
          return;
        }
      }
      // F 快速分类：选中一批素材 → 「放进文件夹 + 追加标签」一步到位。
      // 卡片自身聚焦时让位（卡片里的 F 是收藏），避免一次按键干两件事。
      if ((e.key === 'f' || e.key === 'F') && !mod && !e.altKey && !e.shiftKey) {
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest?.('[data-image-id]')) return;
        const fallback = hoverIdRef.current ?? items[0]?.id;
        const ids = selected.size ? [...selected] : fallback ? [fallback] : [];
        if (!ids.length) return;
        e.preventDefault();
        setQuickClassifyIds(ids);
        return;
      }
      if (e.key === 'Escape') {
        if (selected.size) setSelected(new Set());
        return;
      }
      if ((matchesBinding(e, keymap.delete) || e.key === 'Backspace') && selected.size) {
        e.preventDefault();
        void bulk('delete');
        return;
      }
      if (matchesBinding(e, keymap.selectAll) && (items.length || total)) {
        e.preventDefault();
        void selectAllMatching();
        return;
      }
      // 撤销最近一次覆盖写回的编辑（调色台 / 裁切台内部另有自己的撤销）
      if (matchesBinding(e, keymap.undo)) {
        e.preventDefault();
        void undoEdit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    bulk,
    helpOpen,
    items,
    keymap,
    lb,
    openItem,
    palette,
    selectAllMatching,
    selected,
    setHelpOpen,
    setLb,
    setPalette,
    setQuickClassifyIds,
    setSelected,
    setView,
    showToast,
    total,
    undoEdit,
  ]);

  return { hoverIdRef };
}
