import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isLocalOrPrivateHost,
  isSafeLiveUrl,
  normalizePauseApps,
  matchForeground,
  shouldPauseLive,
  liveMountBroken,
} from '../electron/lib/pure.js';

const trusted = path.join(process.cwd(), 'test', 'fixtures', 'pages');
const fileUrl = (p) => pathToFileURL(p).href;

test('本机 / 内网主机名识别', () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.2', '192.168.1.9', '172.16.0.1', '172.31.255.1', '169.254.1.1', '::1']) {
    assert.equal(isLocalOrPrivateHost(h), true, h);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '203.0.113.1']) {
    assert.equal(isLocalOrPrivateHost(h), false, h);
  }
});

test('网页壁纸 URL：默认只放公网 http(s)', () => {
  assert.equal(isSafeLiveUrl('https://example.com/wall'), true);
  assert.equal(isSafeLiveUrl('http://example.com:8080/wall'), true);
  for (const u of [
    'http://127.0.0.1:5173/', 'http://192.168.1.5/', 'file:///E:/a.html',
    'ftp://example.com/x', 'javascript:alert(1)', 'not a url',
  ]) {
    assert.equal(isSafeLiveUrl(u), false, u);
  }
});

test('网页壁纸 URL：显式放开后仍按可信目录限制 file://', () => {
  const opts = { allowLocalUrl: true, trustedDir: trusted };
  assert.equal(isSafeLiveUrl('http://127.0.0.1:5173/', opts), true);
  assert.equal(isSafeLiveUrl('http://192.168.1.5/', opts), true);
  assert.equal(isSafeLiveUrl(fileUrl(path.join(trusted, 'a.html')), opts), true);
  assert.equal(isSafeLiveUrl(fileUrl(path.join(trusted, '..', 'evil.html')), opts), false, '父目录逃逸必须拒绝');
  assert.equal(isSafeLiveUrl(fileUrl(path.join(trusted, 'a.html')), { allowLocalUrl: false, trustedDir: trusted }), false);
  assert.equal(isSafeLiveUrl(fileUrl(path.join(trusted, 'a.html')), { allowLocalUrl: true, trustedDir: '' }), false);
  assert.equal(isSafeLiveUrl('file://server/share/a.html', opts), false, 'UNC 路径必须拒绝');
  assert.equal(isSafeLiveUrl('https://example.com/', opts), true);
});

test('暂停 App 列表：归一化、通配、大小写与脏值过滤', () => {
  assert.deepEqual(normalizePauseApps(['C:\\Program Files\\Adobe\\Photoshop.exe', 'msedge*', ' msedge* ']),
    ['photoshop.exe', 'msedge*']);
  assert.deepEqual(normalizePauseApps('chrome.exe，premiere*; notepad.exe'), ['chrome.exe', 'premiere*', 'notepad.exe']);
  assert.deepEqual(normalizePauseApps(['../evil', 'a'.repeat(200)]), []);
  assert.equal(matchForeground('PHOTOSHOP.EXE', ['photoshop.exe']), true);
  assert.equal(matchForeground('msedge.exe', ['msedge*']), true);
  assert.equal(matchForeground('code.exe', ['msedge*']), false);
  assert.equal(matchForeground('', ['chrome.exe']), false);
  assert.equal(matchForeground('chrome.exe', 'C:\\App\\Chrome.exe'), true);
});

test('暂停策略：各规则命中且说明原因，计数器不可用时跳过 GPU', () => {
  const cfg = {
    pauseOnBattery: true, pauseOnFullscreen: true, pauseOnGpu: true,
    gpuThreshold: 80, pauseApps: ['photoshop.exe'],
  };
  assert.deepEqual(shouldPauseLive(cfg, { onBattery: true, gpu: 30, foreground: 'code.exe' }),
    { paused: true, reasons: ['battery'] });
  assert.deepEqual(shouldPauseLive(cfg, { onBattery: false, fullscreen: true, gpu: 95, foreground: 'Photoshop.exe', locked: true }),
    { paused: true, reasons: ['fullscreen', 'gpu', 'locked', 'app'] });
  assert.equal(shouldPauseLive(cfg, { gpu: 85, foreground: 'code.exe' }).reasons.join(','), 'gpu');
  assert.equal(shouldPauseLive(cfg, { gpu: 79, foreground: 'code.exe' }).paused, false);
  assert.equal(shouldPauseLive(cfg, { gpu: -1, foreground: 'code.exe' }).paused, false, '计数器不可用不能误暂停');
  assert.equal(shouldPauseLive({ ...cfg, pauseOnGpu: false }, { gpu: 99 }).paused, false);
  assert.equal(shouldPauseLive(cfg, { gpu: 99, foreground: '' }).reasons.includes('app'), false);
});

test('挂载守护：父窗口失配才需要重挂，探测不到 WorkerW 不下结论', () => {
  assert.equal(liveMountBroken({ parent: 0, workerw: 12345 }), true);
  assert.equal(liveMountBroken({ parent: 999, workerw: 12345 }), true);
  assert.equal(liveMountBroken({ parent: 12345, workerw: 12345 }), false);
  assert.equal(liveMountBroken({ parent: 0, workerw: 0 }), false);
  assert.equal(liveMountBroken(null), false);
});
