import React from 'react';

/**
 * 统一图标集：单一描边规格（24 视口 / 1.9 描边 / 圆头圆角），
 * 默认 16px 跟随 currentColor。以前按钮里散着 emoji（✕ 🔒 ★ 📷 💧…），
 * 字体的 emoji 在不同机器上换字体、换尺寸、换颜色都不受控，
 * 同一个界面里出现四五种「线宽与圆角」——这就是「基础图标不统一」的来源。
 *
 * 约定：
 * - 需要被读屏念出来的图标传 `title`（同时 role=img），装饰性图标默认 aria-hidden；
 * - `size` 只改像素尺寸，不改描边宽度（描边跟着视口缩放，16 与 20 看起来一致）；
 * - 实心图标（播放/停止/星标）用 `filled`，其余一律描边。
 */
export type IconProps = {
  size?: number;
  className?: string;
  title?: string;
  style?: React.CSSProperties;
};

type BaseProps = IconProps & { filled?: boolean };

function baseProps({ size = 16, className, title, style }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    style,
    role: title ? 'img' : undefined,
    'aria-hidden': title ? undefined : true,
    'aria-label': title,
    focusable: false as const,
  };
}

/** 描边图标：paths 为子元素 */
function strokeIcon(children: React.ReactNode) {
  return function Icon({ size = 16, className, title, style }: IconProps) {
    return (
      <svg {...baseProps({ size, className, title, style })}>
        {title ? <title>{title}</title> : null}
        {children}
      </svg>
    );
  };
}

/** 实心图标：默认填充，`filled=false` 时退回描边（心形/星标用） */
function solidIcon(children: React.ReactNode, outlineOnly = false) {
  return function Icon({ size = 16, className, title, style, filled = true }: BaseProps) {
    const solid = outlineOnly ? false : filled;
    return (
      <svg
        {...baseProps({ size, className, title, style })}
        fill={solid ? 'currentColor' : 'none'}
        stroke={solid ? 'none' : 'currentColor'}
      >
        {title ? <title>{title}</title> : null}
        {children}
      </svg>
    );
  };
}

export const IconHeart = ({ filled, ...rest }: BaseProps) => {
  const Icon = solidIcon(
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21.2l7.7-7.7 1.1-1.1a5.5 5.5 0 0 0 0-7.8z" />
  );
  // 心形默认空心（未收藏）：只剩实心时「收藏/未收藏」就没有对照了
  return <Icon filled={filled ?? false} {...rest} />;
};

/** 人物：一个人头 + 肩线（与 Eagle 的「人物」入口视觉一致） */
export const IconUsers = strokeIcon(
  <>
    <circle cx="10" cy="8" r="3.4" />
    <path d="M3.6 20c.5-3.4 3.2-5.4 6.4-5.4s5.9 2 6.4 5.4" />
    <path d="M17.4 5.6a3 3 0 0 1 0 5.6M19.6 14.9c1.6.7 2.6 2 2.9 3.9" />
  </>
);

/** 时间线：日历（按拍摄时间浏览的前提就是「日期」） */
export const IconCalendar = strokeIcon(
  <>
    <rect x="3" y="5" width="18" height="16" rx="2.4" />
    <path d="M3 10h18M8 3v4M16 3v4" />
    <path d="M7.5 14h3M7.5 17.5h4.5M14 14h2.5" />
  </>
);

export const IconDownload = strokeIcon(
  <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
);

export const IconCopy = strokeIcon(
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </>
);

export const IconExpand = strokeIcon(<path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6" />);

export const IconSearch = strokeIcon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>
);

export const IconTrash = strokeIcon(<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13" />);

export const IconGrid = strokeIcon(
  <>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </>
);

export const IconColumns = strokeIcon(
  <>
    <rect x="3" y="3" width="6" height="18" rx="1.5" />
    <rect x="11" y="3" width="6" height="12" rx="1.5" />
    <rect x="19" y="3" width="2" height="8" rx="1" />
  </>
);

export const IconDashboard = strokeIcon(
  <>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </>
);

export const IconSpider = strokeIcon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 9V3m0 18v-6M9 12H3m18 0h-6M9.9 9.9 5.6 5.6m12.8 12.8-4.3-4.3M14.1 9.9l4.3-4.3M5.6 18.4l4.3-4.3" />
  </>
);

