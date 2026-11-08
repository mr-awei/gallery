/**
 * 局域网投送设置接口（跑在只绑 127.0.0.1 的主服务上，仍受 apiAuth 保护）。
 * 真正的手机上传在独立端口的 lan.js 实例里，这里只负责开关、令牌与二维码。
 */
import { getSettings, saveSettings } from '../db.js';
import {
  lanQrcodeSvg,
  lanStatus,
  rotateLanToken,
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
}
