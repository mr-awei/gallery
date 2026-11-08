import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setWallpaperScript, trashFileScript } from './lib/applescript.js';

const execFileAsync = promisify(execFile);

export const platform = os.platform();

/** 桌面端（Electron）下可用原生能力 */
let shellPromise = null;
async function electronShell() {
  // 纯 Node 环境（网页模式 / 冒烟 / CI）没有 electron 运行时，import 会去下载 100MB+ 的二进制
  if (!process.versions.electron) return null;
  if (!shellPromise) {
    shellPromise = import('electron')
      .then((m) => (m && m.shell && typeof m.shell.trashItem === 'function' ? m.shell : null))
      .catch(() => null);
  }
  return shellPromise;
}

/** 执行一段 PowerShell 脚本（写入 UTF-8 BOM 临时文件，避免中文路径编码问题） */
async function runPowerShell(body) {
  const tmp = path.join(os.tmpdir(), `tuku_ps_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(tmp, '﻿' + body, 'utf8');
  try {
    await execFileAsync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      tmp,
    ], { windowsHide: true });
  } finally {
    // 清理临时脚本失败（被 PowerShell/杀软短暂占用会抛 EBUSY）不能覆盖真正的错误：
    // 以前 finally 里直接 rmSync，一旦删不掉，用户看到的永远是 EBUSY 而不是脚本的真实报错
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时文件留着就留着，系统会清 */
    }
  }
}

/** 执行 PowerShell 并捕获输出 */
async function runPowerShellCapture(body) {
  const tmp = path.join(os.tmpdir(), `tuku_ps_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(tmp, '﻿' + body, 'utf8');
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      { windowsHide: true, encoding: 'utf8' }
    );
    return String(stdout || '').trim();
  } finally {
    // 清理临时脚本失败（被 PowerShell/杀软短暂占用会抛 EBUSY）不能覆盖真正的错误：
    // 以前 finally 里直接 rmSync，一旦删不掉，用户看到的永远是 EBUSY 而不是脚本的真实报错
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时文件留着就留着，系统会清 */
    }
  }
}

/* --------------------------- C# 互操作预编译缓存 --------------------------- */
/* 每次 runPowerShell 都是一个全新 PowerShell 进程，脚本里的
 * `if (-not ('X' -as [type]))` 守卫只对「同一次调用内多次使用」有效——
 * 进程一退出编译好的程序集就没了，下一次调用仍要 csc 全量编译（冷启动 300ms+，
 * 自动换壁纸调度器每 30s 触发一次，开销可观）。
 * 这里把 C# 源码预编译成 DLL 缓存到 userData/cache/cs（内容哈希命名），
 * 后续调用只做 Add-Type -Path 纯加载，不再编译。 */
let csCacheDirReady = null;
function csCacheDir() {
  if (!csCacheDirReady) {
    csCacheDirReady = (async () => {
      let dir = '';
      if (process.versions.electron) {
        try {
          // 服务通常内嵌在 Electron 主进程里：缓存放 userData，随应用数据一起管理
          const { app } = await import('electron');
          if (app?.getPath) dir = path.join(app.getPath('userData'), 'cache', 'cs');
        } catch {
          /* 取不到 app 时退回系统临时目录 */
        }
      }
      if (!dir) dir = path.join(os.tmpdir(), 'tuku-cache', 'cs');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    })();
  }
  return csCacheDirReady;
}

