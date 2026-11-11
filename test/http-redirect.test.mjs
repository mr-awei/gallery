// 出站请求的重定向处理：逐跳校验是防「公网 302 到 127.0.0.1」的唯一闸门。
// 这条链路在 Electron 里走过一次大改（net.fetch 的 manual 模式拿不到 3xx，见 server/http.js），
// 所以用本地服务器把「正常跟随 / 跳数上限 / 内网拒绝」三种行为钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { httpFetch } from '../server/http.js';

/**
 * Node 的 fetch（undici）有一份「坏端口」黑名单（6000、6566、6665-6669、6697、10080…）。
 * listen(0) 在部分机器上会把临时端口开进这个范围（netsh 的 dynamicport 起点被改到 1024 时很常见），
 * 于是测试偶发 `TypeError: fetch failed [cause]: bad port` —— 和被测逻辑毫无关系，只是端口运气不好。
 * 这里撞上就换一个端口重开。
 */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
]);

async function withServer(routes, fn) {
  let server;
  for (let attempt = 0; ; attempt++) {
    server = http.createServer((req, res) => {
      const handler = routes[req.url];
      if (!handler) {
        res.writeHead(404).end('nope');
        return;
      }
      handler(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    if (!BAD_PORTS.has(/** @type {any} */ (server.address()).port) || attempt > 8) break;
    await new Promise((resolve) => server.close(resolve));
  }
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
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
