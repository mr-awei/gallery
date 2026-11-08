/** 教程内容的数据结构。内容按主题拆在 tutorial-content.ts 与 tutorial/extra-*.ts。 */

export interface TutorialShortcut {
  keys: string;
  desc: string;
}

export interface TutorialSection {
  id: string;
  title: string;
  /** 搜索结果里显示的一句话摘要 */
  summary: string;
  keywords: string[];
  body: string;
  shortcuts?: TutorialShortcut[];
}

export interface TutorialCategory {
  id: string;
  title: string;
  sections: TutorialSection[];
}
