// 出站请求的重定向处理：逐跳校验是防「公网 302 到 127.0.0.1」的唯一闸门。
// 这条链路在 Electron 里走过一次大改（net.fetch 的 manual 模式拿不到 3xx，见 server/http.js），
// 所以用本地服务器把「正常跟随 / 跳数上限 / 内网拒绝」三种行为钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { httpFetch } from '../server/http.js';

async function withServer(routes, fn) {
  const server = http.createServer((req, res) => {
    const handler = routes[req.url];
    if (!handler) {
      res.writeHead(404).end('nope');
      return;
    }
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const redirect = (to, status = 302) => (_req, res) => {
  res.writeHead(status, { location: to }).end();
};

test('多跳重定向能跟到终点', async () => {
  const seen = [];
  await withServer(
    {
      '/a': (req, res) => {
        seen.push('/a');
        redirect('/b', 307)(req, res);
      },
      '/b': (req, res) => {
        seen.push('/b');
        redirect('/c')(req, res);
      },
      '/c': (_req, res) => {
        seen.push('/c');
        res.writeHead(200, { 'content-type': 'text/plain' }).end('done');
      },
    },
    async (base) => {
      const res = await httpFetch(`${base}/a`, {}, { allowPrivate: true });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'done');
      assert.deepEqual(seen, ['/a', '/b', '/c']);
    },
  );
});

test('超过跳数上限直接中止，不会无限跟', async () => {
  await withServer(
    {
      '/loop': (_req, res) => redirect('/loop')(_req, res),
    },
    async (base) => {
      await assert.rejects(
        () => httpFetch(`${base}/loop`, {}, { allowPrivate: true, maxRedirects: 2 }),
        /重定向次数过多/,
      );
    },
  );
});

test('默认拒绝本机地址（allowPrivate 才放行）', async () => {
  await withServer(
    { '/c': (_req, res) => res.writeHead(200).end('x') },
    async (base) => {
      await assert.rejects(() => httpFetch(`${base}/c`), /不允许访问本机或内网地址/);
    },
  );
});

test('不带重定向的响应原样返回，不额外发请求', async () => {
  let hits = 0;
  await withServer(
    {
      '/plain': (_req, res) => {
        hits += 1;
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      },
    },
    async (base) => {
      const res = await httpFetch(`${base}/plain`, {}, { allowPrivate: true });
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(hits, 1);
    },
  );
});
