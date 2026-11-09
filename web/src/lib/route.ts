// URL 路由：刷新 / 后退 / 分享链接都能还原到同一个视图与筛选。
//
// 以前 App 只有一个内部 state 决定「在看哪」，刷新就回到仪表盘、筛选全丢，
// 也没法把「某个标签 + 某个色系」的视图发给别人。这里把最小必要状态写进
// location.search —— 只写非默认值，URL 保持短。
import type { Filters } from '../types';

export const VIEWS = [
  'dashboard',
  'gallery',
  'favorites',
  'people',
  'tidy',
  'playlists',
  'crawl',
  'knowledge',
  'search',
  'smart',
  'enhance',
  'bookmarks',
  'tutorial',
  'settings',
] as const;

export type View = (typeof VIEWS)[number];

export const DEFAULT_FILTERS: Filters = {
  q: '',
  source: [],
  favorite: 'all',
  orientation: 'all',
  bucket: [],
  tag: '',
  sort: 'newest',
  seen: 'all',
  minRating: 0,
  hue: '',
  colorHex: '',
  colorTol: 48,
};

/** 参与 URL 的筛选字段（数组用逗号连接，默认值不写入） */
const FILTER_KEYS = [
  'q',
  'tag',
  'source',
  'favorite',
  'orientation',
  'bucket',
  'sort',
  'seen',
  'minRating',
  'hue',
  'colorHex',
  'colorTol',
  'kind',
  'pending',
] as const;

type FilterKey = (typeof FILTER_KEYS)[number];

export interface RouteState {
  view: View;
  filters: Filters;
  folderId: number | null;
}

const isView = (v: string): v is View => (VIEWS as readonly string[]).includes(v);

function listOf(v: string | null): string[] {
  return v ? v.split(',').filter(Boolean) : [];
}

/** location.search → 状态。非法值一律回落到默认值，坏链接不会把界面卡死 */
export function parseRoute(search: string): RouteState {
  const p = new URLSearchParams(search || '');
  // 没有 v 参数 = 首屏（仪表盘），与历史行为一致
  const view = isView(p.get('v') || '') ? (p.get('v') as View) : 'dashboard';
  const d = DEFAULT_FILTERS;
  const filters: Filters = {
    q: p.get('q') || d.q,
    source: listOf(p.get('source')),
    favorite: (p.get('fav') as Filters['favorite']) || d.favorite,
    orientation: (p.get('ori') as Filters['orientation']) || d.orientation,
    bucket: listOf(p.get('bucket')),
    tag: p.get('tag') || d.tag,
    sort: p.get('sort') || d.sort,
    seen: (p.get('seen') as Filters['seen']) || d.seen,
    minRating: Number(p.get('minRating')) || 0,
    hue: p.get('hue') || '',
    colorHex: p.get('colorHex') || '',
    colorTol: Number(p.get('colorTol')) || d.colorTol,
  };
  const kind = p.get('kind');
  if (kind) filters.kind = kind;
  const pending = p.get('pending');
  if (pending === 'noFolder' || pending === 'noTags' || pending === 'noRating') filters.pending = pending;
  const fid = Number(p.get('folder'));
  return { view, filters, folderId: Number.isFinite(fid) && fid > 0 ? fid : null };
}

/** 状态 → 查询串（不含 '?'）；与默认值相同的字段不写 */
export function buildRoute(view: View, filters: Filters, folderId: number | null): string {
  const p = new URLSearchParams();
  if (view !== 'dashboard') p.set('v', view);
  for (const key of FILTER_KEYS) {
    const cur = filters[key as keyof Filters] as unknown;
    const def = DEFAULT_FILTERS[key as FilterKey] as unknown;
    if (cur === undefined || cur === null) continue;
    if (Array.isArray(cur)) {
      if (!cur.length) continue;
      p.set(key === 'favorite' ? 'fav' : key, cur.join(','));
      continue;
    }
    if (cur === def || cur === '' || cur === 0) continue;
    const param = key === 'favorite' ? 'fav' : key === 'orientation' ? 'ori' : key;
    p.set(param, String(cur));
  }
  if (folderId) p.set('folder', String(folderId));
  return p.toString();
}

/** 两个状态是否等价（用于避免同一个 URL 反复 push） */
export function sameRoute(a: RouteState, b: RouteState): boolean {
  return buildRoute(a.view, a.filters, a.folderId) === buildRoute(b.view, b.filters, b.folderId);
}
