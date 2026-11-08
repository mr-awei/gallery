import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilitiesFor } from '../server/lib/platform.js';
import {
  escapeAppleScriptString,
  posixFileExpr,
  setWallpaperScript,
  trashFileScript,
} from '../server/lib/applescript.js';

test('capabilitiesFor: macOS 明确降级而不是静默无效', () => {
  const caps = capabilitiesFor('darwin');
  assert.equal(caps.family, 'macos');
  // 桌面层挂载是 Win32 专有：macOS 必须如实报 false
  assert.equal(caps.desktopLayer, false);
  assert.equal(caps.liveWallpaper, false);
  assert.equal(caps.multiMonitorWallpaper, false);
  assert.equal(caps.gpuMeter, false);
  // 静态壁纸与屏保在 macOS 走 osascript / Electron 全屏窗口，属于可用
  assert.equal(caps.staticWallpaper, true);
  assert.equal(caps.screensaver, true);
  assert.equal(caps.library, true);
  assert.ok(caps.notes.some((n) => n.includes('基础版')));
});

test('capabilitiesFor: Windows 才给完整桌面能力', () => {
  const win = capabilitiesFor('win32');
  assert.equal(win.desktopLayer, true);
  assert.equal(win.liveWallpaper, true);
  assert.equal(win.gpuMeter, true);
  const linux = capabilitiesFor('linux');
  assert.equal(linux.staticWallpaper, true);
  assert.equal(linux.liveWallpaper, false);
});

test('AppleScript 字符串转义: 引号与反斜杠不会破坏脚本', () => {
  assert.equal(escapeAppleScriptString('a"b'), 'a\\"b');
  assert.equal(escapeAppleScriptString('C:\\x'), 'C:\\\\x');
  // 注入尝试只剩字面量：去掉外层引号后，内部不能再出现「未转义的引号」
  const evil = '"/tmp/a" & (do shell script "rm -rf ~") & "';
  const expr = posixFileExpr(evil);
  assert.ok(expr.startsWith('POSIX file "'));
  assert.ok(expr.endsWith('"'));
  const inner = expr.slice('POSIX file "'.length, -1);
  assert.ok(!/(^|[^\\])"/.test(inner), '内部不能有未转义引号');
  assert.ok(inner.includes('\\"'));
});

test('壁纸与废纸篓脚本带上正确路径', () => {
  const p = '/Users/me/My Pictures/wall "1".png';
  assert.ok(setWallpaperScript(p).includes('set desktop picture to POSIX file "'));
  assert.ok(setWallpaperScript(p).includes('wall \\"1\\".png'));
  assert.ok(trashFileScript(p).startsWith('tell application "Finder" to delete POSIX file '));
});
