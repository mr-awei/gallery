/**
 * 主题包允许覆盖的 CSS 变量。
 * 必须与 server/lib/theme-pack.js 的 ALLOWED_VARS 完全一致 ——
 * test/theme-pack.test.mjs 会同时导入两份做断言，改一边忘另一边会直接红。
 */
export const ALLOWED_VARS = [
  '--accent', '--accent-2', '--bg', '--bg-soft', '--panel', '--border',
  '--text', '--muted', '--ok', '--warn', '--err', '--radius', '--gradient',
] as const;

export type ThemePackVar = (typeof ALLOWED_VARS)[number];

export interface ThemePackTheme {
  base: 'dark' | 'light';
  variables: Partial<Record<ThemePackVar, string>>;
  fontFamily?: string;
  name?: string;
}
