import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  RESTART_DELAYS,
  escapeHtml,
  isLocalApiUrl,
  isNewer,
  isPathInsideAny,
  originAllowed,
  restartDelay,
} from '../electron/lib/pure.js';

/* ---------------- 版本比较：决定「要不要提示更新 / 会不会降级」 ---------------- */

test('版本比较：三段数字逐位比较，缺省按 0', () => {
  assert.equal(isNewer('1.2.0', '1.1.9'), true);
  assert.equal(isNewer('1.2.0', '1.2.0'), false);
  assert.equal(isNewer('1.2', '1.1.9'), true);
  assert.equal(isNewer('2.0.0', '10.0.0'), false, '不能按字符串比大小');
  assert.equal(isNewer('1.10.0', '1.9.0'), true);
});

test('版本比较：脏输入不抛错，按 0 处理', () => {
  assert.equal(isNewer('', '0.0.1'), false);
  assert.equal(isNewer('1.0.0', ''), true);
  assert.equal(isNewer('v1.2.3', '1.2.2'), true, '前缀 v 会被 parseInt 吃掉');
  assert.equal(isNewer(undefined, undefined), false);
});

/* ---------------- 路径白名单：ipc 的 open-folder / drag-out / locate 全靠它 ---------------- */

const root = path.resolve('E:/gemvault-storage');

test('路径白名单：根目录本身与子路径放行', () => {
  assert.equal(isPathInsideAny(root, [root]), true, '「打开存储文件夹」传的就是根目录');
  assert.equal(isPathInsideAny(path.join(root, 'a', 'b.jpg'), [root]), true);
});

test('路径白名单：越界、同级前缀、上级目录一律拒绝', () => {
  assert.equal(isPathInsideAny(path.join(root, '..', 'secret.txt'), [root]), false);
  assert.equal(isPathInsideAny(`${root}-evil/x.jpg`, [root]), false, '前缀相同但不是子目录');
  assert.equal(isPathInsideAny('E:/Windows/system32', [root]), false);
  assert.equal(isPathInsideAny('', [root]), false);
  assert.equal(isPathInsideAny(root, []), false, '没有白名单根 = 全部拒绝');
});

test('路径白名单：多个根，命中任一即可', () => {
  const other = path.resolve('E:/another-root');
  assert.equal(isPathInsideAny(path.join(other, 'x.png'), [root, other]), true);
});

/* ---------------- 本机 URL 判定：决定图片/令牌会不会被发到外站 ---------------- */

test('本机 URL：host 必须精确相等，端口必须一致', () => {
  assert.equal(isLocalApiUrl('http://127.0.0.1:3001/api/images', 3001), true);
  assert.equal(isLocalApiUrl('http://localhost:3001/api/images', 3001), true);
  assert.equal(isLocalApiUrl('http://127.0.0.1:3002/api/images', 3001), false);
  assert.equal(isLocalApiUrl('http://127.0.0.1.attacker.example/x', 3001), false);
  assert.equal(isLocalApiUrl('https://example.com/127.0.0.1', 3001), false);
  assert.equal(isLocalApiUrl('file:///etc/passwd', 3001), false);
});

test('本机 URL：未指定端口时只看 host', () => {
  assert.equal(isLocalApiUrl('http://127.0.0.1:9/x', 0), true);
});

/* ---------------- origin 精确比对：导航白名单与 IPC 发送方校验共用 ---------------- */

test('origin 白名单：必须协议+主机+端口全等', () => {
  const origins = new Set(['http://127.0.0.1:3001', 'http://localhost:5173']);
  assert.equal(originAllowed('http://127.0.0.1:3001/api/x', origins), true);
  assert.equal(originAllowed('http://127.0.0.1:3002/api/x', origins), false);
  assert.equal(originAllowed('https://127.0.0.1:3001/api/x', origins), false, '协议不同也算不同源');
  assert.equal(originAllowed('http://127.0.0.1:3001.evil.com/x', origins), false);
  assert.equal(originAllowed('not a url', origins), false);
  assert.equal(originAllowed('http://127.0.0.1:3001/x', ['http://127.0.0.1:3001']), true);
});

/* ---------------- 提示窗 HTML 转义 ---------------- */

test('HTML 转义：五个危险字符全覆盖', () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('1')">&`),
    '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;'
  );
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(null), 'null');
});

/* ---------------- 子进程重启退避策略 ---------------- */

test('重启退避：1/2/3 次分别 500/1500/3000，超出上限仍取最大', () => {
  assert.deepEqual(
    [1, 2, 3].map((n) => restartDelay(n)),
    RESTART_DELAYS
  );
  assert.equal(restartDelay(0), 500);
  assert.equal(restartDelay(99), 3000);
  assert.equal(restartDelay(undefined), 500);
});
