/**
 * 侧栏 / 顶栏的导航常量。
 * 从 App.tsx 移出：这些是纯静态配置（图标 + 文案 + 键），跟应用状态无关，
 * 放在组件文件里只是让本来就大的 App.tsx 更长。
 *
 */
import React from 'react';
import type { View } from '../types';
import {
  IconBrain,
  IconCalendar,
  IconDashboard,
  IconFolder,
  IconGrid,
  IconHeart,
  IconImages,
  IconLayers,
  IconLink,
  IconPin,
  IconSearch,
  IconSpider,
  IconSquare,
  IconUsers,
  IconWand,
} from '../components/Icons';
import i18n from '../i18n';

/** 「待整理」智能视图（Eagle 侧栏固定三项） */
export const PENDING_ITEMS: {
  key: 'inbox' | 'noFolder' | 'noTags' | 'noRating';
  label: string;
  hint: string;
}[] = [
  { key: 'inbox', label: i18n.t('k7c3f1b01'), hint: i18n.t('k7c3f1b02') },
  { key: 'noFolder', label: i18n.t('kecf7ebb5'), hint: i18n.t('k5c223f82') },
    { key: 'noTags', label: i18n.t('k3f9afcd7'), hint: i18n.t('kc65f2452') },
    { key: 'noRating', label: i18n.t('k7be04a8b'), hint: i18n.t('ka4cabfd3') },
  ];

type NavItem = { key: View; label: string; icon: React.ReactNode };

/** 高频入口：常驻侧栏顶部，永远不参与折叠收纳（仪表盘 / 图库是天天要点的） */
export const PRIMARY_NAV: NavItem[] = [
  { key: 'dashboard', label: i18n.t('k3fa8b34a'), icon: <IconDashboard /> },
  { key: 'gallery', label: i18n.t('k6084bc4b'), icon: <IconImages /> },
  { key: 'timeline', label: i18n.t('k4404a8da'), icon: <IconCalendar /> },
  { key: 'canvas', label: i18n.t('k7c3f1a2e'), icon: <IconSquare /> },
];

/** 低频入口：收进可折叠的「更多导航」分区，默认收起 */
export const MORE_NAV: NavItem[] = [
  { key: 'favorites', label: i18n.t('kae336cd0'), icon: <IconHeart /> },
  { key: 'people', label: i18n.t('keec124ab'), icon: <IconUsers /> },
  { key: 'playlists', label: i18n.t('k8d9a495b'), icon: <IconFolder /> },
  { key: 'crawl', label: i18n.t('ke8bc2616'), icon: <IconSpider /> },
  { key: 'bookmarks', label: i18n.t('k46779389'), icon: <IconLink /> },
];

/** 顶栏工具菜单：低频功能收进右上角下拉，侧栏不再常驻 */
export const TOOLS: NavItem[] = [
  { key: 'tidy', label: i18n.t('k1b6c7716'), icon: <IconLayers /> },
  { key: 'search', label: i18n.t('k2c42fc30'), icon: <IconSearch /> },
  { key: 'smart', label: i18n.t('kad540183'), icon: <IconGrid /> },
  { key: 'places', label: i18n.t('kfc1a7d3c'), icon: <IconPin /> },
  { key: 'enhance', label: i18n.t('kfd5e4c21'), icon: <IconWand /> },
  { key: 'knowledge', label: i18n.t('kcbf9f467'), icon: <IconBrain /> },
];

/** 导航文案只用中文；保留一个取词函数，调用点不必逐个改 */
export function navLabel(item: { label: string }): string {
  return item.label;
}
