/**
 * 逐控件的小功能教程（补全「每个小功能至少一条」）。
 * 分类 id 与基础内容相同时会在合并时追加到该分类末尾（tidy / ingest / ai / data）。
 */
import type { TutorialCategory } from './types';
import { UI_TUTORIAL } from './extra-ui';
import { LIGHTBOX_TUTORIAL } from './extra-lightbox';
import { WORKFLOW_TUTORIAL } from './extra-workflow';
import { SETTINGS_TUTORIAL } from './extra-settings';

export const EXTRA_TUTORIAL: TutorialCategory[] = [
  ...UI_TUTORIAL,
  ...LIGHTBOX_TUTORIAL,
  ...WORKFLOW_TUTORIAL,
  ...SETTINGS_TUTORIAL,
];