const csDllJobs = new Map();
/** 确保一段 C# 源码已编译成缓存 DLL，返回 DLL 绝对路径（并发调用共享同一次编译） */
async function ensureCsDll(csSource) {
  const key = crypto.createHash('sha256').update(csSource).digest('hex').slice(0, 24);
  const dir = await csCacheDir();
  const dll = path.join(dir, `${key}.dll`);
  if (fs.existsSync(dll)) return dll;
  if (!csDllJobs.has(key)) {
    const task = (async () => {
      const tmp = `${dll}.${process.pid}.tmp`;
      const esc = (s) => s.replace(/'/g, "''");
      await runPowerShell(
        `$ErrorActionPreference='Stop'\n` +
          `Add-Type -TypeDefinition @'\n${csSource}\n'@ -OutputAssembly '${esc(tmp)}' -OutputType Library\n`
      );
      try {
        fs.renameSync(tmp, dll); // rename 原子性保证不会出现写一半的 DLL
      } catch {
        fs.rmSync(tmp, { force: true }); // 并发竞争：别的进程已抢先写入
      }
      if (!fs.existsSync(dll)) throw new Error('C# 预编译缓存 DLL 写入失败');
      return dll;
    })().finally(() => csDllJobs.delete(key));
    csDllJobs.set(key, task);
  }
  return csDllJobs.get(key);
}

/* ------------------------------ 多显示器支持 ------------------------------ */

/**
 * Windows 的 IDesktopWallpaper COM 接口：能给每个显示器单独设壁纸，
 * 也能指定排布方式（居中/平铺/拉伸/适应/填充/跨屏），比改注册表更可靠。
 * C# 互操作代码内联，PowerShell 里只调用两个静态方法。
 */
const DW_CS = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left, Top, Right, Bottom; }

[ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDesktopWallpaper {
  [PreserveSig] int SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
  [PreserveSig] int GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] out string wallpaper);
  [PreserveSig] int GetMonitorDevicePathAt(uint monitorIndex, [MarshalAs(UnmanagedType.LPWStr)] out string monitorID);
  [PreserveSig] int GetMonitorDevicePathCount(out uint count);
  [PreserveSig] int GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID, out RECT displayRect);
  [PreserveSig] int SetBackgroundColor(uint color);
  [PreserveSig] int GetBackgroundColor(out uint color);
  [PreserveSig] int SetPosition(int position);
  [PreserveSig] int GetPosition(out int position);
}

public static class TukuDesktop {
  static IDesktopWallpaper W() {
    return (IDesktopWallpaper)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD")));
  }
  /** 每行：id|left|top|width|height */
  public static string[] Monitors() {
    var w = W();
    uint n = 0;
    w.GetMonitorDevicePathCount(out n);
    var list = new List<string>();
    for (uint i = 0; i < n; i++) {
      string id;
      w.GetMonitorDevicePathAt(i, out id);
      RECT rect;
      w.GetMonitorRECT(id, out rect);
      list.Add(id + "|" + rect.Left + "|" + rect.Top + "|" + (rect.Right - rect.Left) + "|" + (rect.Bottom - rect.Top));
    }
    return list.ToArray();
  }
  /** position: 0 居中 / 2 拉伸 / 3 适应 / 4 填充 / 5 跨屏；monitorId 为空表示全部显示器 */
  public static void Set(string monitorId, string path, int position) {
    var w = W();
    w.SetPosition(position);
    w.SetWallpaper(string.IsNullOrEmpty(monitorId) ? null : monitorId, path);
  }
}
`;

/** 列出所有显示器（Windows）。失败返回空数组，调用方回退到单屏逻辑 */
export async function listMonitors() {
  if (platform !== 'win32') return [];
  try {
    const dll = await ensureCsDll(DW_CS);
    const out = await runPowerShellCapture(
      `$ErrorActionPreference='Stop'\n` +
        `if (-not ('TukuDesktop' -as [type])) {\nAdd-Type -Path '${dll.replace(/'/g, "''")}'\n}\n` +
        `[TukuDesktop]::Monitors() | ForEach-Object { Write-Output $_ }\n`
    );
    return String(out || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, x, y, w, h] = line.split('|');
        return { id, x: Number(x) || 0, y: Number(y) || 0, width: Number(w) || 0, height: Number(h) || 0 };
      })
      .filter((m) => m.id && m.width > 0 && m.height > 0);
  } catch (err) {
    console.error('[desktop] 读取显示器失败：', err.message);
    return [];
  }
}

/**
 * 用 COM 接口批量设置壁纸（一次性完成，避免每屏都重新编译 C#）。
 * @param {{monitorId:string, path:string}[]} assignments monitorId 为空串表示全部显示器
 * @param {number} position 0 居中 / 2 拉伸 / 3 适应 / 4 填充 / 5 跨屏
 */
