/**
 * 侧栏 / 顶栏的导航常量。
 * 从 App.tsx 移出：这些是纯静态配置（图标 + 文案 + 键），跟应用状态无关，
 * 放在组件文件里只是让本来就大的 App.tsx 更长。
 */
import React from 'react';
import type { View } from '../types';
import {
  IconBrain,
  IconDashboard,
  IconFolder,
  IconGrid,
  IconHeart,
  IconImages,
  IconLayers,
  IconLink,
  IconSearch,
  IconSpider,
  IconWand,
} from '../components/Icons';

/** 「待整理」智能视图（Eagle 侧栏固定三项） */
export const PENDING_ITEMS: { key: 'noFolder' | 'noTags' | 'noRating'; label: string; hint: string }[] = [
  { key: 'noFolder', label: '未分类', hint: '还没放进任何文件夹的素材' },
  { key: 'noTags', label: '无标签', hint: '还没打标签的素材' },
  { key: 'noRating', label: '未评分', hint: '还没评星的素材' },
];

/** 侧栏内容导航（Eagle 式：仪表盘 + 高频浏览入口，文件夹树跟随其后） */
export const NAV: { key: View; label: string; icon: React.ReactNode }[] = [
  { key: 'dashboard', label: '仪表盘', icon: <IconDashboard /> },
  { key: 'gallery', label: '图库', icon: <IconImages /> },
  { key: 'favorites', label: '收藏', icon: <IconHeart /> },
  { key: 'playlists', label: '清单', icon: <IconFolder /> },
  { key: 'crawl', label: '采集', icon: <IconSpider /> },
  { key: 'bookmarks', label: '书签', icon: <IconLink /> },
];

/** 顶栏工具菜单：低频功能收进右上角下拉，侧栏不再常驻 */
export const TOOLS: { key: View; label: string; icon: React.ReactNode }[] = [
  { key: 'tidy', label: '整理', icon: <IconLayers /> },
  { key: 'search', label: '智能检索', icon: <IconSearch /> },
  { key: 'smart', label: '标签·智能夹', icon: <IconGrid /> },
  { key: 'enhance', label: '画质增强', icon: <IconWand /> },
  { key: 'knowledge', label: 'AI 知识库', icon: <IconBrain /> },
];
