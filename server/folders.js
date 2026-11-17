import fs from 'node:fs';
import path from 'node:path';
import { db, getLibraryGeneration, getSettings, withTransaction } from './db.js';
import { isFolderVisible, lockedFolders } from './lib/privacy.js';
import { commonDirOf } from './lib/paths.js';

/**
 * 文件夹树：Eagle 式「虚拟树 + 一图多夹」，但导入时按磁盘真实目录自动建树。
 * - folders.path 是物化路径（含自身 id，如 '/1/5/9/'），点父夹聚合后代用前缀 LIKE
 * - anchor_path 记该节点对应的磁盘相对目录（未来供 fs.watch 同步）；纯虚拟夹为空
 * - 一张图可挂到多个文件夹（image_folders 多对多）
 */

/**
 * 相对目录（'白底图/2508季'）→ find-or-create 层级节点，返回叶子 folder id。
 * @param {string} relDir 相对当前库素材根的目录
 * @param {number} [expectGen] 调用方开始时的库代数；与当前不一致说明中途切了库，直接放弃（防串库）
 */
export function ensureFolderByRelDir(relDir, expectGen = null) {
  if (!relDir) return null;
  if (expectGen != null && expectGen !== getLibraryGeneration()) return null;
  const parts = String(relDir).split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return null;
  let parentId = null;
  let parentPath = '/';
  let leaf = null;
  let anchor = '';
  const now = new Date().toISOString();
  const find = db.prepare('SELECT id, path, anchor_path FROM folders WHERE name = ? AND parent_id IS ?');
  const insert = db.prepare(
    'INSERT INTO folders(name, parent_id, path, sort_order, anchor_path, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)'
  );
  const setPath = db.prepare('UPDATE folders SET path = ? WHERE id = ?');
  const setAnchor = db.prepare('UPDATE folders SET anchor_path = ? WHERE id = ?');
  for (const name of parts) {
    // anchor 逐级累积成磁盘相对路径：幽灵夹判定与 fs.watch 同步都靠它
    anchor = anchor ? `${anchor}/${name}` : name;
    const row = find.get(name, parentId);
    if (row) {
      // 历史数据 anchor 为空（老版本恒写空串），命中真实磁盘目录时按需补上
      if (!row.anchor_path) setAnchor.run(anchor, row.id);
      leaf = row.id;
      parentPath = row.path;
      parentId = row.id;
      continue;
    }
    const ins = insert.run(name, parentId, '', anchor, now, now);
    const id = Number(ins.lastInsertRowid);
    const selfPath = parentPath + id + '/';
    setPath.run(selfPath, id);
    leaf = id;
    parentId = id;
    parentPath = selfPath;
  }
  return leaf;
}

export function linkImageToFolder(imageId, folderId) {
  if (!imageId || !folderId) return;
  db.prepare('INSERT OR IGNORE INTO image_folders(image_id, folder_id) VALUES (?, ?)').run(imageId, folderId);
}

/** 按图片绝对路径归入文件夹树（相对当前库 root 的目录层级） */
export function linkImageByPath(imageId, absPath, rootPath = getSettings().storageDir) {
  if (!imageId || !absPath || !rootPath) return null;
  const rel = path.relative(rootPath, path.dirname(absPath));
  // 不在 root 下（跨盘 / 采集到别处）→ 归入根，不建子夹
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  // .library 是外部 Eagle 式资产目录（*.info 里是资产副本与软件预览图），
  // 树里只呈现真实目录——不为它建夹、不挂图（与扫描/监听排除保持一致）
  if (rel.toLowerCase().split(/[\\/]+/).some((p) => p.endsWith('.library'))) return null;
  const folderId = ensureFolderByRelDir(rel);
  if (folderId) linkImageToFolder(imageId, folderId);
  return folderId;
}

/** 返回全部文件夹（含每个夹直接图片数 count 与含后代聚合数 total），前端按 parent_id 组装树。
 *  聚合数在 JS 里按 path 深度自底向上累加（O(n)），避免每夹一条 LIKE 聚合的树深倍查询。 */