export async function setWallpapersCom(assignments, position = 3) {
  if (platform !== 'win32') throw new Error('仅 Windows 支持每个显示器独立壁纸');
  const job = path.join(os.tmpdir(), `tuku_wp_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(job, JSON.stringify({ position, items: assignments }), 'utf8');
  try {
    const dll = await ensureCsDll(DW_CS);
    await runPowerShell(
      `$ErrorActionPreference='Stop'\n` +
        `if (-not ('TukuDesktop' -as [type])) {\nAdd-Type -Path '${dll.replace(/'/g, "''")}'\n}\n` +
        `$o = ConvertFrom-Json (Get-Content -Raw -Encoding UTF8 '${job}')\n` +
        `foreach ($it in $o.items) { [TukuDesktop]::Set([string]$it.monitorId, [string]$it.path, [int]$o.position) }\n`
    );
  } finally {
    try {
      fs.rmSync(job, { force: true });
    } catch {
      /* 同上：清理失败别盖掉设置壁纸的真实错误 */
    }
  }
}

/* ------------------------------ 动态壁纸支持 ------------------------------ */

/**
 * 把指定窗口挂到桌面图标所在的那一层（WorkerW / Progman）后面，做成真正的动态桌面。
 * 原理与 Lively / Wallpaper Engine 相同：给 Progman 发 0x052C 让系统生成 WorkerW，
 * 再把我们的窗口 SetParent 进去。
 */
const LIVE_CS = `
using System;
using System.Runtime.InteropServices;

public static class TukuLive {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll")] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr child, string cls, string win);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr newParent);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetClassName(IntPtr hWnd, System.Text.StringBuilder name, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, System.Text.StringBuilder name, ref uint size);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  /** 找到桌面图标层背后的那个 WorkerW */
  public static IntPtr FindWorkerW() {
    IntPtr progman = FindWindow("Progman", null);
    IntPtr result;
    // 0x052C：让 Progman 生成 WorkerW
    SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, 0, 1000, out result);
    IntPtr workerw = IntPtr.Zero;
    EnumWindows((top, param) => {
      if (FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) {
        workerw = FindWindowEx(IntPtr.Zero, top, "WorkerW", null);
      }
      return true;
    }, IntPtr.Zero);
    return workerw == IntPtr.Zero ? progman : workerw;
  }

  /** 把窗口挂到桌面层并铺满主屏，成功返回 true */
  public static bool Attach(IntPtr hwnd, int width, int height) {
    if (hwnd == IntPtr.Zero) return false;
    IntPtr workerw = FindWorkerW();
    if (workerw == IntPtr.Zero) return false;
    // 顶层窗口（无 WS_CHILD 样式）经 SetParent 只会被当作「所有者」而非子窗口，
    // GetParent 仍返回 0。必须先切换成 WS_CHILD（去掉标题/边框/弹出等样式），
    // 才能作为 WorkerW 的真正子窗口挂在桌面图标层背后。Lively / Wallpaper Engine 同理。
    int GWL_STYLE = -16;
    int WS_POPUP = unchecked((int)0x80000000u);
    int WS_CAPTION = 0x00C00000;
    int WS_THICKFRAME = 0x00040000;
    int WS_SYSMENU = 0x00080000;
    int WS_MAXIMIZEBOX = 0x00010000;
    int WS_MINIMIZEBOX = 0x00020000;
    int clear = WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MAXIMIZEBOX | WS_MINIMIZEBOX;
    int style = GetWindowLong(hwnd, GWL_STYLE);
    style = style & ~clear; // 清掉弹出/标题/边框/系统菜单等顶层窗口样式
    style |= 0x40000000;    // WS_CHILD
    SetWindowLong(hwnd, GWL_STYLE, style);
    SetParent(hwnd, workerw);
    // SWP_NOSENDCHANGING(0x0400)：抑制 WM_WINDOWPOSCHANGING，否则 Chromium 的窗口过程会
    // 在该消息里把父窗口/样式重新认领回顶层窗口，导致刚挂上的 WorkerW 父级被还原。
    SetWindowPos(hwnd, IntPtr.Zero, 0, 0, width, height, 0x0470 /* SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_NOSENDCHANGING */);
    return GetParent(hwnd) == workerw;
  }

  /** 解除挂载（恢复成普通窗口） */
  public static bool Detach(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return false;
    SetParent(hwnd, IntPtr.Zero);
    return true;
  }

  /** 当前父窗口句柄（用于校验是否已挂上桌面层） */
  public static long ParentOf(IntPtr hwnd) {
    return hwnd == IntPtr.Zero ? 0 : GetParent(hwnd).ToInt64();
  }

  /**
   * 前台是否有「全屏应用」（排除桌面/Shell 自身），用于性能规则。
   * 与屏幕尺寸比对，可区分「最大化窗口」（留出任务栏）与「真全屏」（盖住任务栏）。
   */
  public static bool FullscreenAppRunning(int screenW, int screenH) {
    IntPtr fg = GetForegroundWindow();
    if (fg == IntPtr.Zero || fg == GetShellWindow() || fg == GetDesktopWindow()) return false;
    var sb = new System.Text.StringBuilder(256);
    GetClassName(fg, sb, sb.Capacity);
    string cls = sb.ToString();
    if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "SHELLDLL_DefView") return false;
    RECT r;
    if (!GetWindowRect(fg, out r)) return false;
    int w = r.Right - r.Left;
    int h = r.Bottom - r.Top;
    if (screenW <= 0 || screenH <= 0) return false;
    return Math.Abs(r.Left) < 4 && Math.Abs(r.Top) < 4 && w >= screenW - 2 && h >= screenH - 2;
  }

  /** 前台窗口所属进程的文件名（小写），用于「指定 App 在前台时暂停」 */
  public static string ForegroundProcessName() {
    try {
      IntPtr fg = GetForegroundWindow();
      if (fg == IntPtr.Zero) return "";
      uint pid;
      GetWindowThreadProcessId(fg, out pid);
      IntPtr proc = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
      if (proc == IntPtr.Zero) return "";
      try {
        var sb = new System.Text.StringBuilder(1024);
        uint size = (uint)sb.Capacity;
        if (!QueryFullProcessImageName(proc, 0, sb, ref size)) return "";
        return System.IO.Path.GetFileName(sb.ToString()).ToLowerInvariant();
      } finally { CloseHandle(proc); }
    } catch { return ""; }
  }

  /** 桌面层 WorkerW 的真实句柄，供持续挂载守护比对父窗口 */
  public static long WorkerWHandle() { return FindWorkerW().ToInt64(); }
}
`;

