// 壁纸路由：手动/定时切换、动态壁纸、偏好训练与反馈、历史记录（从 app.js 拆出）
import fs from 'node:fs';
import path from 'node:path';
import * as auto from '../auto.js';
import * as fit from '../wallpaper-fit.js';
import * as lib from '../library.js';
import * as matting from '../matting.js';
import * as flatcut from '../lib/flatcut.js';
import * as pref from '../preference.js';
import * as wallpaper from '../wallpaper.js';
import { httpFetch } from '../http.js';
import { isFullscreenAppRunning, listMonitors } from '../desktop.js';
import { liveBus } from '../live-bus.js';
import { LIVE_HTML } from '../live-page.js';
import { db, getSettings, saveSettings } from '../db.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;


  app.get('/api/wallpaper/auto', (_req, res) => res.json(auto.getAutoStatus()));

  app.put(
    '/api/wallpaper/auto',
    asyncRoute(async (req, res) => {
      const current = getSettings().autoWallpaper || {};
      saveSettings({ autoWallpaper: { ...current, ...(req.body || {}) } });
      res.json(auto.getAutoStatus());
    })
  );

  // AI 壁纸闭环：适配度查询 / 批量补算 / 用户反馈（喜欢·不喜欢）
  app.get(
    '/api/wallpaper/fit/:id',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const useAi = String(req.query.ai || '') === '1';
      res.json({ ok: true, fit: await fit.ensureFit(id, { useAi }) });
    })
  );
  app.post(
    '/api/wallpaper/scan-fit',
    asyncRoute(async (req, res) => {
      const limit = Math.max(1, Math.min(500, Number(req.body?.limit) || 120));
      const useAi = req.body?.ai === true;
      res.json({ ok: true, ...(await fit.scanFits(limit, useAi)) });
    })
  );
  app.post(
    '/api/wallpaper/feedback',
    asyncRoute(async (req, res) => {
      const id = Number(req.body?.imageId);
      if (!id) return res.status(400).json({ error: '缺少图片 id' });
      const like = req.body?.like !== false;
      res.json({ ok: true, fit: fit.recordFeedback(id, like) });
    })
  );
  app.post('/api/wallpaper/like', (_req, res) => res.json({ ok: true, ...auto.likeCurrent() }));

  /* 浏览器插件采集：接收图片 URL 列表 / base64 数据，本地下载后入库 */
  app.post(
    '/api/extension/ingest',
    asyncRoute(async (req, res) => {
      const settings = getSettings();
      const keyword = String(req.body?.keyword || '浏览器采集').slice(0, 80);
      const tags = String(req.body?.tags || '').slice(0, 200);
      const pageUrl = String(req.body?.pageUrl || '').slice(0, 500);
      const results = [];
      const urls = Array.isArray(req.body?.urls) ? req.body.urls.slice(0, 30) : [];
      const dataUrls = Array.isArray(req.body?.dataUrls) ? req.body.dataUrls.slice(0, 10) : [];
      // 用户主动拖/点采集：不过 minFileSize / minResolution 门槛（爬虫才需要那两道闸）。
      // 批量采集（右键「采集本页所有图片」）不带这个标记，继续按质量过滤，免得收一屏图标。
      const skipQuality = req.body?.skipQuality === true;

      for (const u of urls) {
        try {
          // 带页面来源下载（很多站点有防盗链），httpFetch 会把 Referer 转成标准 referrer
          const res = await httpFetch(String(u), {
            headers: pageUrl ? { Referer: pageUrl } : {},
            timeout: 25000,
            retries: 2,
          });
          const buffer = Buffer.from(await res.arrayBuffer());
          const r = await lib.ingest(
            { buffer, source: 'browser', keyword, tags, sourceUrl: String(u), copyToStorage: true, skipQuality },
            settings
          );
          results.push({ ...r, url: String(u) });
        } catch (err) {
          results.push({ ok: false, reason: 'failed', url: String(u), error: String(err?.message || err).slice(0, 120) });
        }
      }
      for (const d of dataUrls) {
        try {
          const m = String(d).match(/^data:image\/[a-zA-Z+]+;base64,(.+)$/);
          if (!m) throw new Error('不是图片 data URL');
          const buf = Buffer.from(m[1], 'base64');
          const r = await lib.ingest(
            { buffer: buf, source: 'browser', keyword, tags, sourceUrl: pageUrl, copyToStorage: true, skipQuality },
            settings
          );
          results.push(r);
        } catch (err) {
          results.push({ ok: false, reason: 'failed', error: String(err?.message || err).slice(0, 120) });
        }
      }
      res.json({
        ok: true,
        saved: results.filter((r) => r.ok).length,
        total: results.length,
        results: results.slice(0, 30),
      });
    })
  );

  // 去背景：两种模式
  //   ai   —— U-2-Net ONNX 抠人像/宠物（需要模型）
  //   flat —— 纯底图抠图：任意纯色背景（白底/灰底/蓝底/绿幕），纯像素、零模型、秒出
  app.get('/api/ai/matting/status', (_req, res) => res.json(matting.mattingStatus()));
  // 后台下载：立刻返回，进度由上面的 status 轮询（或任务中心）提供
  app.post('/api/ai/matting/install', (_req, res) => res.json(matting.startMattingInstall()));
  app.post('/api/ai/matting/cancel', (_req, res) => res.json({ ok: matting.cancelMattingInstall() }));
  app.post(
    '/api/images/:id/remove-bg',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row) return res.status(404).json({ error: '图片不存在' });
      const mode = req.body?.mode === 'flat' ? 'flat' : 'ai';
      // 缺模型是「还没准备」不是服务故障：409 + 可读原因，前端据此引导下载或改用纯底图
      if (mode === 'ai' && !matting.mattingStatus().downloaded) {
        return res.status(409).json({
          error: 'AI 抠图模型还没下载（设置 → AI 里可下载，约 4.5MB）；白底/灰底这类图直接用「纯底图抠图」即可',
          code: 'MODEL_MISSING',
        });
      }
      const { buffer, coverage, warning } =
        mode === 'flat' ? await flatcut.removeFlatBackground(row.abs_path) : await matting.removeBackgroundBuffer(row.abs_path);
      // 存为新文件（原图不动），走标准入库流程
      const settings = getSettings();
      const dir = lib.resolveStorageDir(settings);
      const ext = path.extname(row.abs_path);
      const stem = path.basename(row.abs_path, ext);
      let out = path.join(dir, `${stem}.nobg.png`);
      let n = 1;
      while (fs.existsSync(out)) out = path.join(dir, `${stem}.nobg-${++n}.png`);
      await fs.promises.writeFile(out, buffer);
      const tag = mode === 'flat' ? '纯底抠图' : '去背景';
      const res2 = await lib.ingest(
        {
          absPath: out,
          source: 'local',
          keyword: row.keyword || tag,
          title: `${row.title || stem}（${tag}）`,
          tags: row.tags ? `${row.tags},${tag}` : tag,
          skipPhashDupe: true, // 内容与原图同源，仍需能登记（后续由去重工具处理）
        },
        settings
      );
      // warning 不为空说明这次抠图很可能不可用（模型遇到风景/物体、背景不是纯色），别让用户以为成了
      res.json({ ok: true, mode, ...res2, coverage, warning });
    })
  );

  // 本地偏好模型（个性化推荐）：状态 / 训练
  app.get('/api/pref/status', (_req, res) => res.json(pref.prefStatus()));
  app.post(
    '/api/pref/train',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ...pref.trainPreference() });
    })
  );

  app.post(
    '/api/wallpaper/now',
    asyncRoute(async (req, res) => {
      const result = await auto.applyNow(req.body?.scope || null, req.body?.playlistId ?? null);
      res.json({ ok: true, ...result });
    })
  );

  app.get('/api/wallpaper/history', (_req, res) => res.json(auto.history(20)));

  /* 多显示器：列出屏幕（每屏可放不同壁纸 / 跨屏合成） */
  app.get(
    '/api/wallpaper/monitors',
    asyncRoute(async (_req, res) => {
      const monitors = await listMonitors();
      res.json({
        monitors,
        count: monitors.length,
        mode: getSettings().wallpaperMode || 'single',
        modes: wallpaper.WALLPAPER_MODES,
      });
    })
  );

  /* ------------------------------ 动态壁纸 ------------------------------ */
  app.get('/api/wallpaper/live', (_req, res) => res.json(getSettings().liveWallpaper || {}));

  app.put(
    '/api/wallpaper/live',
    asyncRoute(async (req, res) => {
      const cur = getSettings().liveWallpaper || {};
      const next = { ...cur, ...(req.body || {}) };
      saveSettings({ liveWallpaper: next });
      // 通知主进程（创建 / 销毁桌面层窗口）
      liveBus.emit('changed', next);
      res.json(next);
    })
  );

  app.post(
    '/api/wallpaper/live/toggle',
    asyncRoute(async (req, res) => {
      const cur = getSettings().liveWallpaper || {};
      const enabled = req.body?.enabled === undefined ? !cur.enabled : !!req.body.enabled;
      saveSettings({ liveWallpaper: { ...cur, enabled } });
      res.json({ ok: true, ...getSettings().liveWallpaper });
    })
  );

  /** 轮播清单（与定时壁纸同样的范围 / 分数过滤） */
  app.get(
    '/api/wallpaper/live/playlist',
    asyncRoute(async (_req, res) => {
      const cfg = getSettings().liveWallpaper || {};
      const minScore = Math.max(0, Number(cfg.minScore) || 0);
      const scope = cfg.scope || 'favorites';
      let rows;
      if (scope === 'playlist' && cfg.playlistId) {
        rows = db
          .prepare(
            `SELECT i.* FROM images i JOIN playlist_items pi ON pi.image_id = i.id
             WHERE pi.playlist_id = ?${minScore ? ' AND i.score >= ?' : ''}
             ORDER BY i.score DESC, i.id DESC LIMIT 80`
          )
          .all(...(minScore ? [Number(cfg.playlistId), minScore] : [Number(cfg.playlistId)]));
      } else if (scope === 'all') {
        rows = db
          .prepare(
            `SELECT * FROM images${minScore ? ' WHERE score >= ?' : ''} ORDER BY score DESC, RANDOM() LIMIT 80`
          )
          .all(...(minScore ? [minScore] : []));
      } else {
        rows = db
          .prepare(
            `SELECT * FROM images WHERE favorite = 1${minScore ? ' AND score >= ?' : ''}
             ORDER BY score DESC, RANDOM() LIMIT 80`
          )
          .all(...(minScore ? [minScore] : []));
      }
      // 清单本身是随机的（ORDER BY RANDOM）且随收藏/清单变化，绝不能被缓存
      res.set('Cache-Control', 'no-store');
      // url 必须走 toDTO 拿到的 ?v=fs_mtime 版本号：原图响应是 max-age=7天 的强缓存，
      // 不带版本号的固定 URL 会让增强/旋转/调色后的新图永远显示成旧图（壁纸窗口开好几天不关）
      res.json({
        interval: Math.max(5, Number(cfg.intervalSec) || 15),
        kenBurns: cfg.kenBurns !== false,
        total: rows.length,
        items: rows.map((r) => {
          const dto = lib.toDTO(r);
          return { id: dto.id, url: dto.url, title: dto.title };
        }),
      });
    })
  );

  /** 本地视频流（sendFile 自带 Range 支持，循环播放更顺） */
  app.get(
    '/api/wallpaper/live/video',
    asyncRoute(async (_req, res) => {
      const p = String(getSettings().liveWallpaper?.videoPath || '');
      if (!p || !fs.existsSync(p)) return res.status(404).json({ error: '视频文件不存在' });
      // 同一个 URL 换了文件内容（设置里改视频路径 / 覆盖同名文件）时，
      // 强缓存会让窗口一直播旧的；本地文件重读代价可忽略，直接不缓存
      res.set('Cache-Control', 'no-store');
      // 视频可能就放在素材目录的 .tuku 下，必须放开点路径
      res.sendFile(p, { dotfiles: 'allow' });
    })
  );

  /** 动态壁纸渲染页（桌面层窗口加载它） */
  app.get('/live', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(LIVE_HTML);
  });

  /** 调试用：当前是否有全屏应用运行（动态壁纸据此暂停） */
  app.get('/api/wallpaper/live/fscheck', async (_req, res) => {
    try {
      res.json({ fullscreen: await isFullscreenAppRunning() });
    } catch (err) {
      res.json({ fullscreen: false, error: err.message });
    }
  });

  /* 当前壁纸：托盘菜单与悬浮操作使用 */
  app.get('/api/wallpaper/current', (_req, res) => res.json(auto.currentWallpaper() || {}));

  app.post(
    '/api/wallpaper/current/favorite',
    asyncRoute((_req, res) => {
      try {
        res.json({ ok: true, ...auto.favoriteCurrent() });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    })
  );

  /* 不喜欢这张：排除并立刻换一张 */
  app.post(
    '/api/wallpaper/current/dislike',
    asyncRoute(async (_req, res) => {
      const result = await auto.dislikeCurrent();
      res.json({ ok: true, ...result });
    })
  );
}
