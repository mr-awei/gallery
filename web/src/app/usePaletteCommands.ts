import { useEffect, useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { desktop } from '../api';
import type { PaletteCommand } from '../components/CommandPalette';
import type { LightboxState } from '../hooks/useLightbox';
import { applyTheme, type Theme } from '../theme';
import type { Filters, View } from '../types';
import type { LoadGallery } from './types';
import i18n from '../i18n';

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
      group: i18n.t('k60233828'),
      hint,
      run: () => {
        setView(v);
        setFolderId(null);
      },
    });
    return [
      go('gallery', i18n.t('k6084bc4b')),
      go('dashboard', i18n.t('k3fa8b34a')),
      go('people', i18n.t('k215ffde6')),
      go('search', i18n.t('k16d27cb3')),
      go('tidy', i18n.t('kc461222f')),
      go('smart', i18n.t('k04ff0a57')),
      go('enhance', i18n.t('kfd5e4c21')),
      go('crawl', i18n.t('ke8bc2616')),
      go('bookmarks', i18n.t('k46779389')),
      go('playlists', i18n.t('k3d7d51f5')),
      go('knowledge', i18n.t('k7e433388')),
      go('settings', i18n.t('ke366ccf1')),
      {
        id: 'act:bookmark',
        label: i18n.t('k2778ded6'),
        group: i18n.t('k2b6bc0f2'),
        run: () => setBookmarkOpen(true),
      },
      ...(desktop?.openNewWindow
        ? [
            {
              id: 'act:new-window',
              label: i18n.t('kededdc48'),
              group: i18n.t('k5e68f591'),
              hint: i18n.t('k7786ddc1'),
              run: () => void desktop?.openNewWindow?.(),
            } satisfies PaletteCommand,
          ]
        : []),
      {
        id: 'act:export-gallery',
        label: i18n.t('k6a1a37bc'),
        group: i18n.t('k2b6bc0f2'),
        run: () => setExportOpen(true),
      },
      {
        id: 'act:select-all',
        label: i18n.t('k07ca2aa1'),
        group: i18n.t('k2b6bc0f2'),
        hint: 'Ctrl+A',
        run: () => void selectAllMatching(),
      },
      {
        id: 'act:clear-filters',
        label: i18n.t('k396f2616'),
        group: i18n.t('k2b6bc0f2'),
        run: () => {
          setFilters(defaultFilters);
          setFolderId(null);
        },
      },
      {
        id: 'act:refresh',
        label: i18n.t('k22b07e82'),
        group: i18n.t('k2b6bc0f2'),
        run: () => {
          void load(1, true);
          void refreshStats();
        },
      },
      {
        id: 'ui:theme',
        label: theme === 'dark' ? i18n.t('kff4fce81') : i18n.t('kc7163389'),
        group: i18n.t('k785abc97'),
        run: () => {
          const next: Theme = theme === 'dark' ? 'light' : 'dark';
          setTheme(next);
          applyTheme(next);
        },
      },
      {
        id: 'ui:tutorial',
        label: i18n.t('kaec406cf'),
        group: i18n.t('k92e3a830'),
        hint: 'F1',
        run: () => {
          setLb(null);
          setView('tutorial');
        },
      },
      {
        id: 'ui:help',
        label: i18n.t('k053d9261'),
        group: i18n.t('k92e3a830'),
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