/** 动态壁纸 C# 组件：确保预编译 DLL 就绪（原「进程级布尔缓存」是无效的——
 * 每次 runPowerShell 都是新进程，编译结果随进程销毁，改走 DLL 缓存） */
async function ensureLiveCom() {
  return ensureCsDll(LIVE_CS);
}

/** 把窗口句柄挂到桌面层。hwndDecimal 为十进制字符串（Electron 端按小端读出的真实句柄值）。 */
export async function attachLiveWindow(hwndHex, width, height) {
  if (platform !== 'win32') throw new Error('动态壁纸目前仅支持 Windows');
  const dll = await ensureLiveCom();
  const hx = String(hwndHex).trim();
  const out = await runPowerShellCapture(
    `if (-not ('TukuLive' -as [type])) {\nAdd-Type -Path '${dll.replace(/'/g, "''")}'\n}\n` +
      `[TukuLive]::Attach([IntPtr]::new([long]::Parse('${hx}')), ${Number(width) || 0}, ${Number(height) || 0})\n`
  );
  return String(out).trim().toLowerCase() === 'true';
}

/** 解除挂载 */
export async function detachLiveWindow(hwndHex) {
  if (platform !== 'win32') return false;
  const dll = await ensureLiveCom();
  const out = await runPowerShellCapture(
    `if (-not ('TukuLive' -as [type])) {\nAdd-Type -Path '${dll.replace(/'/g, "''")}'\n}\n` +
      `[TukuLive]::Detach([IntPtr]::new([long]::Parse('${String(hwndHex).trim()}')))\n`
  );
  return String(out).trim().toLowerCase() === 'true';
}

/** 查询窗口当前父句柄（0 表示没有父窗口，即未挂到桌面层） */
export async function liveWindowParent(hwndHex) {
  if (platform !== 'win32') return 0;
  const dll = await ensureLiveCom();
  const out = await runPowerShellCapture(
    `if (-not ('TukuLive' -as [type])) {\nAdd-Type -Path '${dll.replace(/'/g, "''")}'\n}\n` +
      `[TukuLive]::ParentOf([IntPtr]::new([long]::Parse('${String(hwndHex).trim()}')))\n`
  );
  return Number(String(out).trim()) || 0;
}