export function listFolderTree() {
  const folders = db
    .prepare(
      `SELECT id, name, parent_id, path, anchor_path, cover_image_id, tags, icon, color,
              sort_order, (lock_hash <> '') AS locked
         FROM folders ORDER BY sort_order ASC, name ASC`
    )
    .all();
  // 隐私空间：锁着且本次会话没解锁的夹（含其后代）不露图片数与封面
  const lockedInfo = lockedFolders();
  const unlockedIds = new Set(lockedInfo.filter((f) => f.unlocked).map((f) => f.id));
  const hiddenPrefixes = lockedInfo.filter((f) => !f.unlocked).map((f) => f.path);
  const isHiddenPath = (p) => hiddenPrefixes.some((pre) => String(p).startsWith(pre));
  // 与列表口径一致：堆叠成员不单独计数，否则侧栏显示 46、点开只有 45。
  // 必须 JOIN images：任何一条漏清关联的删除路径都会让计数虚高、封面指向已删图；
  // 删除触发器已经补上，这里再兜一层（旧库在迁移前也可能留着孤儿）。
  const stackVisible = 'f.image_id NOT IN (SELECT id FROM images WHERE stack_id <> 0 AND stack_id <> id)';
  const counts = db
    .prepare(
      `SELECT f.folder_id, COUNT(*) AS c FROM image_folders f
       JOIN images i ON i.id = f.image_id
       WHERE ${stackVisible} GROUP BY f.folder_id`
    )
    .all();
  const countMap = new Map(counts.map((r) => [r.folder_id, r.c]));
  // 封面：手动指定优先；没指定就用夹内最新的一张（MAX(image_id) 一条 GROUP BY 拿全库，不做逐夹子查询）。
  // 也跳过堆叠成员：拿一张列表里看不到的图当封面会让人以为它在夹里。
  const latest = new Map(
    db
      .prepare(
        `SELECT f.folder_id, MAX(f.image_id) AS image_id FROM image_folders f
         JOIN images i ON i.id = f.image_id
         WHERE ${stackVisible} GROUP BY f.folder_id`
      )
      .all()
      .map((r) => [r.folder_id, r.image_id])
  );
  // 父夹本身常常不直接挂图（图都在子夹里），只取 direct 最新会让父夹永远没有预览图。
  // 这里把子孙夹的最新一张上滚给祖先（Eagle 式：父夹也有封面）；锁着且未解锁的子夹不参与，
  // 避免把隐私空间的图漏到父夹封面上。
  const bestCover = new Map();
  const depthDesc = [...folders].sort((a, b) => String(b.path || '').length - String(a.path || '').length);
  for (const f of depthDesc) {
    if (isHiddenPath(f.path)) continue;
    const cand = f.cover_image_id || latest.get(f.id) || bestCover.get(f.id) || null;
    if (!cand) continue;
    if (!bestCover.has(f.id) || cand > bestCover.get(f.id)) bestCover.set(f.id, cand);
    for (const seg of String(f.path || '').split('/')) {
      const aid = Number(seg);
      if (!aid || aid === f.id) continue;
      const prev = bestCover.get(aid);
      if (!prev || cand > prev) bestCover.set(aid, cand);
    }
  }
  const coverIds = new Set();
  for (const f of folders) {
    const cid = f.cover_image_id || bestCover.get(f.id);
    if (cid) coverIds.add(cid);
  }
  const coverRows = coverIds.size
    ? db
        .prepare(
          `SELECT id, fs_mtime, cover_ver, media_kind FROM images WHERE id IN (${[...coverIds].map(() => '?').join(',')})`
        )
        .all(...coverIds)
    : [];
  const coverMeta = new Map(coverRows.map((r) => [r.id, r]));
  const nodes = folders.map((f) => {
    const hidden = isHiddenPath(f.path);
    // 指定的那张被删掉了（或不再属于这个夹）→ 退回自动封面（含子孙夹上滚的封面）
    const cid = hidden
      ? null
      : [f.cover_image_id, bestCover.get(f.id)].find((id) => id && coverMeta.has(id)) || null;
    const meta = cid ? coverMeta.get(cid) : null;
    return {
      ...f,
      locked: !!f.locked,
      unlocked: unlockedIds.has(f.id),
      count: hidden ? 0 : countMap.get(f.id) || 0,
      total: hidden ? 0 : countMap.get(f.id) || 0,
      cover: meta
        ? {
            imageId: cid,
            manual: !!f.cover_image_id && cid === f.cover_image_id,
            thumbUrl: `/api/images/${cid}/thumb?v=${Number(meta.fs_mtime) || 0}-${Number(meta.cover_ver) || 0}`,
            kind: meta.media_kind || 'image',
          }
        : null,
    };
  });
  // path 形如 '/1/5/9/'，深度 = path.split('/').length；越深越先处理，把 total 上滚给父链
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ordered = [...nodes].sort((a, b) => b.path.split('/').length - a.path.split('/').length);
  for (const n of ordered) {
    if (n.total && n.parent_id != null) {
      const p = byId.get(n.parent_id);
      if (p) p.total += n.total;
    }
  }
  return nodes;
}

