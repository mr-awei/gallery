// 临时：验证动态壁纸（挂到桌面 WorkerW 层 + /live 渲染页 + 全屏检测）
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Extract LIVE_CS (GemLive class) from desktop.js so the verifier can call
// GemLive.FindWorkerW() to locate the real desktop-layer WorkerW.
const LIVE_CS = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, 'server', 'desktop.js'), 'utf8').match(/const LIVE_CS = `([\s\S]*?)`;/)[1];
  } catch {
    return '';
  }
})();

const PORT = process.argv[2] || '9333';
// 生产模式下服务是随机端口，从日志里解析真实端口（与 PowerShell 验证端口保持一致）
function detectApiPort() {
  for (const f of [path.join(ROOT, 'e.log'), path.join(ROOT, 'srv.log')]) {
    try {
      const log = fs.readFileSync(f, 'utf8');
      const m = log.match(/\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (m) return m[1];
    } catch {}
  }
  return '3001';
}
const API = `http://127.0.0.1:${detectApiPort()}`;
let bad = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) bad++;
};

/** 本地 API 已开启鉴权：优先环境变量，其次项目根/.api-token（开发模式令牌文件） */
const API_TOKEN =
  process.env.GEM_API_TOKEN ||
  (() => {
    try {
      return fs.readFileSync(path.join(ROOT, '.api-token'), 'utf8').trim();
    } catch {
      return '';
    }
  })();

const api = async (method, path, body) => {
  const r = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json().catch(() => ({}));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 动态壁纸窗口挂到 WorkerW 后变成其子窗口，EnumWindows 只列顶层窗口看不到它。
 *  这里枚举所有 WorkerW 的子窗口，找 electron 拥有的那个（即被挂到桌面层的动态壁纸窗口）。 */
async function countWorkerWChildren() {
  const ps1 = `
Add-Type -TypeDefinition @'
using System.Collections.Generic;
${LIVE_CS}
public class WinChecker {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc c, IntPtr l);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out int p);
  static HashSet<long> Pids; static int Count;
  static bool CountCB(IntPtr h, IntPtr l){
    int pid = 0; GetWindowThreadProcessId(h, out pid);
    if (Pids.Contains((long)pid)) Count++;
    return true;
  }
  public static int CountWorkerWChildren(long[] pids){
    Pids = new HashSet<long>(pids); Count = 0;
    IntPtr ww = GemLive.FindWorkerW();
    if (ww != IntPtr.Zero) EnumChildWindows(ww, CountCB, IntPtr.Zero);
    return Count;
  }
}
'@
$pids = (Get-Process electron).Id | ForEach-Object { [long]$_ }
Write-Output ([WinChecker]::CountWorkerWChildren($pids))
`;
  const fs = await import('node:fs');
  const f = path.join(ROOT, 'scripts', 'wincheck.ps1');
  fs.writeFileSync(f, ps1, 'utf8');
  const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${f}"`, { encoding: 'utf8' });
  return parseInt(out.trim(), 10) || 0;
}

(async () => {
  console.log('【动态壁纸】');
  // 1. 启用幻灯片模式（覆盖全库，确保有图）
  const before = await api('GET', '/api/wallpaper/live');
  await api('PUT', '/api/wallpaper/live', {
    enabled: true,
    mode: 'slideshow',
    scope: 'all',
    intervalSec: 8,
    kenBurns: true,
  });
  const after = await api('GET', '/api/wallpaper/live');
  check(after.enabled === true && after.mode === 'slideshow', '配置已保存', `mode=${after.mode}`);

  await sleep(6000); // 等窗口创建 + 挂载

  // 2. /live 渲染页存在且含动态壁纸逻辑
  const page = await fetch(`${API}/live`).then((r) => r.text());
  check(page.includes('window.__live'), '/live 渲染页已就绪');

  // 3. 是否真的把窗口挂到了桌面 WorkerW 层
  const attached = await countWorkerWChildren();
  check(attached >= 1, '动态壁纸窗口已挂到桌面层（WorkerW）', `WorkerW 子窗口数=${attached}`);

  // 4. 全屏检测：当前无全屏游戏时应为 false
  const fsc = await (
    await fetch(`${API}/api/wallpaper/live/fscheck`, {
      headers: API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {},
    })
  ).json().catch(() => ({}));
  console.log(`     全屏应用检测：${JSON.stringify(fsc)}`);

  // 5. 关闭后窗口应从桌面层移除
  await api('PUT', '/api/wallpaper/live', { enabled: false });
  await sleep(4000);
  const detached = await countWorkerWChildren();
  check(detached === 0, '关闭后已从桌面层移除', `WorkerW 子窗口数=${detached}`);

  // 6. 视频模式配置保存（不真挂视频，验证路由）
  await api('PUT', '/api/wallpaper/live', { enabled: true, mode: 'video', videoPath: 'C:\\missing.mp4' });
  await sleep(1500);
  const v = await api('GET', '/api/wallpaper/live');
  check(v.mode === 'video', '可切换到视频模式', `videoPath=${v.videoPath}`);
  await api('PUT', '/api/wallpaper/live', { enabled: false });

  console.log(bad ? `\n❌ ${bad} 项未通过` : '\n✓ 动态壁纸全部通过');
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('验证脚本异常:', e);
  process.exit(2);
});
