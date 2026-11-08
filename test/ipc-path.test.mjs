import test from 'node:test';
import assert from 'node:assert/strict';
import { isPathInsideAny, isLocalApiUrl } from '../electron/lib/pure.js';

// 复核「IPC 任意路径」：路径白名单必须按路径段比较，端口校验必须带真实端口。
test('isPathInsideAny 用 path.relative 按段比较，挡住同名前缀与 .. 逃逸', () => {
  const roots = ['E:/tuku/library'];
  assert.equal(isPathInsideAny('E:/tuku/library/a/b.jpg', roots), true);
  assert.equal(isPathInsideAny('E:/tuku/library', roots), true);
  assert.equal(isPathInsideAny('E:/tuku/library-other/a.jpg', roots), false);
  assert.equal(isPathInsideAny('E:/tuku/library/../secret.jpg', roots), false);
  assert.equal(isPathInsideAny('', roots), false);
  assert.equal(isPathInsideAny('E:/tuku/library/a.jpg', []), false);
});

test('isLocalApiUrl 传了端口就必须精确匹配，不能放行本机其它服务', () => {
  assert.equal(isLocalApiUrl('http://127.0.0.1:3001/api/thumb?id=1', 3001), true);
  assert.equal(isLocalApiUrl('http://127.0.0.1:9999/api/thumb', 3001), false);
  assert.equal(isLocalApiUrl('http://localhost:9999/x', 3001), false);
  assert.equal(isLocalApiUrl('http://127.0.0.1:3001.evil.com/x', 3001), false);
  assert.equal(isLocalApiUrl('http://evil.com/x', 3001), false);
  assert.equal(isLocalApiUrl('javascript:alert(1)', 3001), false);
  // 没传端口时保持旧行为（只校验协议 + 主机名）
  assert.equal(isLocalApiUrl('http://127.0.0.1:3001/x'), true);
});