export const IconGear = strokeIcon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </>
);

export const IconClose = strokeIcon(<path d="M18 6 6 18M6 6l12 12" />);
/** 语义别名：关闭按钮统一走 IconClose，别再往按钮里塞 ✕ 字符 */
export const IconX = IconClose;

export const IconPlay = solidIcon(<path d="M8 5.5v13l11-6.5z" />);
export const IconStop = solidIcon(<rect x="6" y="6" width="12" height="12" rx="2" />);

export const IconBrain = strokeIcon(
  <>
    <path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8V15a3 3 0 0 0 3 3h1v-4" />
    <path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8V15a3 3 0 0 1-3 3h-1v-4" />
    <path d="M12 4v14M9 8h6M9 12h6" />
  </>
);

export const IconWallpaper = strokeIcon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 14l4-4 4 4 3-3 7 7" />
    <circle cx="8.5" cy="8.5" r="1.3" />
  </>
);

export const IconFolder = strokeIcon(
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
);

/** 展开态文件夹：多一条翻起的盖，和 IconFolder 同轮廓，视觉不跳 */
export const IconFolderOpen = strokeIcon(
  <>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2" />
    <path d="M3 9h18l-2.2 9.2a2 2 0 0 1-1.9 1.5H5.2a2 2 0 0 1-2-2z" />
  </>
);

export const IconLink = strokeIcon(
  <>
    <path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 4.93" />
    <path d="M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 0 0 7.07 7.07L13 19.07" />
  </>
);

export const IconImages = strokeIcon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </>
);

export const IconRefresh = strokeIcon(<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />);

export const IconRotateCw = strokeIcon(
  <>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </>
);

export const IconRotateCcw = strokeIcon(
  <>
    <path d="M3 12a9 9 0 1 0 2.64-6.36" />
    <path d="M3 3v6h6" />
  </>
);

export const IconSun = strokeIcon(
  <>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
  </>
);

export const IconMoon = strokeIcon(<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />);

export const IconLayers = strokeIcon(
  <>
    <path d="m12 3 9 5-9 5-9-5 9-5z" />
    <path d="m3 13 9 5 9-5" />
  </>
);

export const IconWand = strokeIcon(
  <>
    <path d="M15 4V2m0 20v-2M9 4v2m0 14v2M5 9H3m18 0h-2M5 15H3m18 0h-2" />
    <path d="m12 8 1.5 3.5L17 13l-3.5 1.5L12 18l-1.5-3.5L7 13l3.5-1.5L12 8z" />
  </>
);

export const IconGlobe = strokeIcon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" />
  </>
);

/** 教程/帮助：一本翻开的书 */
export const IconBook = strokeIcon(
  <>
    <path d="M12 6.5C10.5 5.2 8.6 4.5 6 4.5H3.5v13H6c2.6 0 4.5.7 6 2 1.5-1.3 3.4-2 6-2h2.5v-13H18c-2.6 0-4.5.7-6 2z" />
    <path d="M12 6.5v13" />
  </>
);

/** 代码 / 接口：一对尖括号中间一道斜杠 */
export const IconCode = strokeIcon(
  <>
    <path d="m8.6 8.4-4 3.6 4 3.6M15.4 8.4l4 3.6-4 3.6" />
    <path d="m13.4 5.6-2.8 12.8" />
  </>
);

/** 关于：圆圈里一个 i */
export const IconInfo = strokeIcon(
  <>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 11v5.4" />
    <path d="M12 7.8v.1" />
  </>
);

/* ---------- 以下为补齐项：替换界面里原本的 emoji / 字符图标 ---------- */

/** 锁定（库锁、只读） */
export const IconLock = strokeIcon(
  <>
    <rect x="4.5" y="10" width="15" height="10.5" rx="2.4" />
    <path d="M8 10V7.4a4 4 0 0 1 8 0V10" />
  </>
);

