import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_VARS,
  PACK_KIND,
  PACK_VERSION,
  buildThemePack,
  parseThemePack,
  pickWallpaperSettings,
  settingsPatchOf,
  safeCssValue,
} from '../server/lib/theme-pack.js';
import { ALLOWED_VARS as WEB_VARS } from '../web/src/lib/theme-pack-vars.ts';

test('前后端主题变量白名单必须一致', () => {
  assert.deepEqual([...WEB_VARS], ALLOWED_VARS);
});

test('CSS 值：只收颜色 / 长度 / 渐变，注入写法一律拒绝', () => {
  assert.equal(safeCssValue('--accent', '#a1b2c3'), '#a1b2c3');
  assert.equal(safeCssValue('--radius', '12px'), '12px');
  assert.equal(safeCssValue('--gradient', 'linear-gradient(90deg, #fff, #000)'), 'linear-gradient(90deg, #fff, #000)');
  for (const v of [
    'url(https://evil/x)', 'var(--accent)', 'red; background: url(x)',
    '#fff;} body{display:none', 'expression(alert(1))', '<script>', 'a'.repeat(500),
  ]) {
    assert.equal(safeCssValue('--accent', v), null, `本该拒绝：${v.slice(0, 40)}`);
  }
  assert.equal(safeCssValue('--not-allowed', '#fff'), null);
});

test('构建：剔掉不合规字段并在 skipped 里说明', () => {
  const { pack, skipped } = buildThemePack({
    name: '午夜霓虹',
    theme: { base: 'dark', variables: { '--accent': '#ff00aa', '--bg': 'url(x)', '--bogus': '#fff' } },
    settings: {
      wallpaperMode: 'span',
      liveWallpaper: { mode: 'shader', shaderPreset: 'plasma', videoPath: 'C:\\secret.mp4', params: { brightness: 120 } },
      ai: { apiKey: '绝不能带出去' },
    },
    assets: [
      { name: 'a.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      { name: 'b.js', dataUrl: 'data:text/javascript;base64,YWxlcnQoMSk=' },
      { name: '../evil.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    ],
  });
  assert.equal(pack.kind, PACK_KIND);
  assert.equal(pack.version, PACK_VERSION);
  assert.equal(pack.theme.base, 'dark');
  assert.deepEqual(pack.theme.variables, { '--accent': '#ff00aa' });
  assert.equal(pack.settings.wallpaperMode, 'span');
  assert.deepEqual(pack.settings.liveWallpaper, {
    mode: 'shader', shaderPreset: 'plasma', params: { brightness: 120 },
  });
  assert.equal(JSON.stringify(pack).includes('apiKey'), false, '凭据绝不能进包');
  assert.equal(JSON.stringify(pack).includes('secret.mp4'), false, '本地路径绝不能进包');
  assert.equal(pack.assets.length, 1);
  assert.ok(skipped.length >= 4);
});

test('往返：A 机导出的包，B 机导入后配色与壁纸设置都能还原', () => {
  const { pack } = buildThemePack({
    name: '跨机主题',
    theme: { base: 'light', variables: { '--accent': '#123456' }, fontFamily: 'Segoe UI' },
    settings: pickWallpaperSettings({
      wallpaperMode: 'fill',
      liveWallpaper: { mode: 'audio', audioSource: 'mic', params: { speed: 75 }, webUrl: 'http://192.168.1.2/' },
      ai: { apiKey: 'x' },
    }),
    assets: [{ name: 'cover.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
  });
  const text = JSON.stringify(pack);
  const parsed = parseThemePack(text);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.pack.theme.variables['--accent'], '#123456');
  assert.equal(parsed.pack.assets[0].name, 'cover.png');
  const patch = settingsPatchOf(parsed.pack);
  assert.equal(patch.wallpaperMode, 'fill');
  assert.equal(patch.liveWallpaper.mode, 'audio');
  assert.equal(patch.liveWallpaper.params.speed, 75);
  assert.equal(patch.liveWallpaper.webUrl, undefined);
});

test('作者 / 字体：注入写法必须被剔掉，不能进 --ui-font', () => {
  const bad = buildThemePack({
    author: '<img src=x onerror=alert(1)>',
    theme: { base: 'light', variables: {}, fontFamily: 'Segoe UI; } body{display:none' },
  }).pack;
  assert.equal(bad.author, '');
  assert.equal(bad.theme.fontFamily, '');
  const good = buildThemePack({
    author: '设计师小王',
    theme: { base: 'dark', variables: {}, fontFamily: "'Microsoft YaHei', sans-serif" },
  }).pack;
  assert.equal(good.author, '设计师小王');
  assert.match(good.theme.fontFamily, /Microsoft YaHei/);
});

test('壁纸设置：行为参数都进包，本机路径与安全开关一律排除', () => {
  const { pack } = buildThemePack({
    settings: {
      wallpaperFill: 'blur', wallpaperMode: 'span',
      screensaver: { enabled: true, idleMinutes: 3, mode: 'shader', showClock: false },
      autoWallpaper: { enabled: true, minutes: 30, excluded: [1, 2, 3], lastRunAt: 'x', cursor: 9 },
      liveWallpaper: {
        enabled: true, mode: 'shader', params: { brightness: 120 },
        pauseOnGpu: true, gpuThreshold: 70, pauseApps: ['photoshop.exe'],
        clickThrough: false,
        videoPath: 'C:\\secret.mp4', webUrl: 'http://192.168.1.2/',
        audioPath: '/home/me/a.mp3', trustedDir: 'D:\\private', allowLocalUrl: true,
      },
      ai: { apiKey: '绝密' },
    },
  });
  assert.equal(pack.settings.wallpaperFill, 'blur');
  assert.equal(pack.settings.screensaver.idleMinutes, 3);
  assert.equal(pack.settings.autoWallpaper.minutes, 30);
  assert.equal(pack.settings.autoWallpaper.excluded, undefined);
  assert.equal(pack.settings.autoWallpaper.lastRunAt, undefined);
  assert.equal(pack.settings.liveWallpaper.pauseOnGpu, true);
  assert.equal(pack.settings.liveWallpaper.pauseApps[0], 'photoshop.exe');
  for (const k of ['videoPath', 'webUrl', 'audioPath', 'trustedDir', 'allowLocalUrl']) {
    assert.equal(pack.settings.liveWallpaper[k], undefined, k);
  }
  assert.equal(JSON.stringify(pack).includes('绝密'), false);
});

test('导入：拒绝非主题包、未来版本与坏 JSON', () => {
  assert.match(parseThemePack('{oops').error, /不是合法的 JSON/);
  assert.match(parseThemePack({ kind: 'other', version: 1 }).error, /不是图库主题包/);
  assert.match(parseThemePack({ kind: PACK_KIND, version: PACK_VERSION + 1 }).error, /高于当前支持/);
  assert.match(parseThemePack(null).error, /内容为空/);
});