/** 前台是否有全屏应用（游戏/播放器），动态壁纸据此暂停 */
export async function isFullscreenAppRunning() {
  if (platform !== 'win32') return false;
  try {
    if (!screenSizeCache) screenSizeCache = await getScreenSize();
    const dll = await ensureLiveCom();
    const out = await runPowerShellCapture(
      `if (-not ('TukuLive' -as [type])) {\nAdd-Type -Path '${dll.replace(/'/g, "''")}'\n}\n` +
        `[TukuLive]::FullscreenAppRunning(${screenSizeCache.width}, ${screenSizeCache.height})\n`
    );
    return String(out).trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}
let screenSizeCache = null;

/**
 * 一次 PowerShell 采样拿齐动态壁纸的性能信号：
 * GPU 占用（最忙引擎的百分比，-1 = 计数器不可用）、前台进程名、
 * 窗口父句柄 / 当前 WorkerW 句柄、是否全屏应用。
 * 合并成一次调用是为了避免 3 秒轮询里连开四个 PowerShell 进程。
 */
export async function livePerfSnapshot(hwndDecimal, screenW, screenH) {
  if (platform !== 'win32') {
    return { supported: false, gpu: -1, foreground: '', parent: 0, workerw: 0, fullscreen: false };
  }
  const dll = await ensureLiveCom();
  const hx = String(hwndDecimal || '0').replace(/\D/g, '') || '0';
  const w = Number(screenW) || 0;
  const h = Number(screenH) || 0;
  const script = `
if (-not ('TukuLive' -as [type])) { Add-Type -Path '${dll.replace(/'/g, "''")}' }
$hwnd = [IntPtr]::new([long]::Parse('${hx}'))
$gpu = -1
try {
  $sample = Get-Counter -Counter '\\GPU Engine(*)\\Utilization Percentage' -MaxSamples 1 -ErrorAction Stop
  $vals = @($sample.CounterSamples | ForEach-Object { $_.CookedValue })
  if ($vals.Count -gt 0) { $gpu = [math]::Round(($vals | Measure-Object -Maximum).Maximum, 1) }
} catch { $gpu = -1 }
[ordered]@{
  gpu = $gpu
  foreground = [TukuLive]::ForegroundProcessName()
  parent = [TukuLive]::ParentOf($hwnd)
  workerw = [TukuLive]::WorkerWHandle()
  fullscreen = [TukuLive]::FullscreenAppRunning(${w}, ${h})
} | ConvertTo-Json -Compress
`;
  try {
    const out = String(await runPowerShellCapture(script)).trim().replace(/^\uFEFF/, '');
    const parsed = JSON.parse(out);
    return { supported: true, ...parsed };
  } catch (err) {
    console.warn('[desktop] 性能采样失败：', err?.message || err);
    return { supported: false, gpu: -1, foreground: '', parent: 0, workerw: 0, fullscreen: false };
  }
}

/** 主显示器分辨率（用于合成壁纸） */
export async function getScreenSize() {
  if (platform === 'win32') {
    try {
      const out = await runPowerShellCapture(
        'Add-Type -AssemblyName System.Windows.Forms\n' +
          '$s = [System.Windows.Forms.Screen]::PrimaryScreen\n' +
          'Write-Output ($s.Bounds.Width.ToString() + "x" + $s.Bounds.Height.ToString())\n'
      );
      const m = out.match(/(\d+)\s*[x×]\s*(\d+)/i);
      if (m && Number(m[1]) > 0 && Number(m[2]) > 0) {
        return { width: Number(m[1]), height: Number(m[2]) };
      }
    } catch {
      /* 忽略，走兜底值 */
    }
  } else if (platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('osascript', [
        '-e',
        'tell application "Finder" to get bounds of window of desktop',
      ]);
      const nums = String(stdout).match(/\d+/g);
      if (nums && nums.length >= 4) {
        return { width: Number(nums[2]), height: Number(nums[3]) };
      }
    } catch {
      /* ignore */
    }
  }
  return { width: 1920, height: 1080 };
}

