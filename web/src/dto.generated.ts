/**
 * 由 scripts/gen-dto-types.mjs 生成，请勿手改。
 * 字段清单直接取自 server/library.js 的 toDTO 返回字面量。
 * 作用：DTO 改名/删字段会让 ImageItem 的收窄声明失去对应字段，
 * 新增字段则先以 unknown 出现，必须在前端显式声明类型才能当具体类型用。
 */
export interface ImageDTOShape {
  enhanced?: unknown;
  originalWidth?: unknown;
  originalHeight?: unknown;
  enhanceScale?: unknown;
  id?: unknown;
  title?: unknown;
  source?: unknown;
  keyword?: unknown;
  sourceUrl?: unknown;
  width?: unknown;
  height?: unknown;
  sizeBytes?: unknown;
  mime?: unknown;
  mediaKind?: unknown;
  duration?: unknown;
  coverTs?: unknown;
  trimStart?: unknown;
  trimEnd?: unknown;
  md5?: unknown;
  stackId?: unknown;
  copyCount?: unknown;
  exportCount?: unknown;
  lastUsedAt?: unknown;
  favorite?: unknown;
  viewed?: unknown;
  viewCount?: unknown;
  viewedAt?: unknown;
  rating?: unknown;
  note?: unknown;
  dominant?: unknown;
  palette?: unknown;
  hue?: unknown;
  tags?: unknown;
  createdAt?: unknown;
  takenAt?: unknown;
  editOps?: unknown;
  score?: unknown;
  scoreReason?: unknown;
  orientation?: unknown;
  bucket?: unknown;
  path?: unknown;
  thumbUrl?: unknown;
  previewUrl?: unknown;
  url?: unknown;
  downloadUrl?: unknown;
}
