// @ts-check
/**
 * 时间线视图接口。
 *
 * 口径统一用 images.taken_at（EXIF 拍摄时间；缺失时导入期按文件修改 / 创建时间兜底；
 * 两者都没有就留空、这张图暂不排进时间线），绝不用 created_at —— 那是「入库时间」，
 * 拿它当拍摄时间会把 2019 年拍的照片全排到导入那天。
 *
 * 为什么按「月份」分页而不是一次给全部：百万级图库一次序列化十万 DTO 会卡死事件循环。
 * 月内用 taken_at 范围查询（索引可用），月列表用一次 GROUP BY 聚合。
 */
import { db } from '../db.js';
import * as lib from '../library.js';
import { attachStackInfo } from '../lib/stacks.js';
import { hiddenImagesClause } from '../lib/privacy.js';
import { lastJob } from '../jobs.js';
import { cancelTimelineBackfill, pendingCount, startTimelineBackfill } from '../timeline-backfill.js';

/** 堆叠成员不单独出现在时间线（与列表/统计同一规则，避免总数对不上） */
const STACK_SQL = ' AND (stack_id = 0 OR stack_id = id)';

/** 'YYYY-MM' → 下个月同格式（跨年安全） */
function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  /** 年份/月份索引 + 总量 + 待校正数量（顶部提示「重建拍摄时间」用） */
  app.get('/api/timeline/summary', (_req, res) => {
    const hidden = hiddenImagesClause();
    const lockSql = hidden ? ` AND ${hidden.sql}` : '';
    const lockParams = hidden ? hidden.params : [];
    const months = db
      .prepare(
        `SELECT substr(taken_at, 1, 7) AS month, COUNT(*) AS count FROM images
          WHERE taken_at <> ''${STACK_SQL}${lockSql}
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

  /** 某个月的图片（按拍摄时间倒序分页） */
  app.get(
    '/api/timeline',
    asyncRoute(async (req, res) => {
      const month = String(req.query.month || '').trim();
      if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month 需形如 2026-11' });
      const from = `${month}-01`;
      const to = `${nextMonth(month)}-01`;
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
      res.json({ month, total, limit, offset, items: attachStackInfo(rows.map(lib.toDTO)) });
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
