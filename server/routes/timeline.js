// @ts-check
/**
 * 时间线视图接口。
 *
 * 口径统一用 images.taken_at（EXIF 拍摄时间；缺失时导入期按文件修改 / 创建时间兜底；
 * 两者都没有就留空、这张图暂不排进时间线），绝不用 created_at —— 那是「入库时间」，
 * 拿它当拍摄时间会把 2019 年拍的照片全排到导入那天。
 *
 * 为什么分「月 → 日」两级而不是一次给全部：百万级图库一次序列化十万 DTO 会卡死事件循环。
 * 年/月/日列表都用一次 GROUP BY 聚合（每月最多 31 行、每天一行），图片用 taken_at 字符串
 * 范围查询（索引可用）按天拉。只给到月的话界面是「一个月一大片平铺」，看不出哪天拍的。
 */
import { db } from '../db.js';
import * as lib from '../library.js';
import { attachStackInfo } from '../lib/stacks.js';
import { hiddenImagesClause } from '../lib/privacy.js';
import { lastJob } from '../jobs.js';
import { cancelTimelineBackfill, pendingCount, startTimelineBackfill } from '../timeline-backfill.js';
import { nextDay, nextMonth } from '../lib/timeline-window.js';

/** 堆叠成员不单独出现在时间线（与列表/统计同一规则，避免总数对不上） */
const STACK_SQL = ' AND (stack_id = 0 OR stack_id = id)';

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  /** 年份/月份索引 + 总量 + 待校正数量（顶部提示「重建拍摄时间」用） */
  app.get('/api/timeline/summary', (_req, res) => {
    const hidden = hiddenImagesClause();
    const lockSql = hidden ? ` AND ${hidden.sql}` : '';
    const lockParams = hidden ? hidden.params : [];
    const months = db
      .prepare(
        // 「没有拍摄时间」在本库里是空串（列声明 NOT NULL DEFAULT ''）；IS NOT NULL 只为
        // 更早版本建出的可空列兜底 —— 那种库里 taken_at <> '' 对 NULL 恒为 NULL，
        // 会让这些行从月份里消失却仍计进 unplaced，界面就成了「有素材但时间线全空」
        `SELECT substr(taken_at, 1, 7) AS month, COUNT(*) AS count FROM images
          WHERE taken_at IS NOT NULL AND taken_at <> ''${STACK_SQL}${lockSql}
          GROUP BY month ORDER BY month DESC`
      )
      .all(...lockParams);
    const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM images WHERE 1=1${STACK_SQL}${lockSql}`).get(...lockParams);
    const placed = months.reduce((s, r) => s + Number(r.count || 0), 0);
    res.json({
      total: Number(totalRow?.n || 0),
      placed,
      unplaced: Math.max(0, Number(totalRow?.n || 0) - placed),
      months,
      pending: pendingCount(),
      lastBackfill: lastJob('timeline-backfill'),
    });
  });

  /** 某个月的「日期索引」：月内再按天分组，界面才具体到日期（每月最多 31 行） */
  app.get('/api/timeline/days', (req, res) => {
    const month = String(req.query.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month 需形如 2026-11' });
    const from = `${month}-01`;
    const to = `${nextMonth(month)}-01`;
    const hidden = hiddenImagesClause();
    const lockSql = hidden ? ` AND ${hidden.sql}` : '';
    const lockParams = hidden ? hidden.params : [];
    const rows = db
      .prepare(
        `SELECT substr(taken_at, 1, 10) AS day, COUNT(*) AS count FROM images
          WHERE taken_at >= ? AND taken_at < ?${STACK_SQL}${lockSql}
          GROUP BY day ORDER BY day DESC`
      )
      .all(from, to, ...lockParams);
    const total = rows.reduce((s, r) => s + Number(r.count || 0), 0);
    res.json({ month, total, days: rows });
  });

  /** 某天（或某月）的图片，按拍摄时间倒序分页；界面按天请求，month 留给旧客户端与冒烟 */
  app.get(
    '/api/timeline',
    asyncRoute(async (req, res) => {
      const day = String(req.query.day || '').trim();
      const month = String(req.query.month || '').trim();
      let from;
      let to;
      if (day) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'day 需形如 2026-11-13' });
        from = day;
        to = nextDay(day);
      } else {
        if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month 需形如 2026-11' });
        from = `${month}-01`;
        to = `${nextMonth(month)}-01`;
      }
      const limit = Math.min(400, Math.max(1, Number(req.query.limit) || 120));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const hidden = hiddenImagesClause();
      const lockSql = hidden ? ` AND ${hidden.sql}` : '';
      const lockParams = hidden ? hidden.params : [];
      // 字符串范围比较 = 走 idx_images_taken；substr(taken_at,1,7) = ? 会退化成全表扫
      const where = `taken_at >= ? AND taken_at < ?${STACK_SQL}${lockSql}`;
      const params = [from, to, ...lockParams];
      const rows = db
        .prepare(`SELECT * FROM images WHERE ${where} ORDER BY taken_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);
      const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM images WHERE ${where}`).get(...params)?.n || 0);
      // day 命中时把 month 一起回，前端不用再切字符串
      res.json({
        day: day || undefined,
        month: day ? day.slice(0, 7) : month,
        total,
        limit,
        offset,
        items: attachStackInfo(rows.map(lib.toDTO)),
      });
    })
  );

  /** 重建拍摄时间（EXIF / 文件时间，后台任务，可取消；界面在时间线顶部提示） */
  app.post(
    '/api/timeline/backfill',
    asyncRoute(async (_req, res) => {
      res.json(startTimelineBackfill());
    })
  );

  app.post(
    '/api/timeline/backfill/cancel',
    asyncRoute(async (_req, res) => {
      cancelTimelineBackfill();
      res.json({ ok: true });
    })
  );
}
