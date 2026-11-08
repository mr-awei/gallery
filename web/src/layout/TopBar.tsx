/**
 * 顶栏：品牌 + 工具箱下拉 + 设置 + 明暗切换。
 * 纯展示组件（状态由 App 管），从 App.tsx 拆出以缩小主组件体积。
 */
import type { Ref } from 'react';
import type { View } from '../types';
import { IconBook, IconDownload, IconGear, IconLink, IconMoon, IconSun, IconWand } from '../components/Icons';
import { TOOLS } from './nav';

interface Props {
  activeLibName: string;
  view: View;
  onView: (v: View) => void;
  toolsOpen: boolean;
  onToolsOpen: (next: boolean) => void;
  toolsRef: Ref<HTMLDivElement>;
  toolsActive: boolean;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  /** 保存网页（URL + 快照），和拖拽/粘贴并列的收集入口 */
  onBookmark: () => void;
  /** 导出为 HTML 网页画廊 */
  onExportGallery: () => void;
}

export default function TopBar({
  activeLibName,
  view,
  onView,
  toolsOpen,
  onToolsOpen,
  toolsRef,
  toolsActive,
  theme,
  onToggleTheme,
  onBookmark,
  onExportGallery,
}: Props) {
  return (
    <header className="topbar" data-tour="topbar">
      <div className="topbar-brand">
        <div className="logo-mark">图</div>
        <div className="topbar-title">
          <b>图库</b>
          <span>{activeLibName}</span>
        </div>
      </div>
      <div className="topbar-actions" ref={toolsRef} data-tour="topbar-actions">
        <div className="tools-wrap">
          <button
            className={`btn ghost sm tools-btn${toolsActive ? ' tools-btn-active' : ''}`}
            onClick={() => onToolsOpen(!toolsOpen)}
            title="整理与分析工具"
          >
            <IconWand />
            <span>工具箱</span>
            <span className="tools-chev">▾</span>
          </button>
          {toolsOpen && (
            <div className="tools-menu">
              {TOOLS.map((t) => (
                <button
                  key={t.key}
                  className={`tools-item${view === t.key ? ' active' : ''}`}
                  onClick={() => {
                    onView(t.key);
                    onToolsOpen(false);
                  }}
                >
                  {t.icon}
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="icon-btn" onClick={onBookmark} title="保存网页（URL + 快照）">
          <IconLink />
        </button>
        <button className="icon-btn" onClick={onExportGallery} title="导出为 HTML 网页画廊">
          <IconDownload />
        </button>
        <button
          className={`icon-btn${view === 'tutorial' ? ' icon-btn-active' : ''}`}
          onClick={() => onView('tutorial')}
          title="使用教程（F1）"
          data-tour="tutorial-btn"
        >
          <IconBook />
        </button>
        <button
          className={`icon-btn${view === 'settings' ? ' icon-btn-active' : ''}`}
          onClick={() => onView('settings')}
          title="设置"
          data-tour="settings-btn"
        >
          <IconGear />
        </button>
        <button
          className="icon-btn"
          onClick={onToggleTheme}
          title={theme === 'dark' ? '切换到明亮模式' : '切换到暗色模式'}
        >
          {theme === 'dark' ? <IconSun /> : <IconMoon />}
        </button>
      </div>
    </header>
  );
}
