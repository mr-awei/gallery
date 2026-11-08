/**
 * 局域网投送设置接口（跑在只绑 127.0.0.1 的主服务上，仍受 apiAuth 保护）。
 * 真正的手机上传在独立端口的 lan.js 实例里，这里只负责开关、令牌与二维码。
 */
import { getSettings, saveSettings } from '../db.js';
import {
  createShareToken,
  lanQrcodeSvg,
  lanStatus,
  listShareTokens,
  revokeShareTokens,
  rotateLanToken,
  shareUrls,
  startLanServer,
  stopLanServer,
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
      rotateLanToken();
      if (lanStatus().enabled) {
        await stopLanServer();
        await startLanServer();
      }
      res.json(lanStatus());
    })
  );

  app.get('/api/lan/qrcode.svg', (_req, res) => {
    const svg = lanQrcodeSvg();
    if (!svg) return res.status(409).json({ error: '局域网投送未开启或没有可用的局域网 IP' });
    res.set('Cache-Control', 'no-store');
    res.type('image/svg+xml').send(svg);
  });

  // 只读分享链接：给朋友 / 另一台设备看当前库，不能改不能传。
  // 令牌只存内存，重启即失效；链接里的 mode=read 只是让页面一进来就落在「浏览」标签。
  app.post(
    '/api/lan/share',
    asyncRoute(async (req, res) => {
      if (!lanStatus().enabled) return res.status(409).json({ error: '先开启局域网访问，分享链接才有可访问的端口' });
      const minutes = Number(req.body?.minutes) || 60;
      const created = createShareToken(minutes);
      res.json({
        ok: true,
        token: created.token,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(created.expiresAt).toISOString(),
        minutes: created.minutes,
        urls: shareUrls(lanStatus().port, created.token),
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
        urls: shareUrls(port, s.token),
      })),
    });
  });

  app.delete('/api/lan/share', (_req, res) => {
    res.json({ ok: true, revoked: revokeShareTokens() });
  });
}
