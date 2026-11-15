import { useEffect, useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { desktop } from '../api';
import type { PaletteCommand } from '../components/CommandPalette';
import type { LightboxState } from '../hooks/useLightbox';
import { applyTheme, type Theme } from '../theme';
import type { Filters, View } from '../types';
import type { LoadGallery } from './types';

type Options = {
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
  setView: Dispatch<SetStateAction<View>>;
  setFolderId: Dispatch<SetStateAction<number | null>>;
  setFilters: Dispatch<SetStateAction<Filters>>;
  setBookmarkOpen: Dispatch<SetStateAction<boolean>>;
  setExportOpen: Dispatch<SetStateAction<boolean>>;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  setPalette: Dispatch<SetStateAction<'command' | 'filter' | null>>;
  setLb: Dispatch<SetStateAction<LightboxState>>;
  selectAllMatching: () => Promise<void>;
  load: LoadGallery;
  refreshStats: () => void;
  defaultFilters: Filters;
};

/**
 * 命令面板的命令表（Ctrl+K）+ 「卡片右键要搜索命令」的事件桥。
 * 只列真正能跑通的入口，不做「点了没反应」的假菜单。
 */
export function usePaletteCommands({
  theme,
  setTheme,
  setView,
  setFolderId,
  setFilters,
  setBookmarkOpen,
  setExportOpen,
  setHelpOpen,
  setPalette,
  setLb,
  selectAllMatching,
  load,
  refreshStats,
  defaultFilters,
}: Options) {
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const go = (v: View, label: string, hint?: string): PaletteCommand => ({
      id: `nav:${v}`,
      label,
      group: '前往',
      hint,
      run: () => {
        setView(v);
        setFolderId(null);
      },
    });
    return [
      go('gallery', '图库'),
      go('dashboard', '仪表盘'),
      go('people', '人物（人脸分组）'),
      go('search', '语义搜索'),
      go('tidy', '整理（重复 / 相似）'),
      go('smart', '智能文件夹'),
      go('enhance', '画质增强'),
      go('crawl', '采集'),
      go('bookmarks', '书签'),
      go('playlists', '播放列表'),
      go('knowledge', '知识库'),
      go('settings', '设置'),
      {
        id: 'act:bookmark',
        label: '新建书签…',
        group: '操作',
        run: () => setBookmarkOpen(true),
      },
      ...(desktop?.openNewWindow
        ? [
            {
              id: 'act:new-window',
              label: '新建窗口',
              group: '窗口',
              hint: '同一图库开第二个窗口，可一边挑选一边整理',
              run: () => void desktop?.openNewWindow?.(),
            } satisfies PaletteCommand,
          ]
        : []),
      {
        id: 'act:export-gallery',
        label: '导出画廊 HTML…',
        group: '操作',
        run: () => setExportOpen(true),
      },
      {
        id: 'act:select-all',
        label: '全选当前筛选结果',
        group: '操作',
        hint: 'Ctrl+A',
        run: () => void selectAllMatching(),
      },
      {
        id: 'act:clear-filters',
        label: '清空全部筛选条件',
        group: '操作',
        run: () => {
          setFilters(defaultFilters);
          setFolderId(null);
        },
      },
      {
        id: 'act:refresh',
        label: '刷新列表与统计',
        group: '操作',
        run: () => {
          void load(1, true);
          void refreshStats();
        },
      },
      {
        id: 'ui:theme',
        label: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
        group: '界面',
        run: () => {
          const next: Theme = theme === 'dark' ? 'light' : 'dark';
          setTheme(next);
          applyTheme(next);
        },
      },
      {
        id: 'ui:tutorial',
        label: '使用教程（按功能查找）',
        group: '帮助',
        hint: 'F1',
        run: () => {
          setLb(null);
          setView('tutorial');
        },
      },
      {
        id: 'ui:help',
        label: '快捷键速查',
        group: '帮助',
        hint: '?',
        run: () => setHelpOpen(true),
      },
    ];
  }, [
    load,
    refreshStats,
    selectAllMatching,
    theme,
    setTheme,
    setView,
    setFolderId,
    setFilters,
    setBookmarkOpen,
    setExportOpen,
    setHelpOpen,
    setLb,
    defaultFilters,
    ]);

  /* 卡片右键「搜索命令…」：菜单在卡片里，命令表在 App 里，用事件把两处接起来 */
  useEffect(() => {
    const onAsk = (e: Event) => {
      const mode = (e as CustomEvent<{ mode?: 'command' | 'filter' }>).detail?.mode;
      setPalette(mode === 'filter' ? 'filter' : 'command');
    };
    window.addEventListener('tuku:palette', onAsk);
    return () => window.removeEventListener('tuku:palette', onAsk);
  }, [setPalette]);

  return { paletteCommands };
}
