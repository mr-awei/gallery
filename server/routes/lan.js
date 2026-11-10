// @ts-check
/**
 * 局域网投送设置接口（跑在只绑 127.0.0.1 的主服务上，仍受 apiAuth 保护）。
 * 真正的手机上传在独立端口的 lan.js 实例里，这里只负责开关、令牌与二维码。
 */
import { getSettings, saveSettings } from '../db.js';
import { qrSvg } from '../lib/qr.js';
import {
  createShareToken,
  lanQrcodeSvg,
  lanSelfCheck,
  lanStatus,
  listShareTokens,
  revokeShareTokens,
  revokeShareToken,
  rotateLanToken,
  shareUrls,
  syncLanSetting,
} from '../lib/lan.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get('/api/lan/status', (_req, res) => res.json(lanStatus()));

  app.put(
    '/api/lan/toggle',
    asyncRoute(async (req, res) => {
      const enabled = req.body?.enabled === true;
      saveSettings({ lanAccess: enabled });
      // settingsBus 也会触发一次 sync，syncLanSetting 是幂等的
      await syncLanSetting(getSettings());
      res.json(lanStatus());
    })
  );

  app.post(
    '/api/lan/rotate-token',
    asyncRoute(async (_req, res) => {
      // 不能再 stop/start：那会换端口，让刚生成的二维码立刻指向一个没人监听的端口。
      // LAN app 每次请求都实时读令牌，轮换即刻生效，端口保持不变。
      rotateLanToken();
      res.json(lanStatus());
    })
  );

  app.get('/api/lan/qrcode.svg', (req, res) => {
    const svg = lanQrcodeSvg(String(req.query?.ip || ''));
    if (!svg) return res.status(409).json({ error: '局域网投送未开启或没有可用的局域网 IP' });
    res.set('Cache-Control', 'no-store');
    res.type('image/svg+xml').send(svg);
  });

  // 桌面端自检：逐个本机局域网 IP 试探自己的投送端口，定位「端口没开 / 网卡选错」。
  app.get('/api/lan/selfcheck', asyncRoute(async (_req, res) => res.json(await lanSelfCheck())));

  // 只读分享链接：给朋友 / 另一台设备看当前库，不能改不能传。
  // 令牌只存内存，重启即失效；链接里的 mode=read 只是让页面一进来就落在「浏览」标签。
  // 产品化后支持三种可见范围（整库 / 选中的素材 / 某个文件夹）与按条管理。
  app.post(
    '/api/lan/share',
    asyncRoute(async (req, res) => {
      const status = lanStatus();
      if (!status.enabled) return res.status(409).json({ error: '先开启局域网访问，分享链接才有可访问的端口' });
      const body = req.body || {};
      let created;
      try {
        // 显式白名单：body 里塞 ttlMs 就能造出「永不过期」的链接，不能透传整个 body
        created = createShareToken(Number(body.minutes) || 60, {
          scope: body.scope,
          ids: body.ids,
          folderId: body.folderId,
          title: body.title,
          password: body.password,
          allowDownload: body.allowDownload,
        });
      } catch (err) {
        return res.status(400).json({ error: String(err?.message || err) });
      }
      res.json({
        ok: true,
        token: created.token,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(created.expiresAt).toISOString(),
        minutes: created.minutes,
        scope: created.scope,
        ids: created.ids,
        folderId: created.folderId,
        title: created.title,
        hasPassword: created.hasPassword,
        allowDownload: created.allowDownload,
        urls: shareUrls(status.port, created.token),
      });
    })
  );

  app.get('/api/lan/shares', (_req, res) => {
    const port = lanStatus().port;
    res.json({
      ok: true,
      shares: listShareTokens().map((s) => ({
        token: s.token,
        expiresAt: new Date(s.expiresAt).toISOString(),
        createdAt: new Date(s.createdAt).toISOString(),
        scope: s.scope,
        ids: s.ids,
        folderId: s.folderId,
        title: s.title,
        urls: shareUrls(port, s.token),
      })),
    });
  });

  // 分享链接二维码：?token= 是主接口鉴权令牌，&share= 是被编码的只读分享令牌。
  app.get('/api/lan/share-qrcode.svg', (req, res) => {
    const token = String(req.query?.share || '');
    const known = listShareTokens().some((s) => s.token === token);
    if (!known) return res.status(404).json({ error: '分享链接不存在或已失效' });
    const url = shareUrls(lanStatus().port, token)[0];
    if (!url) return res.status(409).json({ error: '没有可用的局域网 IP' });
    res.set('Cache-Control', 'no-store');
    res.type('image/svg+xml').send(qrSvg(url));
  });

  app.delete('/api/lan/share/:token', (req, res) => {
    const ok = revokeShareToken(String(req.params.token));
    res.json({ ok, revoked: ok ? 1 : 0 });
  });

  app.delete('/api/lan/share', (_req, res) => {
    res.json({ ok: true, revoked: revokeShareTokens() });
  });
}
