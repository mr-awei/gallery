/**
 * 顶栏：品牌 + 工具箱下拉 + 设置 + 明暗切换。
 * 纯展示组件（状态由 App 管），从 App.tsx 拆出以缩小主组件体积。
 */
import type { Ref } from 'react';
import type { View } from '../types';
import {
  IconBook,
  IconChevronDown,
  IconDownload,
  IconGear,
  IconGlobe,
  IconLink,
  IconMoon,
  IconSun,
  IconWand,
} from '../components/Icons';
import { TOOLS, navLabel } from './nav';
import i18n from '../i18n';

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
  /** 生成只读分享链接（手机扫码浏览） */
  onShareLink: () => void;
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
  onShareLink,
}: Props) {
  return (
    <header className="topbar" data-tour="topbar">
      <div className="topbar-brand">
        {/* 与安装包/任务栏同一枚标：白色相片压在品牌渐变上。以前这里是一个「图」字，
            字重和圆角跟图标完全不一样，截图里一眼就看得出「不是一套」 */}
        <div className="logo-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="5" width="16" height="14" rx="2.4" />
            <circle cx="9" cy="10" r="1.4" />
            <path d="m4.4 16.6 4.3-4.3 3 3 2.7-2.7 5.2 5.2" />
          </svg>
        </div>
        <div className="topbar-title">
          <b>{i18n.t('k6084bc4b')}</b>
          <span>{activeLibName}</span>
        </div>
      </div>
      <div className="topbar-actions" ref={toolsRef} data-tour="topbar-actions">
        <div className="tools-wrap">
          <button
            className={`btn ghost sm tools-btn${toolsActive ? ' tools-btn-active' : ''}`}
            onClick={() => onToolsOpen(!toolsOpen)}
            title={i18n.t('k3f625409')}
          >
            <IconWand />
            <span>{i18n.t('k59ddf3cc')}</span>
            <span className="tools-chev">
              <IconChevronDown size={13} />
            </span>
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
                  <span>{navLabel(t)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="icon-btn" onClick={onBookmark} title={i18n.t('kdc09b8c4')}>
          <IconLink />
        </button>
        <button className="icon-btn" onClick={onShareLink} title={i18n.t('kb03671ff')}>
          <IconGlobe />
        </button>
        <button className="icon-btn" onClick={onExportGallery} title={i18n.t('kf2d11f17')}>
          <IconDownload />
        </button>
        <button
          className={`icon-btn${view === 'tutorial' ? ' icon-btn-active' : ''}`}
          onClick={() => onView('tutorial')}
          title={i18n.t('k86e19b14')}
          data-tour="tutorial-btn"
        >
          <IconBook />
        </button>
        <button
          className={`icon-btn${view === 'settings' ? ' icon-btn-active' : ''}`}
          onClick={() => onView('settings')}
          title={i18n.t('ke366ccf1')}
          data-tour="settings-btn"
        >
          <IconGear />
        </button>
        <button
          className="icon-btn"
          onClick={onToggleTheme}
          title={theme === 'dark' ? i18n.t('kecffeb15') : i18n.t('k3abec43f')}
        >
          {theme === 'dark' ? <IconSun /> : <IconMoon />}
        </button>
      </div>
    </header>
  );
}
