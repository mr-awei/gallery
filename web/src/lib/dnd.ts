/**
 * 应用内拖拽的 MIME 约定（一处定义，三端共用）。
 *
 * 以前卡片 / 文件夹树 / 标签面板各写一份字符串字面量，改一处漏一处就会出现
 * 「拖到文件夹没反应」这种只在一个方向坏掉的问题。统一收在这里。
 */

/** 卡片：携带被拖动的图片 id（逗号分隔，多选时是整批） */
export const IMAGE_MIME = 'application/x-tuku-image-id';

/** 标签：携带标签名，拖到卡片上 = 给这张图打标签 */
export const TAG_MIME = 'application/x-tuku-tag';

/** 文件夹：携带文件夹 id，用于同父级内拖动排序 */
export const FOLDER_MIME = 'application/x-tuku-folder-id';
