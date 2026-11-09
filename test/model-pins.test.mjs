import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { KNOWN_SHA256, pinnedSha, isPinned } from '../server/model-fetch.js';
import { validateResult, sanitizeResults } from '../server/sanitize.js';

const pins = JSON.parse(fs.readFileSync(new URL('../server/model-pins.json', import.meta.url), 'utf8'));

test('随包可信哈希清单不再是空的，且条目格式合法', () => {
  assert.ok(Object.keys(pins.models).length > 0, '清单仍为空，等于没有外部校验参照');
  for (const [key, hex] of Object.entries(pins.models)) {
    assert.match(hex, /^[0-9a-f]{64}$/i, `${key} 不是合法 sha256`);
    assert.equal(KNOWN_SHA256[key], hex.toLowerCase());
    assert.ok(isPinned(key));
  }
});

test('下载时传相对 repoPath 也能命中清单（不能被 sidecar 悄悄接管）', () => {
  const [key, hex] = Object.entries(pins.models)[0];
  const short = key.split('/').slice(-2).join('/');
  assert.equal(pinnedSha(key), hex.toLowerCase());
  assert.equal(pinnedSha(short), hex.toLowerCase());
  assert.equal(pinnedSha('onnx/unknown-model.onnx'), '');
});

test('isPinned 与 pinnedSha 口径一致（同一路径不能「取得到哈希却声称未固定」）', () => {
  for (const key of Object.keys(pins.models)) {
    assert.equal(isPinned(key), true, key);
    const short = key.split('/').slice(-2).join('/');
    assert.equal(isPinned(short), !!pinnedSha(short), `${short} 两个接口口径不一致`);
  }
  assert.equal(isPinned('nope/model.onnx'), false);
});

test('去背景 / 超分权重都在清单里（运行前必须能强校验）', () => {
  const matting = Object.keys(pins.models).find((k) => k.includes('U-2-Net-Human-Seg'));
  assert.ok(matting, 'matting 权重未固化哈希，首次被替换无法发现');
  assert.match(pins.models[matting], /^[0-9a-f]{64}$/);

  // 人脸：两个权重缺一个都等于没有强校验（检测模型被换掉同样能伪造结果）
  for (const name of ['det_10g.onnx', 'w600k_r50.onnx']) {
    const key = Object.keys(pins.models).find((k) => k.endsWith(`/buffalo_l/${name}`));
    assert.ok(key, `人脸权重 ${name} 未固化哈希`);
    assert.match(pins.models[key], /^[0-9a-f]{64}$/);
    // 运行时代码用完整仓库路径查表，这里保证两边口径一致
    assert.equal(KNOWN_SHA256[key], pins.models[key].toLowerCase());
  }
  const zips = Object.keys(pins.zips);
  assert.ok(
    zips.some((u) => /realesrgan-ncnn-vulkan/i.test(u)),
    '超分运行库（Real-ESRGAN）未固化哈希'
  );
  assert.ok(
    zips.some((u) => /realcugan-ncnn-vulkan/i.test(u)),
    '超分运行库（Real-CUGAN）未固化哈希'
  );
  for (const [url, hex] of Object.entries(pins.zips)) assert.match(hex, /^[0-9a-f]{64}$/i, `${url} 不是合法 sha256`);
});

test('downloadModelFile：前缀 + repoPath 只拼一次（误传完整 URL 不再产生重复路径）', async () => {
  const http = await import('node:http');
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const { downloadModelFile } = await import('../server/model-fetch.js');

  const seen = [];
  const body = 'fake-onnx-weights-'.repeat(64);
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  /**
   * 不要用 0 让系统随机分配：临时端口偶尔会落到 undici 的禁用端口表里
   * （6000/6667/10080…），fetch 会直接抛 `bad port`，测试就成了偶发红灯。
   * 从固定段里挨个试，既避开禁用表也避开并行测试的占用。
   */
  let port = 0;
  for (const p of [18231, 18232, 18233, 18234, 18235]) {
    try {
      await new Promise((resolve, reject) => {
        const onErr = (err) => reject(err);
        srv.once('error', onErr);
        srv.listen(p, '127.0.0.1', () => {
          srv.off('error', onErr);
          resolve();
        });
      });
      port = p;
      break;
    } catch {
      /* 端口被占，换下一个 */
    }
  }
  assert.ok(port, '找不到可用端口');
  assert.equal(srv.address().port, port);
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tuku-dl-'));
  try {
    // 正常契约：镜像前缀 + repoPath
    const r1 = await downloadModelFile({
      mirrors: [base],
      repoPath: 'models/a.onnx',
      dest: path.join(dir, 'a.onnx'),
      minBytes: 16,
      allowPrivate: true,
    });
    assert.equal(r1.size, Buffer.byteLength(body));

    // 历史 bug 回归：matting/face 曾把整条文件 URL 当前缀传入，
    // 路径被拼成 models/a.onnxmodels/a.onnx，镜像永远 404
    const r2 = await downloadModelFile({
      mirrors: [`${base}models/a.onnx`],
      repoPath: 'models/a.onnx',
      dest: path.join(dir, 'b.onnx'),
      minBytes: 16,
      allowPrivate: true,
    });
    assert.equal(r2.size, Buffer.byteLength(body));
    assert.deepEqual(seen, ['/models/a.onnx', '/models/a.onnx']);
  } finally {
    srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('爬虫 7 源结果走字段级 schema 校验，拒绝项可追溯且不污染返回数组', () => {
  const allowed = new Set(['bing']);
  const good = { url: 'https://example.com/a.jpg', source: 'bing', referer: 'https://example.com/p' };
  assert.equal(validateResult(good, allowed).ok, true);
  for (const bad of [
    { url: 'javascript:alert(1)', source: 'bing' },
    { url: 'https://example.com/a\n.jpg', source: 'bing' },
    { url: 'https://example.com/b.jpg', source: 'evil' },
    { url: 'https://example.com/c.jpg', source: 'bing', extra: { nested: 1 } },
    { url: 'https://example.com/d.jpg', source: 'bing', width: Number.POSITIVE_INFINITY },
    { url: 'https://example.com/e.jpg', source: 'bing', title: 'x'.repeat(3000) },
  ]) {
    assert.equal(validateResult(bad, allowed).ok, false, `应拒绝：${JSON.stringify(bad).slice(0, 80)}`);
  }

  const out = sanitizeResults([good, { url: 'ftp://x/y.jpg', source: 'bing' }, { ...good }], {
    limit: 10,
    sources: ['bing'],
  });
  assert.equal(out.length, 1);
  assert.equal(out.rejected.length, 2);
  assert.deepEqual(Object.keys(out), ['0']);
  assert.equal(JSON.stringify(out).includes('rejected'), false, '拒绝清单必须是非枚举的');
});