/** 解锁（可写、已解锁） */
export const IconUnlock = strokeIcon(
  <>
    <rect x="4.5" y="10" width="15" height="10.5" rx="2.4" />
    <path d="M8 10V7.4a4 4 0 0 1 7.6-1.7" />
  </>
);

/** 警告（缺失文件、待修复项） */
export const IconWarning = strokeIcon(
  <>
    <path d="M10.3 4.3 2.8 17.2A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0z" />
    <path d="M12 9.5v4M12 16.6v.1" />
  </>
);

/** 星标：默认实心，`filled={false}` 为空心 */
export const IconStar = ({ filled = true, ...rest }: BaseProps) => {
  const Icon = solidIcon(
    <path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.9z" />
  );
  return <Icon filled={filled} {...rest} />;
};

/** 打勾（已应用 / 已选中） */
export const IconCheck = strokeIcon(<path d="m4.5 12.6 4.8 4.8L19.5 6.8" />);

/** 剪刀（裁切） */
export const IconScissors = strokeIcon(
  <>
    <circle cx="6.2" cy="6.2" r="2.6" />
    <circle cx="6.2" cy="17.8" r="2.6" />
    <path d="M20 4 8.4 15.6M20 20 8.4 8.4" />
  </>
);

/** 文件（文档类素材） */
export const IconFile = strokeIcon(
  <>
    <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" />
    <path d="M14 3.5v5h5" />
  </>
);

/** 调色板（主题 / 外观） */
export const IconPalette = strokeIcon(
  <>
    <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-.9 2-1.9 0-.9-.7-1.4-.7-2.2 0-1 .8-1.8 1.9-1.8h1.3a4 4 0 0 0 4-4c0-3.9-3.8-7.1-8.5-7.1z" />
    <circle cx="7.8" cy="10.2" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="11.4" cy="7.4" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15.6" cy="8.6" r="1.1" fill="currentColor" stroke="none" />
  </>
);

/** 吸管取色 */
export const IconEyedropper = strokeIcon(
  <>
    <path d="m13.4 6.6 4 4M3.8 20.2l4.4-1 9.9-9.9a2.8 2.8 0 0 0-4-4l-9.9 9.9z" />
    <path d="m14.6 3.6 1.6-1.6a2.4 2.4 0 0 1 3.4 3.4l-1.6 1.6" />
  </>
);

/** 相机（截图 / 采集） */
export const IconCamera = strokeIcon(
  <>
    <path d="M3 8.6a2 2 0 0 1 2-2h2.2l1.4-2h6.8l1.4 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="13" r="3.6" />
  </>
);

/** 标签（tag） */
export const IconTag = strokeIcon(
  <>
    <path d="M20.4 12.6 12.6 20.4a2 2 0 0 1-2.8 0l-6.2-6.2a2 2 0 0 1-.6-1.4V5.4a2 2 0 0 1 2-2h7.4a2 2 0 0 1 1.4.6l6.2 6.2a2 2 0 0 1 0 2.4z" />
    <circle cx="7.8" cy="7.8" r="1.3" />
  </>
);

/** 加号 */
export const IconPlus = strokeIcon(<path d="M12 5v14M5 12h14" />);

/** 减号 */
export const IconMinus = strokeIcon(<path d="M5 12h14" />);

/** 眼睛（预览 / 显隐） */
export const IconEye = strokeIcon(
  <>
    <path d="M2.6 12S6 5.6 12 5.6 21.4 12 21.4 12 18 18.4 12 18.4 2.6 12 2.6 12z" />
    <circle cx="12" cy="12" r="3.1" />
  </>
);

/** 定位图钉（地点） */
export const IconPin = strokeIcon(
  <>
    <path d="M12 21s6.5-6 6.5-11a6.5 6.5 0 1 0-13 0C5.5 15 12 21 12 21z" />
    <circle cx="12" cy="10" r="2.4" />
  </>
);

/** 裁切框（裁切工具） */
export const IconCrop = strokeIcon(
  <>
    <path d="M6.5 2.5v13a2 2 0 0 0 2 2h13" />
    <path d="M2.5 6.5h13a2 2 0 0 1 2 2v13" />
  </>
);