/** 查某文件夹（含全部后代）的图片行（原始行，由调用方转 DTO）。
 *  子夹 id 全部内联进 IN 会在大树上超 SQLite 变量上限（32766）；
 *  改为让子查询直接用 path 前缀 LIKE（idx_folders_path 走索引）。 */
export function folderImageRows(folderId, { page = 1, pageSize = 48 } = {}) {
  const folder = db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId);
  if (!folder) return { rows: [], total: 0, hasMore: false };
  // 隐私空间：没解锁就别想用「按文件夹浏览」绕过列表筛选
  if (!isFolderVisible(folderId)) {
    const err = new Error('该文件夹已加锁，请先输入密码');
    err.statusCode = 403;
    throw err;
  }
  const sub = `SELECT f.image_id FROM image_folders f JOIN folders d ON d.id = f.folder_id WHERE d.path LIKE ?`;
  const like = folder.path + '%';
  // 与主列表一致：堆叠成员只在灯箱里展开，文件夹视图也只列组主
  const where = `id IN (${sub}) AND (stack_id = 0 OR stack_id = id)`;
  const total = db.prepare(`SELECT COUNT(*) AS c FROM images WHERE ${where}`).get(like).c;
  const rows = db
    .prepare(`SELECT * FROM images WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(like, pageSize, (page - 1) * pageSize);
  return { rows, total, hasMore: page * pageSize < total };
}

/** 一次性回填：为库中已有图片按磁盘目录建树（folders 为空但有图时执行）。
 *  按 id 游标分批（5000/批）扫图，百万库不全表一把梭进内存。 */
export function backfillFolders(rootPath = getSettings().storageDir) {
  const folderCount = db.prepare('SELECT COUNT(*) AS c FROM folders').get().c;
  const imageCount = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
  if (folderCount > 0 || imageCount === 0) return { folders: folderCount, linked: 0 };
  const batch = db.prepare('SELECT id, abs_path FROM images WHERE id > ? ORDER BY id LIMIT 5000');
  let linked = 0;
  let lastId = 0;
  withTransaction(() => {
    for (;;) {
      const rows = batch.all(lastId);
      if (!rows.length) break;
      for (const r of rows) {
        if (linkImageByPath(r.id, r.abs_path, rootPath)) linked++;
      }
      lastId = rows[rows.length - 1].id;
    }
  });
  return { folders: db.prepare('SELECT COUNT(*) AS c FROM folders').get().c, linked };
}

/**
 * 补齐「已登记但没挂任何文件夹」的行。
 *
 * 为什么需要：早期版本对非图片素材（RAW / 视频 / 音频 / 字体 / PDF / 3D）走
 * ingestMedia 登记，却漏了 image_folders 关联 —— 这些素材在任何文件夹视图里都
 * 看不到，只有「图库」全量视图能找到（用户以为原片没导入）。backfillFolders 只在
 * folders 表为空时跑，修不了这种「已有文件夹但部分行漏挂」的情况，所以单独补。
 *
 * 分页处理且只扫无关联的行，百万库也不会一把梭进内存；重复执行幂等。
 */
export function backfillMissingFolderLinks(rootPath = getSettings().storageDir, { pageSize = 5000 } = {}) {
  if (!rootPath) return 0;
  const pick = db.prepare(
    `SELECT i.id, i.abs_path FROM images i
      WHERE i.id NOT IN (SELECT image_id FROM image_folders)
      ORDER BY i.id LIMIT ?`
  );
  let linked = 0;
  for (;;) {
    const rows = pick.all(pageSize);
    if (!rows.length) break;
    let changed = 0;
    withTransaction(() => {
      for (const r of rows) if (linkImageByPath(r.id, r.abs_path, rootPath)) changed++;
    });
    linked += changed;
    // 这一批没有一条能挂上（不在 root 下 / 已排除目录）：再查还是同样一批，必须停
    if (!changed || rows.length < pageSize) break;
  }
  return linked;
}

/**
 * 文件夹对应的磁盘绝对目录。
 *
 * 存在的意义：状态栏「打开文件夹」原来只会打开库根（storageDir），
 * 用户明明在「成片」里却弹出 F:\Canon 5d4，得自己在资源管理器里再找一层。
 *
 * 两条来源，按可信度取：
 *   1) anchor_path（新库/扫描建树时写）—— 直接相对 storageDir 拼；
 *   2) 老库这个字段全是空串（实测 120 个夹子一个都没有），只能反查子树里的图片
 *      落地在哪：取「所有图片所在目录的最深公共父目录」，父夹聚合子夹时也成立。
 *
 * @param {number} folderId
 * @param {string} [rootPath] 素材根目录，默认取设置里的 storageDir
 * @returns {{dir: string, virtual: boolean, exists: boolean}}
 *   virtual：既没磁盘锚点、子树里也没有图，没有可打开的真实目录
 */
export function folderDiskDir(folderId, rootPath = getSettings().storageDir) {
  const row = db.prepare('SELECT name, path, anchor_path FROM folders WHERE id = ?').get(Number(folderId));
  if (!row) throw new Error('文件夹不存在');
  const root = path.resolve(rootPath || '');
  const anchor = String(row.anchor_path || '').replace(/^[\\/]+/, '');
  let dir = '';
  if (anchor) dir = path.resolve(root, anchor);
  if (!dir) {
    // 子树（含自身）里所有图片的实际所在目录
    const rows = db
      .prepare(
        `SELECT DISTINCT i.abs_path AS p FROM image_folders mf JOIN images i ON i.id = mf.image_id
         WHERE mf.folder_id IN (SELECT id FROM folders WHERE path = ? OR path LIKE ?)
         LIMIT 20000`
      )
      .all(row.path, `${row.path}%`);
    if (!rows.length) return { dir: root, virtual: true, exists: fs.existsSync(root) };
    dir = commonDirOf(rows.map((r) => path.dirname(String(r.p))));
  }
  // 目录可能被用户在资源管理器里删了：逐级上溯到最近的现存祖先，
  // 传一个不存在的路径给 explorer 只会得到「此电脑」
  while (dir.length > root.length && !fs.existsSync(dir)) dir = path.dirname(dir);
  // 公共父目录有可能一路升到库根之外（跨盘/UNC），超出范围就老实回库根
  if (dir.length < root.length || !dir.toLowerCase().startsWith(root.toLowerCase())) dir = root;
  return { dir, virtual: !fs.existsSync(dir), exists: fs.existsSync(dir) };
}

/**
 * 找幽灵文件夹：磁盘上已不存在、且子树里一张图都没有的节点。
 *
 * 为什么需要：应用外删目录、或历史上「扫描时库根指向过别处」都会留下这类行，
 * 侧栏会冒出「另一个库的文件夹」（张数 0），看起来就是串库。
 * 判定必须同时满足三条，宁可漏杀不可误杀（虚拟夹与真实空目录要靠 anchor_path 区分）：
 *   1) 子树（含后代、按 path 前缀）没有任何 image_folders 关联
 *   2) 子树没有任何封面
 *   3) 有 anchor_path 时磁盘必须已不存在；anchor 为空（老数据的纯虚拟夹）时只靠前两条，
 *      因此必须走 dryRun 让用户先看清单
 */
export function findGhostFolders(rootPath = getSettings().storageDir) {
  const all = db
    .prepare('SELECT id, name, parent_id, path, anchor_path, cover_image_id FROM folders ORDER BY id')
    .all();
  const linked = new Map();
  for (const r of db.prepare('SELECT folder_id, COUNT(*) AS c FROM image_folders GROUP BY folder_id').all()) {
    linked.set(r.folder_id, r.c);
  }
  const out = [];
  for (const f of all) {
    const subtree = all.filter((x) => x.path === f.path || String(x.path).startsWith(f.path));
    const hasImage = subtree.some((x) => (linked.get(x.id) || 0) > 0);
    const hasCover = subtree.some((x) => x.cover_image_id);
    if (hasImage || hasCover) continue;
    if (f.anchor_path) {
      const abs = path.join(rootPath || '', f.anchor_path);
      if (fs.existsSync(abs)) continue; // 磁盘上还在，是正常空目录
    }
    out.push({ id: f.id, name: f.name, path: f.path, anchor: f.anchor_path || '' });
  }
  return out;
}

/**
 * 清理幽灵文件夹（默认只列不删）。删父之前先删后代，image_folders 一并清掉（本来就没有）。
 * @returns {{dryRun: boolean, candidates: Array<{id:number,name:string,path:string,anchor:string}>, deleted: number}}
 */
export function pruneGhostFolders({ dryRun = true, rootPath = getSettings().storageDir } = {}) {
  const candidates = findGhostFolders(rootPath);
  if (dryRun || !candidates.length) return { dryRun: true, candidates, deleted: 0 };
  const ids = candidates.map((c) => c.id);
  const del = db.prepare('DELETE FROM folders WHERE id = ?');
  const unlink = db.prepare('DELETE FROM image_folders WHERE folder_id = ?');
  withTransaction(() => {
    // 深的先删，避免父夹被删后子夹 path 前缀查询失效
    for (const c of candidates.slice().sort((a, b) => b.path.length - a.path.length)) {
      unlink.run(c.id);
      del.run(c.id);
    }
  });
  return { dryRun: false, candidates, deleted: ids.length };
}

/* ------------------------- 虚拟文件夹管理（Eagle 式，不碰磁盘） ------------------------- */
/* 磁盘目录同步产生的夹有 anchor_path；纯虚拟夹 anchor_path 为空。二者在树里共存，
 * 一张图可同时归属多个文件夹（image_folders 多对多），删除文件夹不删除图片。 */

/** 新建虚拟文件夹，parentId 为 null 表示根级。返回新夹 id */
export function createVirtualFolder(name, parentId = null) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('文件夹名称不能为空');
  const now = new Date().toISOString();
  let parentPath = '/';
  if (parentId != null) {
    const p = db.prepare('SELECT path FROM folders WHERE id = ?').get(parentId);
    if (!p) throw new Error('父文件夹不存在');
    parentPath = p.path;
  }
  const ins = db
    .prepare(
      'INSERT INTO folders(name, parent_id, path, sort_order, anchor_path, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)'
    )
    .run(nm, parentId ?? null, '', '', now, now);
  const id = Number(ins.lastInsertRowid);
  db.prepare('UPDATE folders SET path = ? WHERE id = ?').run(parentPath + id + '/', id);
  return id;
}

/**
 * 设置文件夹标签（Eagle：夹上打标签，夹内素材自动带上）。
 * 只存逗号串，不做物化 —— 删掉文件夹标签时素材立刻就不再带它。
 * 也顺手写一份到 tag_meta，让标签云/筛选面板能直接列出这些「只在文件夹上出现过」的标签。
 */
export function setFolderTags(folderId, tags) {
  const f = db.prepare('SELECT id FROM folders WHERE id = ?').get(Number(folderId));
  if (!f) throw new Error('文件夹不存在');
  const list = (Array.isArray(tags) ? tags : String(tags || '').split(','))
    .map((s) => String(s).trim())
    .filter((s) => s && !s.includes(','))
    .filter((s, i, a) => a.indexOf(s) === i)
    .slice(0, 50);
  const now = new Date().toISOString();
  db.prepare('UPDATE folders SET tags = ?, updated_at = ? WHERE id = ?').run(list.join(','), now, f.id);
  try {
    for (const t of list) {
      db.prepare('INSERT OR IGNORE INTO tag_meta (tag, updated_at) VALUES (?, ?)').run(t, now);
    }
  } catch {
    /* 老库无 tag_meta 时忽略：继承筛选本身不依赖它 */
  }
  return { id: f.id, tags: list };
}

/**
 * 文件夹内手动排序：按传入的 id 顺序写入 sort_order（步长 1024，留插入余量）。
 * 只更新「本来就在这个夹里」的行，避免把别的夹的素材偷偷挂进来。
 */
export function reorderFolderImages(folderId, imageIds) {
  const fid = Number(folderId);
  if (!fid) throw new Error('文件夹不能为空');
  if (!Array.isArray(imageIds) || !imageIds.length) throw new Error('排序列表不能为空');
  const exists = db.prepare('SELECT 1 AS ok FROM image_folders WHERE folder_id = ? AND image_id = ?');
  const upd = db.prepare('UPDATE image_folders SET sort_order = ? WHERE folder_id = ? AND image_id = ?');
  let n = 0;
  withTransaction(() => {
    imageIds.forEach((id, i) => {
      const imgId = Number(id);
      if (!imgId || !exists.get(fid, imgId)) return;
      upd.run((i + 1) * 1024, fid, imgId);
      n++;
    });
  });
  return { folderId: fid, updated: n };
}

/** 设置 / 清除文件夹封面。imageId 传 null / 0 = 恢复自动（夹内最新一张） */
export function setFolderCover(folderId, imageId = null) {
  const f = db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId);
  if (!f) throw new Error('文件夹不存在');
  let iid = null;
  if (imageId) {
    const img = db.prepare('SELECT id FROM images WHERE id = ?').get(Number(imageId));
    if (!img) throw new Error('图片不存在');
    iid = Number(imageId);
  }
  db.prepare('UPDATE folders SET cover_image_id = ?, updated_at = ? WHERE id = ?').run(
    iid,
    new Date().toISOString(),
    folderId
  );
  return iid;
}

/**
 * 文件夹外观：emoji / 图标字符 + 主题色。
 * icon 允许空串（清除图标）、最多 4 个字符（一个 emoji 可能是两个码元）；
 * color 只接受 #rgb / #rrggbb，其他一律当清除，避免把任意 CSS 写进 style。
 */
export function setFolderAppearance(id, { icon, color } = {}) {
  const f = db.prepare('SELECT id FROM folders WHERE id = ?').get(Number(id));
  if (!f) throw new Error('文件夹不存在');
  const sets = [];
  const vals = [];
  let nextIcon;
  let nextColor;
  if (icon !== undefined) {
    nextIcon = Array.from(String(icon || '').trim()).slice(0, 4).join('');
    sets.push('icon = ?');
    vals.push(nextIcon);
  }
  if (color !== undefined) {
    const c = String(color || '').trim();
    nextColor = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(c) ? c.toLowerCase() : '';
    sets.push('color = ?');
    vals.push(nextColor);
  }
  if (!sets.length) return { id: f.id };
  sets.push('updated_at = ?');
  vals.push(new Date().toISOString(), f.id);
  db.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return { id: f.id, icon: nextIcon, color: nextColor };
}

/**
 * 文件夹排序：Eagle 的手动拖拽顺序。
 * 只写「同一父级内」的相对顺序（步长 1024 留插入余量），传进来的 id 必须同父，
 * 否则一次拖拽就能把子夹悄悄挪到别的父级下 —— 那不是排序而是移动。
 */
export function reorderFolders(parentId, folderIds = []) {
  const pid = parentId == null ? null : Number(parentId);
  const rows = db.prepare('SELECT id, parent_id FROM folders').all();
  const parentOf = new Map(rows.map((r) => [r.id, r.parent_id ?? null]));
  const upd = db.prepare('UPDATE folders SET sort_order = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  let n = 0;
  withTransaction(() => {
    folderIds.forEach((id, i) => {
      const fid = Number(id);
      if (!fid || !parentOf.has(fid)) return;
      if ((parentOf.get(fid) ?? null) !== pid) return;
      upd.run((i + 1) * 1024, now, fid);
      n++;
    });
  });
  return { parentId: pid, updated: n };
}

/**
 * 批量创建文件夹：一行一个名字（换行 / 逗号分隔），都挂在同一父级下。
 * 遇到同名兄弟夹跳过（不重复建），返回实际新建的名字，便于前端如实提示。
 */
export function createFoldersBatch(names, parentId = null) {
  const list = (Array.isArray(names) ? names : String(names || '').split(/[\r\n,，]+/))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .filter((s, i, a) => a.indexOf(s) === i)
    .slice(0, 200);
  if (!list.length) throw new Error('请至少填写一个文件夹名称');
  const exists = db.prepare('SELECT 1 AS ok FROM folders WHERE name = ? AND parent_id IS ?');
  const created = [];
  const skipped = [];
  withTransaction(() => {
    for (const name of list) {
      if (exists.get(name, parentId ?? null)) {
        skipped.push(name);
        continue;
      }
      createVirtualFolder(name, parentId ?? null);
      created.push(name);
    }
  });
  return { created, skipped };
}

/** 重命名文件夹（虚拟夹与磁盘夹均可） */
export function renameFolder(id, name) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('文件夹名称不能为空');
  const r = db.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?').run(nm, new Date().toISOString(), id);
  if (!r.changes) throw new Error('文件夹不存在');
}

/** LIKE 通配符转义：配合 `ESCAPE '\'` 把 % _ \ 变成字面量 */
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

/** 删除文件夹及其全部子夹（级联），不删除任何图片，只解除关联 */
export function deleteFolder(id) {
  const f = db.prepare('SELECT path FROM folders WHERE id = ?').get(id);
  if (!f) throw new Error('文件夹不存在');
  // 大树（几千个子夹）时把 id 全捞出来内联进 IN 会超变量上限；直接用 path 前缀删。
  // path 由 id 拼成（不含用户输入），仍统一转义 + ESCAPE：一旦以后 path 里带上名字，
  // 未转义的 _ 会变成单字符通配符，误删同级兄弟文件夹。
  const like = escapeLike(f.path) + '%';
  // 关联表与 folders 的两次 DELETE 必须同进同退，否则中断会留下指向已删文件夹的悬挂关联
  return withTransaction(() => {
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM folders WHERE path LIKE ? ESCAPE '\\'")
      .get(like).c;
    db.prepare(
      "DELETE FROM image_folders WHERE folder_id IN (SELECT id FROM folders WHERE path LIKE ? ESCAPE '\\')"
    ).run(like);
    db.prepare("DELETE FROM folders WHERE path LIKE ? ESCAPE '\\'").run(like);
    return count;
  });
}

/** 把一批图片加入某个文件夹（一图可多夹；返回实际新增的关联数） */
export function addImagesToFolder(folderId, imageIds = []) {
  const f = db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId);
  if (!f) throw new Error('文件夹不存在');
  const ins = db.prepare('INSERT OR IGNORE INTO image_folders(image_id, folder_id) VALUES (?, ?)');
  let added = 0;
  withTransaction(() => {
    for (const iid of imageIds) {
      if (ins.run(Number(iid), folderId).changes) added++;
    }
  });
  return added;
}

/** 把一批图片从某个文件夹移除（不影响图片本身，也不影响其他文件夹归属） */
export function removeImagesFromFolder(folderId, imageIds = []) {
  const del = db.prepare('DELETE FROM image_folders WHERE folder_id = ? AND image_id = ?');
  let removed = 0;
  withTransaction(() => {
    for (const iid of imageIds) {
      removed += del.run(folderId, Number(iid)).changes;
    }
  });
  return removed;
}
