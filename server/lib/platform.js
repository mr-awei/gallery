/**
 * 跨平台能力矩阵：一个地方说清「哪些能力在哪些系统可用」。
 *
 * WorkerW 桌面层、每显示器壁纸、GPU 计数器、前台进程名这些都是 Win32 专有，
 * 以前散落在各文件里用 process.platform === 'win32' 硬门禁，Mac/Linux 只会静默什么都不做。
 * 现在统一由这张表驱动：非 Windows 明确降级（静态系统壁纸 + 屏保 + 全部图库功能），
 * 设置页也照着它显示，不让用户以为「开关打开了但没反应」。
 */
export function capabilitiesFor(platform = process.platform) {
  const win = platform === 'win32';
  const mac = platform === 'darwin';
  const linux = platform === 'linux';
  return {
    platform,
    family: win ? 'windows' : mac ? 'macos' : linux ? 'linux' : 'unknown',
    // Win32 专有
    desktopLayer: win, // WorkerW 挂载动态壁纸窗口
    liveWallpaper: win,
    multiMonitorWallpaper: win,
    gpuMeter: win, // Get-Counter \GPU Engine(*)\Utilization Percentage
    foregroundApp: win, // GetForegroundWindow + QueryFullProcessImageName
    windowsTrayToast: win,
    // 三平台都可用（走各自的原生命令 / Electron API）
    staticWallpaper: win || mac || linux,
    screensaver: true, // Electron 全屏窗口，不依赖桌面层
    library: true, // 采集、检索、标签、编辑、导出、开放 API 全平台一致
    openApi: true,
    lan: true,
    plugins: true,
    sync: true,
    workshop: true,
    ocr: true, // 需本机装 tesseract，缺失时页面会提示
    notes: win
      ? ['完整能力：动态壁纸、每显示器壁纸、GPU/前台应用暂停策略、屏保']
      : mac
        ? ['基础版：图库全部能力 + 静态系统壁纸 + 屏保；动态壁纸需要桌面层挂载，暂不支持']
        : ['基础版：图库全部能力 + 静态系统壁纸（GNOME/XFCE/KDE/feh 依次尝试）+ 屏保；动态壁纸暂不支持'],
  };
}

/** 给设置页的一句话摘要 */
export function platformSummary(caps) {
  const c = caps || capabilitiesFor();
  return `${c.family} · ${c.liveWallpaper ? '完整桌面能力' : '基础版（动态壁纸降级为静态壁纸）'} · ${c.notes.join('；')}`;
}
