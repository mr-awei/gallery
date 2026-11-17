/**
 * 逐控件的小功能教程（补齐「每个小功能至少一条」）。
 * 分类 id 与基础内容相同时会在合并时追加到该分类末尾（tidy / ingest / ai / data）。
 */
import type { TutorialCategory } from './types';
import { uiTutorial } from './extra-ui';
import { lightboxTutorial } from './extra-lightbox';
import { workflowTutorial } from './extra-workflow';
import { settingsTutorial } from './extra-settings';

export function extraTutorial(): TutorialCategory[] {
  return [...uiTutorial(), ...lightboxTutorial(), ...workflowTutorial(), ...settingsTutorial()];
}