/** 直方图（曝光参考） */
export const IconHistogram = strokeIcon(
  <>
    <path d="M3.5 20.5V9M8 20.5V4.5M12.5 20.5V11M17 20.5V6.5M21.5 20.5v-6" />
  </>
);

/** 幻灯片（自动播放预览） */
export const IconSlideshow = strokeIcon(
  <>
    <rect x="2.8" y="4.5" width="18.4" height="13" rx="2" />
    <path d="M10 8.5v5l4.2-2.5z" />
    <path d="M8 21h8" />
  </>
);

/** 堆叠（同素材多版本叠在一起） */
export const IconStack = strokeIcon(
  <>
    <rect x="3" y="3" width="14" height="14" rx="2.4" />
    <path d="M9 21h10a2 2 0 0 0 2-2V9" />
  </>
);

/** 影片（视频素材） */
export const IconFilm = strokeIcon(
  <>
    <rect x="2.6" y="4" width="18.8" height="16" rx="2.2" />
    <path d="M7 4v16M17 4v16M2.6 12h18.8M2.6 8h4.4M2.6 16h4.4M17 8h4.4M17 16h4.4" />
  </>
);

/** 音符（音频素材） */
export const IconMusic = strokeIcon(
  <>
    <path d="M9 18V5.6l10-2v12.2" />
    <circle cx="6.4" cy="18" r="2.6" />
    <circle cx="16.4" cy="15.8" r="2.6" />
  </>
);

/** 立方体（3D 素材） */
export const IconCube = strokeIcon(
  <>
    <path d="m12 2.8 8.5 4.7v9L12 21.2 3.5 16.5v-9z" />
    <path d="m3.7 7.6 8.3 4.6 8.3-4.6M12 21.2v-9" />
  </>
);

/** 表格（表格/演示类文件） */
export const IconSheet = strokeIcon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9.5h18M3 15h18M9.5 4v16M15 4v16" />
  </>
);

/** 方盒（其它素材） */
export const IconBox = strokeIcon(
  <>
    <path d="M3.5 7.6 12 3l8.5 4.6v8.8L12 21l-8.5-4.6z" />
    <path d="m3.7 7.7 8.3 4.5 8.3-4.5M12 21v-8.8" />
  </>
);

/** 铅笔（编辑 / 重命名） */
export const IconPencil = strokeIcon(
  <>
    <path d="M4 20h4l10.5-10.5a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z" />
    <path d="m14.5 6 3.5 3.5" />
  </>
);

/** 显示器（壁纸预览 / 屏幕相关） */
export const IconMonitor = strokeIcon(
  <>
    <rect x="2.6" y="3.6" width="18.8" height="12.8" rx="2" />
    <path d="M9 20.4h6M12 16.4v4" />
  </>
);

/** 字形 Aa（文字类工具：OCR / 水印文案 / 字体） */
export const IconType = strokeIcon(
  <>
    <path d="M3 6.5h8M7 6.5v11" />
    <path d="M13.4 17.5 17 8.2l3.6 9.3M14.6 14.4h4.8" />
  </>
);

/** 时钟（历史 / 版本） */
export const IconClock = strokeIcon(
  <>
    <circle cx="12" cy="12" r="8.8" />
    <path d="M12 7.2V12l3.4 2" />
  </>
);

/** 橡皮（擦除修复） */
export const IconEraser = strokeIcon(
  <>
    <path d="m6.6 17.4 8-8a2.6 2.6 0 0 1 3.7 0l1.6 1.6a2.6 2.6 0 0 1 0 3.7l-5.6 5.6H7.9z" />
    <path d="M9.4 21h11M4 21h1.2" />
  </>
);

/** 左右箭头（并排对比） */
export const IconCompare = strokeIcon(
  <>
    <path d="M3.4 8.4h5.2M8.6 8.4 6.4 6.1M8.6 8.4 6.4 10.7" />
    <path d="M20.6 15.6h-5.2M15.4 15.6l2.2-2.3M15.4 15.6l2.2 2.3" />
    <rect x="2.4" y="3" width="8.2" height="6.4" rx="1.6" />
    <rect x="13.4" y="14.2" width="8.2" height="6.4" rx="1.6" />
  </>
);

