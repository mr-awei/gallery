/**
 * 侧栏 / 顶栏的导航常量。
 * 从 App.tsx 移出：这些是纯静态配置（图标 + 文案 + 键），跟应用状态无关，
 * 放在组件文件里只是让本来就大的 App.tsx 更长。
 *
 * 文案给出中英两份：导航是「界面骨架」，切英文时这里必须跟着变；
 * 教程与长文档仍只有中文（设置页里写清楚，不假装已完全英文化）。
 */
import React from 'react';
import type { View } from '../types';
import { t } from '../lib/i18n';
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
  IconSearch,
  IconSpider,
  IconUsers,
  IconWand,
} from '../components/Icons';

/** 「待整理」智能视图（Eagle 侧栏固定三项） */
export const PENDING_ITEMS: { key: 'noFolder' | 'noTags' | 'noRating'; label: string; labelEn: string; hint: string }[] =
  [
    { key: 'noFolder', label: '未分类', labelEn: 'Unfiled', hint: '还没放进任何文件夹的素材' },
    { key: 'noTags', label: '无标签', labelEn: 'Untagged', hint: '还没打标签的素材' },
    { key: 'noRating', label: '未评分', labelEn: 'Unrated', hint: '还没评星的素材' },
  ];

type NavItem = { key: View; label: string; labelEn: string; icon: React.ReactNode };

/** 高频入口：常驻侧栏顶部，永远不参与折叠收纳（仪表盘 / 图库是天天要点的） */
export const PRIMARY_NAV: NavItem[] = [
  { key: 'dashboard', label: '仪表盘', labelEn: 'Dashboard', icon: <IconDashboard /> },
  { key: 'gallery', label: '图库', labelEn: 'Library', icon: <IconImages /> },
  { key: 'timeline', label: '时间线', labelEn: 'Timeline', icon: <IconCalendar /> },
];

/** 低频入口：收进可折叠的「更多导航」分区，默认收起 */
export const MORE_NAV: NavItem[] = [
  { key: 'favorites', label: '收藏', labelEn: 'Favorites', icon: <IconHeart /> },
  { key: 'people', label: '人物', labelEn: 'People', icon: <IconUsers /> },
  { key: 'playlists', label: '清单', labelEn: 'Collections', icon: <IconFolder /> },
  { key: 'crawl', label: '采集', labelEn: 'Crawl', icon: <IconSpider /> },
  { key: 'bookmarks', label: '书签', labelEn: 'Bookmarks', icon: <IconLink /> },
];

/** 完整导航顺序（命令面板 / 教程等仍按这个顺序枚举） */
export const NAV: NavItem[] = [...PRIMARY_NAV, ...MORE_NAV];

/** 顶栏工具菜单：低频功能收进右上角下拉，侧栏不再常驻 */
export const TOOLS: NavItem[] = [
  { key: 'tidy', label: '整理', labelEn: 'Tidy', icon: <IconLayers /> },
  { key: 'search', label: '智能检索', labelEn: 'Smart Search', icon: <IconSearch /> },
  { key: 'smart', label: '标签·智能夹', labelEn: 'Tags & Smart', icon: <IconGrid /> },
  { key: 'enhance', label: '画质增强', labelEn: 'Enhance', icon: <IconWand /> },
  { key: 'knowledge', label: 'AI 知识库', labelEn: 'AI Knowledge', icon: <IconBrain /> },
];

/** 按当前语言取导航文案（组件里直接调，切语言时由 useLang 触发重渲染） */
export function navLabel(item: { label: string; labelEn: string }): string {
  return t(item.label, item.labelEn);
}