/** 把文件移到系统回收站（可恢复） */
export async function moveToTrash(p) {
  if (!p) throw new Error('路径为空');

  const shell = await electronShell();
  if (shell) {
    await shell.trashItem(p);
    return true;
  }

  if (platform === 'win32') {
    const escaped = p.replace(/'/g, "''");
    await runPowerShell(
      'Add-Type -AssemblyName Microsoft.VisualBasic\n' +
        `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escaped}', ` +
        "'OnlyErrorDialogs', 'SendToRecycleBin')\n"
    );
    return true;
  }
  if (platform === 'darwin') {
    // 路径里可能有引号/反斜杠：统一走 applescript.js 的转义，别直接拼字符串
    await execFileAsync('osascript', ['-e', trashFileScript(p)]);
    return true;
  }
  await execFileAsync('gio', ['trash', p]);
  return true;
}

export function revealFile(p) {
  if (!p) return;
  if (platform === 'win32') execFile('explorer.exe', ['/select,', p], () => {});
  else if (platform === 'darwin') execFile('open', ['-R', p], () => {});
  else execFile('xdg-open', [path.dirname(p)], () => {});
}

export function openFolder(p) {
  if (!p) return;
  if (platform === 'win32') execFile('explorer.exe', [p], () => {});
  else if (platform === 'darwin') execFile('open', [p], () => {});
  else execFile('xdg-open', [p], () => {});
}

/**
 * 把指定图片设为桌面壁纸
 * Windows：SystemParametersInfo(SPI_SETDESKWALLPAPER)
 */
export async function setWallpaper(p) {
  if (!p) throw new Error('图片路径为空');
  if (platform === 'win32') {
    const escaped = p.replace(/'/g, "''");
    await runPowerShell(
      '$ErrorActionPreference="Stop"\n' +
        // 强制「适合(Fit)」模式：完整显示、永不裁切/拉伸；与已合成好的整屏图片配合万无一失
        'Set-ItemProperty -Path "HKCU:\\Control Panel\\Desktop" -Name "WallpaperStyle" -Value "6" -Force\n' +
        'Set-ItemProperty -Path "HKCU:\\Control Panel\\Desktop" -Name "TileWallpaper" -Value "0" -Force\n' +
        'Add-Type -TypeDefinition @"\n' +
        'using System.Runtime.InteropServices;\n' +
        'public class Wallpaper {\n' +
        '  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]\n' +
        '  public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);\n' +
        '}\n' +
        '"@\n' +
        `[Wallpaper]::SystemParametersInfo(20, 0, '${escaped}', 3)\n`
    );
    return true;
  }
  if (platform === 'darwin') {
    await execFileAsync('osascript', ['-e', setWallpaperScript(p)]);
    return true;
  }
  // Linux 没有统一接口：按桌面环境依次尝试，全失败要说清原因，而不是假装设置成功
  const env = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ':0',
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '',
  };
  const attempts = [
    ['GNOME / Cinnamon', 'gsettings', [
      'set', 'org.gnome.desktop.background', 'picture-uri', `file://${p}`,
    ]],
    ['XFCE', 'xfconf-query', [
      '-c', 'xfce4-desktop', '-p', '/backdrop/screen0/monitor0/image-path', '-s', p,
    ]],
    ['轻量 WM', 'feh', ['--bg-scale', p]],
  ];
  const kdeScript =
    `var allDesktops = desktops(); for (i=0;i<allDesktops.length;i++) {` +
    ` d = allDesktops[i]; d.wallpaperPlugin = 'org.kde.image';` +
    ` d.currentConfigGroup = Array('Wallpaper','org.kde.image','General');` +
    ` d.writeConfig('Image', 'file://${p.replace(/'/g, "\\'")}'); }`;
  for (const qdbus of ['qdbus6', 'qdbus']) {
    attempts.push(['KDE Plasma', qdbus, [
      'org.kde.plasmashell', '/PlasmaShell', 'org.kde.PlasmaShell.evaluateScript', kdeScript,
    ]]);
  }
  const failures = [];
  for (const [name, cmd, args] of attempts) {
    try {
      await execFileAsync(cmd, args, { env, timeout: 8000 });
      return true;
    } catch (err) {
      failures.push(`${name}（${cmd}：${String(err?.message || err).slice(0, 80)}）`);
    }
  }
  throw new Error(`未能识别桌面环境，已尝试：${failures.join('；')}。请手动设置壁纸或安装 feh`);
}
