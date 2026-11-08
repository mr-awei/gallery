// 整理类路由：标签体系（分组/颜色/层级）、待整理视图、完全重复（MD5）、批量重命名、音视频元数据回写
// 行为对齐 Eagle：标签可分群组上色挂父子，「未分类/无标签」是固定入口，「重复文件」按字节完全相同分组。
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import * as lib from '../library.js';
import { md5File } from '../lib/hash.js';
import { logOp } from '../oplog.js';

/**
 * 批量重命名模板：{name} {keyword} {source} {date} {index} {width} {height} {ext}
 * 顺序对齐 Eagle：套模板 → 查找替换 → 大小写 → 过滤非法字符
 */
function renderTemplate(tpl, row, index, opts = {}) {
  const pad = Math.min(8, Math.max(1, Number(opts.pad) || 3));
  const find = String(opts.find || '');
  const replace = String(opts.replace || '');
  const caseMode = String(opts.caseMode || 'keep');

  const created = String(row.created_at || '').slice(0, 10).replace(/-/g, '');
  const ext = path.extname(row.abs_path || '').replace('.', '');
  const base = String(row.title || '').replace(new RegExp(`\\.${ext}$`, 'i'), '');
  let out = String(tpl)
    .replace(/\{name\}/gi, base)
    .replace(/\{keyword\}/gi, row.keyword || '')
    .replace(/\{source\}/gi, row.source || '')
    .replace(/\{date\}/gi, created)
    .replace(/\{index\}/gi, String(index).padStart(pad, '0'))
    .replace(/\{width\}/gi, String(row.width || 0))
    .replace(/\{height\}/gi, String(row.height || 0))
    .replace(/\{ext\}/gi, ext);

  if (find) out = out.split(find).join(replace);
  if (caseMode === 'lower') out = out.toLowerCase();
  else if (caseMode === 'upper') out = out.toUpperCase();
  else if (caseMode === 'title') out = out.replace(/(^|\s)(\S)/g, (_, sp, ch) => sp + ch.toUpperCase());

  return out
    .replace(/[\\/:*?"<>|\r\n\t]/g, '')
    .trim()
    .slice(0, 120);
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  /* --------------------------- 标签：分组/颜色/层级 --------------------------- */

  app.put(
    '/api/tags/meta',
    asyncRoute(async (req, res) => {
      const { tag, group, color, parent, sortOrder } = req.body || {};
      const meta = lib.setTagMeta({ tag, group, color, parent, sortOrder });
      res.json({ ok: true, meta, tags: lib.listTagsPaged({ limit: 500, rich: true }).items, groups: lib.listTagGroups() });
    })
  );

  /** 拖动标签到父标签下（Eagle 的层级），parent 空串 = 回到顶层 */
  app.post(
    '/api/tags/move',
    asyncRoute(async (req, res) => {
      const { tag, parent } = req.body || {};
      const meta = lib.setTagParent(tag, parent);
      res.json({ ok: true, meta, tags: lib.listTagsPaged({ limit: 500, rich: true }).items, groups: lib.listTagGroups() });
    })
  );

  /** 拖动排序：一次提交期望顺序，避免逐条 meta 请求 */
  app.post(
    '/api/tags/reorder',
    asyncRoute(async (req, res) => {
      const tags = lib.reorderTags(req.body?.tags);
      res.json({ ok: true, tags, groups: lib.listTagGroups() });
    })
  );

  /** 分组改名 / 删除（分组不是实体表，批量改 tag_meta.tag_group 即可） */
  app.post(
    '/api/tags/group/rename',
    asyncRoute(async (req, res) => {
      const { from, to } = req.body || {};
      const groups = lib.renameTagGroup(from, to);
      res.json({ ok: true, groups, tags: lib.listTagsPaged({ limit: 500, rich: true }).items });
    })
  );
  app.post(
    '/api/tags/group/delete',
    asyncRoute(async (req, res) => {
      const groups = lib.clearTagGroup(req.body?.name);
      res.json({ ok: true, groups, tags: lib.listTagsPaged({ limit: 500, rich: true }).items });
    })
  );

  /**
   * 批量创建标签：一行/逗号一个标签名，可同时归入一个分组。
   * 标签本体仍是 images.tags 逗号串，这里只是把 tag_meta 建出来 —— 空标签（0 张图）
   * 也能出现在标签树里，符合 Eagle「先把分类建好再往里放图」的用法。
   */
  app.post(
    '/api/tags/batch',
    asyncRoute(async (req, res) => {
      const { names, group, color } = req.body || {};
      const list = (Array.isArray(names) ? names : String(names || '').split(/[\r\n,，]+/))
        .map((s) => String(s).trim())
        .filter(Boolean)
        .filter((s, i, a) => a.indexOf(s) === i)
        .slice(0, 300);
      if (!list.length) return res.status(400).json({ error: '请至少填写一个标签名' });
      const created = [];
      for (const tag of list) {
        lib.setTagMeta({
          tag,
          group: group === undefined ? undefined : String(group || ''),
          color: color === undefined ? undefined : String(color || ''),
        });
        created.push(tag);
      }
      res.json({
        ok: true,
        created,
        tags: lib.listTagsPaged({ limit: 500, rich: true }).items,
        groups: lib.listTagGroups(),
      });
    })
  );

  /* ------------------------------- 待整理视图 ------------------------------- */

  // Eagle 的固定入口：未分类 / 无标签 / 未评分。前端拿到计数后直接跳对应的筛选视图。
  app.get('/api/organize/pending', (_req, res) => {
    const one = (sql) => Number(db.prepare(sql).get()?.n || 0);
    // 与图库列表同口径：堆叠成员不单独计数，否则侧栏 12、点进去 11
    const visible = '(stack_id = 0 OR stack_id = id)';
    res.json({
      total: one(`SELECT COUNT(*) n FROM images WHERE ${visible}`),
      noFolder: one(
        `SELECT COUNT(*) n FROM images WHERE id NOT IN (SELECT image_id FROM image_folders) AND ${visible}`
      ),
      noTags: one(`SELECT COUNT(*) n FROM images WHERE tags = '' AND ${visible}`),
      noRating: one(`SELECT COUNT(*) n FROM images WHERE rating = 0 AND ${visible}`),
    });
  });

  /* --------------------------- 完全重复（MD5，非 pHash） --------------------------- */

  app.get('/api/dupes/md5', (_req, res) => {
    const groups = db
      .prepare(
        `SELECT md5, size_bytes AS size, COUNT(*) AS n
           FROM images
          WHERE md5 <> '' AND size_bytes > 0
          GROUP BY size_bytes, md5
         HAVING COUNT(*) > 1
          ORDER BY size_bytes DESC
          LIMIT 500`
      )
      .all();
    const out = groups.map((g) => {
      const rows = db.prepare('SELECT * FROM images WHERE md5 = ? AND size_bytes = ? ORDER BY id').all(g.md5, g.size);
      return {
        md5: g.md5,
        size: g.size,
        count: g.n,
        items: rows.map((r) => {
          const dto = lib.toDTO(r);
          return {
            id: dto.id,
            title: dto.title,
            url: dto.url,
            thumbUrl: dto.thumbUrl,
            width: dto.width,
            height: dto.height,
            sizeBytes: dto.sizeBytes,
            source: dto.source,
            createdAt: dto.createdAt,
            absPath: dto.absPath,
            mediaKind: dto.mediaKind,
          };
        }),
      };
    });
    // 可回收容量：每组保留一张，其余都是纯浪费
    const reclaim = out.reduce((sum, g) => sum + g.size * (g.count - 1), 0);
    const missing = Number(db.prepare("SELECT COUNT(*) n FROM images WHERE md5 = ''").get()?.n || 0);
    res.json({ ok: true, groups: out, reclaim, missing });
  });

  /** 给老图补算 MD5（每次限 400 张，前端轮询直到 remaining 为 0） */
  app.post(
    '/api/dupes/md5/backfill',
    asyncRoute(async (req, res) => {
      const limit = Math.min(Number(req.body?.limit) || 400, 2000);
      const rows = db
        .prepare("SELECT id, abs_path FROM images WHERE md5 = '' AND abs_path IS NOT NULL AND abs_path <> '' LIMIT ?")
        .all(limit);
      let done = 0;
      for (const r of rows) {
        try {
          if (!fs.existsSync(r.abs_path)) continue;
          const hash = await md5File(r.abs_path);
          db.prepare('UPDATE images SET md5 = ? WHERE id = ?').run(hash, r.id);
          done += 1;
        } catch {
          /* 单个失败不影响其他 */
        }
      }
      const remaining = Number(db.prepare("SELECT COUNT(*) n FROM images WHERE md5 = ''").get()?.n || 0);
      res.json({ ok: true, done, remaining });
    })
  );

  /**
   * 解决重复：保留 keepId，其余移入回收站（可恢复，和手动删除同一条路径）。
   *
   * removeImage 会先把文件移到回收站（fs 异步），无法塞进同步事务里，所以这里不做
   * 全或无的事务，而是**逐项记账**：成功/失败都回给前端，ok 只代表全部成功。
   * 旧实现把 removeImage 的 {ok:false} 当成功计数、异常又被空 catch 吞掉，
   * 前端固定显示「已解决」，实际有几张根本没动。
   */
  app.post(
    '/api/dupes/md5/resolve',
    asyncRoute(async (req, res) => {
      const keepId = Number(req.body?.keepId || 0);
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
        .map(Number)
        .filter((n) => n && n !== keepId);
      if (!keepId) return res.status(400).json({ error: '缺少要保留的图片 id' });
      if (!ids.length) return res.json({ ok: true, removed: 0, failed: [], keepId });
      const keep = lib.getImage(keepId);
      if (!keep) return res.status(404).json({ error: '要保留的图片不存在（可能已被删除）' });

      const removedIds = [];
      const failed = [];
      for (const id of ids) {
        try {
          const r = await lib.removeImage(id, { reason: '完全重复（MD5 一致）' });
          if (r && r.ok === false) failed.push({ id, error: r.error || '删除失败' });
          else removedIds.push(id);
        } catch (err) {
          failed.push({ id, error: String(err?.message || err) });
        }
      }
      // 记一笔撤销：删进回收站的这批图可整体恢复，否则「一键去重」手滑就是几十张消失
      if (removedIds.length) {
        logOp({
          op: 'trash',
          summary: `完全重复清理 ${removedIds.length} 张（保留 #${keepId}）`,
          payload: { imageIds: removedIds },
        });
      }
      res.json({ ok: failed.length === 0, removed: removedIds.length, failed, keepId });
    })
  );

  /* ------------------------------- 批量重命名 ------------------------------- */

  // Eagle 的 Batch Rename：模板 + 起始序号，落盘改名（文件在硬盘上同样可读）
  app.post(
    '/api/images/rename-batch',
    asyncRoute(async (req, res) => {
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
      const template = String(req.body?.template || '{name}').trim();
      const start = Number(req.body?.start) || 1;
      if (!ids.length) return res.status(400).json({ error: '未选中图片' });
      if (!template) return res.status(400).json({ error: '模板不能为空' });
      const opts = {
        pad: Number(req.body?.pad) || 3,
        find: req.body?.find,
        replace: req.body?.replace,
        caseMode: req.body?.caseMode,
      };

      const results = [];
      // 记下改名前后的名字，撤销时原地改回（磁盘文件名也一起还原）
      const renamed = [];
      const used = new Set();
      for (let i = 0; i < ids.length; i += 1) {
        const row = lib.getImage(ids[i]);
        if (!row) continue;
        const dir = path.dirname(row.abs_path);
        const ext = path.extname(row.abs_path) || '.jpg';
        const withExt = (s) => (s.toLowerCase().endsWith(ext.toLowerCase()) ? s : s + ext);
        const base = renderTemplate(template, row, start + i, opts);
        if (!base) continue;
        // 模板里没写 {index} 时同批会撞名，磁盘上也可能已有同名文件，按 Eagle 的方式补 (2)(3)…
        let name = withExt(base);
        const key = (t) => `${dir.toLowerCase()}|${t.toLowerCase()}`;
        const own = row.abs_path.toLowerCase();
        for (let seq = 2; seq < 500; seq += 1) {
          const target = path.join(dir, name);
          const clash = used.has(key(name)) || (target.toLowerCase() !== own && fs.existsSync(target));
          if (!clash) break;
          name = withExt(`${base} (${seq})`);
        }
        used.add(key(name));
        try {
          const dto = await lib.renameImage(row.id, name);
          renamed.push({ id: row.id, before: row.title });
          results.push({ id: row.id, ok: true, title: dto.title });
        } catch (e) {
          results.push({ id: row.id, ok: false, error: String(e?.message || e) });
        }
      }
      if (renamed.length) {
        logOp({
          op: 'rename',
          summary: `批量重命名 ${renamed.length} 张`,
          payload: { items: renamed },
        });
      }
      res.json({
        ok: true,
        renamed: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      });
    })
  );

  /* --------------------------- 音视频元数据 / 自定义封面 --------------------------- */

  // 前端 <video>/<audio> 读到真实元数据后回写时长与尺寸；Eagle 的「设为封面帧」也走这里
  app.patch(
    '/api/images/:id/media',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row) return res.status(404).json({ error: '图片不存在' });
      const { duration, width, height, coverTs, trimStart, trimEnd } = req.body || {};
      const sets = [];
      const vals = [];
      if (duration !== undefined && Number.isFinite(Number(duration))) {
        sets.push('duration = ?');
        vals.push(Math.max(0, Number(duration)));
      }
      if (width !== undefined && Number.isFinite(Number(width)) && Number(width) > 0) {
        sets.push('width = ?');
        vals.push(Math.round(Number(width)));
      }
      if (height !== undefined && Number.isFinite(Number(height)) && Number(height) > 0) {
        sets.push('height = ?');
        vals.push(Math.round(Number(height)));
      }
      if (coverTs !== undefined && Number.isFinite(Number(coverTs))) {
        sets.push('cover_ts = ?');
        vals.push(Math.max(0, Number(coverTs)));
      }
      // 视频首尾裁剪区间：只接受非负有限数，且终点不小于起点（否则存进去就是坏数据）
      if (trimStart !== undefined && Number.isFinite(Number(trimStart))) {
        sets.push('trim_start = ?');
        vals.push(Math.max(0, Number(trimStart)));
      }
      if (trimEnd !== undefined && Number.isFinite(Number(trimEnd))) {
        sets.push('trim_end = ?');
        vals.push(Math.max(0, Number(trimEnd)));
      }
      if (sets.length) {
        db.prepare(`UPDATE images SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
      }
      res.json({ ok: true, image: lib.toDTO(lib.getImage(id)) });
    })
  );

  /* ------------------------------ 自定义封面帧 ------------------------------ */

  // 视频/GIF 抽帧上传（前端 canvas 截一帧 PNG），存为 thumb，并把该帧时间记进 cover_ts
  app.post(
    '/api/images/:id/cover',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row) return res.status(404).json({ error: '图片不存在' });
      const { dataUrl, ts } = req.body || {};
      const m = String(dataUrl || '').match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
      if (!m) return res.status(400).json({ error: '封面数据格式不正确' });
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length) return res.status(400).json({ error: '封面数据为空' });
      await lib.setCustomThumb(id, buf, m[1]);
      if (ts !== undefined && Number.isFinite(Number(ts))) {
        db.prepare('UPDATE images SET cover_ts = ? WHERE id = ?').run(Math.max(0, Number(ts)), id);
      }
      res.json({ ok: true, image: lib.toDTO(lib.getImage(id)) });
    })
  );

  // 恢复默认缩略图：清掉自定义封面帧，图片类按原图重建
  app.delete(
    '/api/images/:id/cover',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      if (!lib.getImage(id)) return res.status(404).json({ error: '图片不存在' });
      res.json({ ok: true, image: await lib.resetThumb(id) });
    })
  );
}
