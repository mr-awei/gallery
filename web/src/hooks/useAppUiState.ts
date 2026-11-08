import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastState = { text: string; kind: 'info' | 'error' } | null;

/**
 * App 里与业务数据无关的 UI 状态（提示条、错误条、各类弹窗开关）集中在这里。
 * 让 App 主体只保留图库数据/筛选/选择的 state，也便于这些开关变化时
 * 不牵动整棵组件树的依赖数组 —— 是「App 巨型组件」拆分的第一步。
 */
export function useAppUiState() {
  const [toast, setToast] = useState<ToastState>(null);
  const toastTimer = useRef(0);
  /** 后台请求失败：同一条只显示一次，用户关掉后不再反复弹 */
  const [loadError, setLoadError] = useState('');
  /** 主进程在重启本地服务：遮住界面，别让用户对着必然失败的请求点来点去 */
  const [serviceRestarting, setServiceRestarting] = useState(false);
  const [serviceOffline, setServiceOffline] = useState(false);
  /** dead 态的失败原因：横幅要写清楚，不能只说「服务不可用」 */
  const [serviceError, setServiceError] = useState('');
  const [showCreateLib, setShowCreateLib] = useState(false);
  const [bookmarkOpen, setBookmarkOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // 正在选封面的文件夹 id（null = 没打开）
  const [coverFolderId, setCoverFolderId] = useState<number | null>(null);
  // 顶栏「工具箱」下拉开关（点击菜单外自动收起）
  const [toolsOpen, setToolsOpen] = useState(false);
  // 命令面板：Ctrl+K 搜命令 / Alt+F 搜筛选条件
  const [palette, setPalette] = useState<'command' | 'filter' | null>(null);

  const showToast = useCallback((msg: string, kind: 'info' | 'error' = 'info') => {
    if (!msg) return;
    setToast({ text: msg, kind });
    window.clearTimeout(toastTimer.current);
    // 较长的是可操作报错（如「文件被占用，请关闭看图软件」），给足阅读时间
    const duration = kind === 'error' || msg.length > 40 ? 9000 : 2600;
    toastTimer.current = window.setTimeout(() => setToast(null), duration);
  }, []);

  // 卸载时清掉定时器：避免组件已不在了还 setState
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  return {
    toast,
    showToast,
    loadError,
    setLoadError,
    serviceRestarting,
    setServiceRestarting,
    serviceOffline,
    setServiceOffline,
    serviceError,
    setServiceError,
    showCreateLib,
    setShowCreateLib,
    bookmarkOpen,
    setBookmarkOpen,
    exportOpen,
    setExportOpen,
    coverFolderId,
    setCoverFolderId,
    toolsOpen,
    setToolsOpen,
    palette,
    setPalette,
  };
}