/** 暂停 */
export const IconPause = solidIcon(
  <>
    <rect x="7" y="5" width="3.6" height="14" rx="1.2" />
    <rect x="13.4" y="5" width="3.6" height="14" rx="1.2" />
  </>
);

/** 扳手（工具箱） */
export const IconTool = strokeIcon(
  <path d="M14.2 6.4a4.4 4.4 0 0 0 5.6 5.6L21 10.8a6.4 6.4 0 0 1-7.8-7.8zM13 9l-9 9a2.2 2.2 0 0 0 3 3l9-9" />
);

/** 对话框（评论 / 标注讨论） */
export const IconComment = strokeIcon(
  <path d="M21 11.6a7.9 7.9 0 0 1-8.4 7.9 9 9 0 0 1-3.9-.9L3.4 20.6l1.9-5A8 8 0 0 1 12 3.6a8 8 0 0 1 9 8z" />
);

/** 横向缩略图条 */
export const IconStrip = strokeIcon(
  <>
    <rect x="2.6" y="6" width="18.8" height="12" rx="2" />
    <rect x="5.2" y="8.6" width="4" height="6.4" rx="1" />
    <rect x="10.2" y="8.6" width="4" height="6.4" rx="1" />
    <rect x="15.2" y="8.6" width="3.6" height="6.4" rx="1" />
  </>
);

/** 滑杆（非破坏编辑参数） */
export const IconSliders = strokeIcon(
  <>
    <path d="M4 8.5h16M4 15.5h16" />
    <circle cx="9" cy="8.5" r="2.2" />
    <circle cx="15.4" cy="15.5" r="2.2" />
  </>
);

/** 展开 / 收起箭头 */
export const IconChevronDown = strokeIcon(<path d="m6 9.5 6 6 6-6" />);
export const IconChevronRight = strokeIcon(<path d="m9.5 6 6 6-6 6" />);
export const IconChevronLeft = strokeIcon(<path d="m14.5 6-6 6 6 6" />);
export const IconChevronUp = strokeIcon(<path d="m6 14.5 6-6 6 6" />);

/** 上下箭头（排序 / 上移下移） */
export const IconArrowUp = strokeIcon(<path d="M12 19V5m0 0-6 6m6-6 6 6" />);
export const IconArrowDown = strokeIcon(<path d="M12 5v14m0 0 6-6m-6 6-6-6" />);

/** 斜向箭头（标注箭头 / 外链） */
export const IconArrowUpRight = strokeIcon(<path d="M7 17 17 7M9 7h8v8" />);

/** 画笔 */
export const IconBrush = strokeIcon(
  <>
    <path d="M9.5 14.5 4 20l1-4.5 8.6-8.6a2.4 2.4 0 0 1 3.4 3.4z" />
    <path d="M13.5 4.5 19.5 10.5" />
  </>
);

/** 高亮笔（半透明涂抹） */
export const IconHighlight = strokeIcon(
  <>
    <path d="m8 13 6-8.4 4.4 3.2-6 8.4z" />
    <path d="M8 13 4.6 15.4a1.6 1.6 0 0 0 .5 2.9l4.3.6M13 18.6h7" />
  </>
);

/** 正方形（框选工具） */
export const IconSquare = strokeIcon(<rect x="4" y="4" width="16" height="16" rx="2.4" />);

/** 圆形 */
export const IconCircle = strokeIcon(<circle cx="12" cy="12" r="8.4" />);

/** 闪电（快速 / 批量动作） */
export const IconZap = strokeIcon(<path d="M13.2 2.6 4.6 13.4h6l-1 8L19.4 10h-6z" />);

/** 圆形色块（颜色筛选/色卡） */
export const IconDroplet = strokeIcon(
  <path d="M12 3.2s6 6.2 6 10.5a6 6 0 0 1-12 0C6 9.4 12 3.2 12 3.2z" />
);

/** 更多（三个点，替代界面里的 ⋯ 字符） */
export const IconMore = strokeIcon(
  <>
    <circle cx="5.4" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="18.6" cy="12" r="1.5" fill="currentColor" stroke="none" />
  </>
);
