import { rgbToOklab } from '../lib/oklab.js';
import { repairTakenAt } from '../lib/timeline-repair.js';
import { fkTail } from './foreign-keys.js';
import { LIBRARY_SCHEMA_SQL, LIBRARY_TRIGGER_SQL } from './schema-sql.js';
import { getPathIndexState, noteSchemaWarning, setPathIndexState } from './state.js';

/** 建（或补建）abs_path 唯一索引；重复清干净后可由界面触发重试 */
export function createPathIndex(conn) {
  try {
    conn.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_images_path_unique ON images(abs_path)');
    setPathIndexState({ ok: true, duplicates: 0, error: '' });
  } catch (err) {
    let duplicates = 0;
    try {
      duplicates =
        Number(
          conn
            .prepare('SELECT COUNT(*) AS c FROM (SELECT abs_path FROM images GROUP BY abs_path HAVING COUNT(*) > 1)')
            .get()?.c
        ) || 0;
    } catch {
      /* 统计失败不影响主结论：索引确实没建起来 */
    }
    setPathIndexState({ ok: false, duplicates, error: String(err?.message || err).slice(0, 200) });
    console.warn(`[db] abs_path 有 ${duplicates} 组重复路径，唯一索引未建立；清理重复后可在「数据与维护」重建`);
  }
  return getPathIndexState();
}

/**
 * 触发器依赖的拆分/清理函数（必须在任何写入前注册）。
 * 注意：闭包必须捕获「注册它的连接 conn」而非 live `db` —— 切库后旧连接的
 * 触发器仍应操作旧连接，否则会把数据写进新库。
 */
function registerTriggerFunctions(conn) {
  conn.function('sync_item_tags', (id, tagsStr) => {
    const tags = String(tagsStr || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    conn.prepare('DELETE FROM item_tags WHERE image_id = ?').run(id);
    const ins = conn.prepare('INSERT OR IGNORE INTO item_tags(tag, image_id) VALUES (?, ?)');
    for (const t of tags) ins.run(t, id);
  });
  conn.function('delete_item_tags', (id) => {
    conn.prepare('DELETE FROM item_tags WHERE image_id = ?').run(id);
  });
  // 素材被彻底删除时一并清掉笔记，否则素材删掉后笔记表会一直长（还带着正文）
  conn.function('delete_image_notes', (id) => {
    conn.prepare('DELETE FROM image_notes WHERE image_id = ?').run(id);
  });
}

/**
 * 逐列探测补列 + 索引补建 + 存量数据回填（等价旧版 db.js 顶层的 reconcile 段）。
 *
 * 顺序是硬约束：**所有 CREATE INDEX 必须排在对应列 ensureColumn 之后**。
 * 老库（v3 之前）没有 taken_at 等列，索引写进建表段会抛 no such column。
 */
function reconcileColumns(conn) {
  // ---- 结构迁移（对当前连接执行，等价旧版顶层 ensureColumn）----
  /** @returns {boolean} 是否本次新加的列（老库补列后需要一次性回填） */
  const ensureColumn = (table, column, ddl) => {
    const cols = conn.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      conn.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      return true;
    }
    return false;
  };
  // 时间线视图：拍摄时间列 + 索引。老库新加列后立刻按文件时间（fs_mtime）回填 ——
  // 绝不用入库时间：那会让整库照片堆到导入那天。连文件指纹都没有的行留空，
  // 时间线页会提示「N 张待校正」，重建任务 stat 一次文件就能补上。
  if (ensureColumn('images', 'taken_at', "taken_at TEXT NOT NULL DEFAULT ''")) {
    repairTakenAt(conn);
  }
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_taken ON images(taken_at)');
  // 非破坏性编辑：操作链条数冗余在 images 上，列表 DTO 不必为每行查一次 edit_ops
  ensureColumn('images', 'edit_ops_count', 'edit_ops_count INTEGER NOT NULL DEFAULT 0');
  // 操作链版本号：任何增删都 +1。前端 URL（?v=）与派生图缓存都靠它失效，
  // 光靠条数不够 —— 撤销一步再补一步，条数不变但画面已经不同了。
  ensureColumn('images', 'edit_ops_ver', 'edit_ops_ver INTEGER NOT NULL DEFAULT 0');
  // 非破坏性编辑的操作链（裁切/旋转/调色的可逆记录）。
  // 开着这个模式时原图不动，所有改动记在这里，由渲染层套用；「应用到底片」才真正写回。
  conn.exec(`
CREATE TABLE IF NOT EXISTS edit_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL${fkTail('edit_ops')}
);
CREATE INDEX IF NOT EXISTS idx_edit_ops_image ON edit_ops(image_id);
CREATE TRIGGER IF NOT EXISTS trg_edit_ops_delete AFTER DELETE ON images BEGIN
  DELETE FROM edit_ops WHERE image_id = OLD.id;
END;
`);
  ensureColumn('images', 'score', 'score INTEGER NOT NULL DEFAULT 100');
  ensureColumn('images', 'score_reason', "score_reason TEXT NOT NULL DEFAULT ''");
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_score ON images(score)');
  // 撤销栈方向：0 = 可撤销（undo 栈），1 = 已撤销、留作重做（redo 栈）。
  // 以前只在 edit_history 里留「原图备份」，撤销时把记录删掉，撤完就再也回不去 ——
  // 一层撤销。分两栈之后可以连续撤 / 重做，代价只是一列。
  ensureColumn('edit_history', 'undone', 'undone INTEGER NOT NULL DEFAULT 0');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_edit_history_stack ON edit_history(undone, id DESC)');
  // 拍摄地点：EXIF 里的经纬度单独落列（以前只在检查器里现算，地图视图无从索引）。
  // NULL = 没有 GPS（绝大多数截图/网图），不是 0,0 —— 几内亚湾那个点会污染地图。
  ensureColumn('images', 'gps_lat', 'gps_lat REAL');
  ensureColumn('images', 'gps_lon', 'gps_lon REAL');
  // 是否已经为这张图找过 GPS：没有的话，每次点「补算地点」都会把没 GPS 的图重读一遍
  ensureColumn('images', 'gps_checked', 'gps_checked INTEGER NOT NULL DEFAULT 0');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_gps ON images(gps_lat, gps_lon)');
  ensureColumn('images', 'viewed_at', "viewed_at TEXT NOT NULL DEFAULT ''");
  ensureColumn('images', 'view_count', 'view_count INTEGER NOT NULL DEFAULT 0');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_viewed ON images(view_count)');
  ensureColumn('images', 'rating', 'rating INTEGER NOT NULL DEFAULT 0');
  ensureColumn('images', 'note', "note TEXT NOT NULL DEFAULT ''");
  // 视频首尾裁剪区间（秒）：灯箱里拖动裁剪滑块后保存，0 = 未设置。
  // 用幂等 reconcile 补列，不新增迁移版本——老库不备份整个 DB 也能平滑升级。
  ensureColumn('images', 'trim_start', 'trim_start REAL NOT NULL DEFAULT 0');
  ensureColumn('images', 'trim_end', 'trim_end REAL NOT NULL DEFAULT 0');
  // 文件指纹（mtime 秒）：导入时据此跳过内容未变的文件，让二次扫描接近零成本
  ensureColumn('images', 'fs_mtime', 'fs_mtime INTEGER NOT NULL DEFAULT 0');
  // 封面版本号：换/恢复自定义封面只重写缩略图文件、不动原文件，fs_mtime 不会变，
  // 单独用它让缩略图 URL 变化，避免浏览器 7 天强缓存里一直是旧封面
  ensureColumn('images', 'cover_ver', 'cover_ver INTEGER NOT NULL DEFAULT 0');
  // 人脸扫描进度：0 = 还没扫过（含扫过但一张脸都没有的照片，扫完置 1）。
  // 用部分索引只索引「待扫」的行，百万库清空后索引几乎为空，续扫不必全表反连接。
  ensureColumn('images', 'face_scanned', 'face_scanned INTEGER NOT NULL DEFAULT 0');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_face_pending ON images(id) WHERE face_scanned = 0');
  // 文件夹封面：NULL = 自动用夹内最新一张；有值 = 用户手动指定的那一张
  ensureColumn('folders', 'cover_image_id', 'cover_image_id INTEGER');
  // 文件夹标签（Eagle：给文件夹打标签，里面素材自动带上）：只存逗号串，查询期沿路径继承，
  // 不物化进 images.tags —— 物化后「删文件夹标签」得逐张回滚，得不偿失
  ensureColumn('folders', 'tags', "tags TEXT NOT NULL DEFAULT ''");
  // 文件夹外观：emoji / 图标字符 + 主题色（Eagle 允许给文件夹上色，一眼区分用途）
  ensureColumn('folders', 'icon', "icon TEXT NOT NULL DEFAULT ''");
  ensureColumn('folders', 'color', "color TEXT NOT NULL DEFAULT ''");
  // 文件夹内手动排序（拖动定序）：同一张图在不同文件夹可以有不同顺序，所以落在这里而不是 images
  ensureColumn('image_folders', 'sort_order', 'sort_order INTEGER NOT NULL DEFAULT 0');
  // 隐私空间：文件夹密码锁（哈希 + 盐，明文不落库）
  ensureColumn('folders', 'lock_hash', "lock_hash TEXT NOT NULL DEFAULT ''");
  ensureColumn('folders', 'lock_salt', "lock_salt TEXT NOT NULL DEFAULT ''");
  ensureColumn('images', 'dominant', "dominant TEXT NOT NULL DEFAULT ''");
  ensureColumn('images', 'hue', "hue TEXT NOT NULL DEFAULT ''");
  ensureColumn('images', 'palette', "palette TEXT NOT NULL DEFAULT ''");
  // 颜色搜索索引：主色 OKLab 三通道落库，SQL 粗筛 box 下推，避免每次请求全库解析 palette JSON。
  // 以幂等 reconcile 补列（老库不备份整库也能平滑升级），并用后台回填把已存在的 dominant 量化进库。
  ensureColumn('images', 'dominant_l', 'dominant_l REAL');
  ensureColumn('images', 'dominant_a', 'dominant_a REAL');
  ensureColumn('images', 'dominant_b', 'dominant_b REAL');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_domlab ON images(dominant_l, dominant_a, dominant_b)');
  {
    const nullCount = Number(conn.prepare("SELECT COUNT(*) AS c FROM images WHERE dominant_l IS NULL AND dominant <> ''").get()?.c || 0);
    if (nullCount > 0) {
      console.info(`[db] 回填主色 OKLab 索引（约 ${nullCount} 张，仅此一次）…`);
      const upd = conn.prepare('UPDATE images SET dominant_l = ?, dominant_a = ?, dominant_b = ? WHERE id = ?');
      const rows = conn.prepare("SELECT id, dominant FROM images WHERE dominant_l IS NULL AND dominant <> ''").all();
      for (const r of rows) {
        const lab = rgbToOklab(r.dominant);
        if (lab) upd.run(+lab.L.toFixed(4), +lab.a.toFixed(4), +lab.b.toFixed(4), r.id);
      }
      console.info('[db] 主色 OKLab 索引回填完成');
    }
  }
  // 主体哈希（白底抠图+主体包围盒归一化后的 pHash）：全图哈希被白底背景主导导致
  // 不同商品误判相似，主体化后彻底解决；'' = 尚未补算（相似分组退回全图 phash）
  ensureColumn('images', 'obj_phash', "obj_phash TEXT NOT NULL DEFAULT ''");
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_rating ON images(rating)');
  ensureColumn('images', 'pref', 'pref INTEGER NOT NULL DEFAULT 50');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_pref ON images(pref)');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_hue ON images(hue)');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_palette ON images(palette)');

  // —— 素材类型扩展（Eagle 式多格式）——
  // media_kind: image / video / gif / audio / font / pdf / office / model / other
  // 图片以外的素材不走 sharp，缩略图由前端用对应元素渲染，故 thumb 留空。
  ensureColumn('images', 'media_kind', "media_kind TEXT NOT NULL DEFAULT 'image'");
  conn.exec("UPDATE images SET media_kind = 'image' WHERE media_kind = ''");
  /* 老数据迁移：media_kind='image' 但扩展名实际是 3D/视频/音频/PDF/Office/字体/RAW/设计 的，
     修正为正确的 kind —— 早期版本 media_kind 列不存在或不写 model/design/raw，
     用户的 FBX/OBJ 会被当成 image，点开 MediaViewer 就走图片分支打不开。 */
  const NON_IMAGE_KIND_EXTS = [
    { kind: 'video', exts: ['mp4','webm','mov','m4v','mkv','avi','flv','wmv'] },
    { kind: 'gif', exts: ['gif'] },
    { kind: 'audio', exts: ['mp3','wav','flac','aac','ogg','m4a','opus','wma'] },
    { kind: 'font', exts: ['ttf','otf','woff','woff2'] },
    { kind: 'pdf', exts: ['pdf'] },
    { kind: 'office', exts: ['doc','docx','xls','xlsx','ppt','pptx','key','numbers','pages','epub'] },
    { kind: 'model', exts: ['obj','fbx','glb','gltf','stl','blend','3ds','dae','ply'] },
    { kind: 'design', exts: ['psd','psb','ai','eps','sketch','xd','fig','indd','afdesign','afphoto','cdr'] },
    { kind: 'raw', exts: ['cr2','cr3','crw','nef','nrw','arw','sr2','srf','raf','orf','ori','rw2','rwl','pef','srw','dng','3fr','fff','iiq','mos','mef','kdc','dcr','k25','erf','mrw','x3f','gpr'] },
  ];
  for (const { kind, exts } of NON_IMAGE_KIND_EXTS) {
    const cond = exts.map((e) => `LOWER(abs_path) LIKE '%.${e}'`).join(' OR ');
    conn.exec(`UPDATE images SET media_kind='${kind}' WHERE media_kind='image' AND (${cond})`);
  }
  ensureColumn('images', 'duration', 'duration REAL NOT NULL DEFAULT 0');   // 音视频时长（秒），前端读元数据后回写
  ensureColumn('images', 'cover_ts', 'cover_ts REAL NOT NULL DEFAULT 0');    // 自定义封面帧（秒），视频/GIF 用
  // 内容指纹：完全重复检测（pHash 只能找「看起来像」的，MD5 找「字节完全相同」的）
  ensureColumn('images', 'md5', "md5 TEXT NOT NULL DEFAULT ''");
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_md5 ON images(md5)');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_kind ON images(media_kind)');
  // Eagle 素材 id：从 .library 迁移时记下来，重复导入同一个库直接跳过（幂等），
  // 而不是每点一次「开始迁移」就多出一份副本
  ensureColumn('actions', 'conditions', "conditions TEXT NOT NULL DEFAULT ''");
  ensureColumn('images', 'eagle_id', "eagle_id TEXT NOT NULL DEFAULT ''");
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_eagle ON images(eagle_id)');
  // 回收站整行快照（images 行的 JSON）：恢复时要还原 media_kind / rating / note /
  // duration / cover_ts / md5 / fs_mtime 等全部列。只存回收站表那 15 个字段的话，
  // 视频恢复成图片、评分备注丢失、fs_mtime=0 让 ?v=0 的缩略图缓存永不刷新。
  ensureColumn('trash', 'snapshot', "snapshot TEXT NOT NULL DEFAULT ''");

  // 图片堆叠（Eagle 的 Stack）：同一素材的多版本/多裁切合成一组。
  // stack_id = 0 表示没堆叠；否则指向「组主」那张图的 id（组主自己的 stack_id = 自己的 id）。
  // 列表默认只显示组主，成员在灯箱里展开 —— 否则同素材几个版本会把网格占满。
  ensureColumn('images', 'stack_id', 'stack_id INTEGER NOT NULL DEFAULT 0');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_stack ON images(stack_id)');
  // 使用统计：复制 / 导出次数（Eagle 详情里能看到「用过几次」，也便于找出从没用过的素材）
  ensureColumn('images', 'copy_count', 'copy_count INTEGER NOT NULL DEFAULT 0');
  ensureColumn('images', 'export_count', 'export_count INTEGER NOT NULL DEFAULT 0');
  ensureColumn('images', 'last_used_at', "last_used_at TEXT NOT NULL DEFAULT ''");
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_last_used ON images(last_used_at)');

  // 人脸质量（0..1）/ 正面程度（0..1）/ 排除标记：
  // quality、frontal 为 -1 表示老数据未评估，扫描或「清理模糊人脸」后回填；
  // hidden: 0 正常、1 低质量自动排除（不聚类/不当封面/不显示）、2 用户手动保留。
  ensureColumn('faces', 'quality', 'quality REAL NOT NULL DEFAULT -1');
  ensureColumn('faces', 'frontal', 'frontal REAL NOT NULL DEFAULT -1');
  ensureColumn('faces', 'hidden', 'hidden INTEGER NOT NULL DEFAULT 0');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_faces_quality ON faces(person_id, hidden, quality)');

  // 封面脸的原图像素短边：0 表示「这个人没有够格当封面的清晰脸」。
  // 存成列而不是每次 JOIN images 现算，是因为人物列表按它做筛选（默认只列有清晰封面的），
  // 2241 个人物乘一次 JOIN 足够卡顿，而它只在聚簇重算/清理时变一次。
  ensureColumn('persons', 'cover_px', 'cover_px REAL NOT NULL DEFAULT 0');

  // 用户手动指定的封面：1 = 锁住，聚类重算 / 清理 / 扫描新增都不许再自动换人。
  // 不加这一列的话，手动选了一张「不够清晰但好看」的封面，下一次扫描就会被 coverRank 顶掉，
  // 用户会以为「设封面」这个功能根本没生效。
  ensureColumn('persons', 'cover_locked', 'cover_locked INTEGER NOT NULL DEFAULT 0');

  // abs_path 唯一索引：watch 防抖回调与手动 rescan 可能同时进入，两边都判「不存在」就各插一条。
  // 老库里若已经有重复路径，唯一索引建不起来 —— 不阻断启动，但状态要能被界面读到（见 getPathIndexState）。
  createPathIndex(conn);

  // hue 由单列整数改为多值文本（逗号分隔，最多 3 个色系；空串 = 黑白灰）。
  {
    const hueCol = conn.prepare("SELECT name, type FROM pragma_table_info('images') WHERE name='hue'").get();
    if (hueCol && /INT/i.test(hueCol.type || '')) {
      conn.exec("ALTER TABLE images ADD COLUMN hue_txt TEXT NOT NULL DEFAULT ''");
      conn.exec("UPDATE images SET hue_txt = CASE WHEN hue IS NULL OR hue < 0 THEN '' ELSE CAST(hue AS TEXT) END");
      conn.exec('DROP INDEX IF EXISTS idx_images_hue');
      let stepError = '';
      try {
        conn.exec('ALTER TABLE images DROP COLUMN hue');
        conn.exec('ALTER TABLE images RENAME COLUMN hue_txt TO hue');
      } catch (err) {
        // 老 SQLite 不支持 DROP COLUMN：退化为「改名让位」两步走
        const firstError = String(err?.message || err).slice(0, 160);
        try {
          conn.exec('ALTER TABLE images RENAME COLUMN hue TO hue_old');
          conn.exec('ALTER TABLE images RENAME COLUMN hue_txt TO hue');
          stepError = '';
        } catch (err2) {
          // 两步都失败时把前后两条错误一起留下来，别只报最后一条
          stepError = `${firstError}；随后 ${String(err2?.message || err2).slice(0, 160)}`;
        }
      }
      // 不假设「没抛错就等于改对了」：直接查表结构，改不动就明确记一条结构告警
      const type = conn.prepare("SELECT type FROM pragma_table_info('images') WHERE name = 'hue'").get()?.type || '';
      const leftover = conn.prepare("SELECT 1 AS x FROM pragma_table_info('images') WHERE name = 'hue_txt'").get();
      if (/INT/i.test(String(type)) || leftover) {
        noteSchemaWarning(
          `hue 列迁移未完成（当前类型 ${type || '未知'}${leftover ? '，仍残留 hue_txt' : ''}${stepError ? `；${stepError}` : ''}），颜色筛选结果可能不正确`
        );
      }
      try {
        conn.exec('CREATE INDEX IF NOT EXISTS idx_images_hue ON images(hue)');
      } catch (err) {
        noteSchemaWarning(`hue 索引建立失败（${String(err?.message || err).slice(0, 120)}），颜色筛选会变慢`);
      }
    }
  }

  // 倒排表空但 images 有标签时（老库首次升级）一次性重建。
  // 只探「有没有」，不要 count(*)：每次切库都全表扫一遍上万行，大库上是白花的几百毫秒
  const need = conn.prepare("SELECT 1 AS x FROM images WHERE tags <> '' LIMIT 1").get() ? 1 : 0;
  const have = conn.prepare('SELECT 1 AS x FROM item_tags LIMIT 1').get() ? 1 : 0;
  if (need > 0 && have === 0) {
    conn.prepare('DELETE FROM item_tags').run();
    const rows = conn.prepare("SELECT id, tags FROM images WHERE tags <> ''").all();
    const ins = conn.prepare('INSERT OR IGNORE INTO item_tags(tag, image_id) VALUES (?, ?)');
    for (const r of rows) {
      for (const t of String(r.tags).split(',')) {
        const tag = t.trim();
        if (tag) ins.run(tag, r.id);
      }
    }
  }

  // FTS5 全文索引（trigram 中文子串匹配）：>=3 字查询走索引；短词（1-2 字）由查询层回退 LIKE
  try {
    conn.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(title, tags, keyword, note, tokenize='trigram')"
    );
    conn.exec(`
CREATE TRIGGER IF NOT EXISTS trg_fts_insert AFTER INSERT ON images BEGIN
  INSERT INTO images_fts(rowid, title, tags, keyword, note) VALUES (NEW.id, NEW.title, NEW.tags, NEW.keyword, NEW.note);
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_delete AFTER DELETE ON images BEGIN
  DELETE FROM images_fts WHERE rowid = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_update AFTER UPDATE OF title, tags, keyword, note ON images BEGIN
  DELETE FROM images_fts WHERE rowid = OLD.id;
  INSERT INTO images_fts(rowid, title, tags, keyword, note) VALUES (NEW.id, NEW.title, NEW.tags, NEW.keyword, NEW.note);
END;
`);
    // 存量库迁移：旧触发器用 FTS5 'delete' 命令语法（INSERT INTO images_fts(images_fts,...)
    // VALUES ('delete', ...)），本 node:sqlite 版本对常规 FTS5 表稳定报 SQL logic error ——
    // 表现为删除图片 / 修改标题标签时整个语句失败。检测到旧写法就 DROP 并按新版重建
    // （CREATE TRIGGER IF NOT EXISTS 对已存在的旧触发器不会生效，必须显式升级）。
    const isLegacyFtsTrigger = (name) => {
      const row = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name);
      return Boolean(row && /'delete'/i.test(row.sql));
    };
    if (isLegacyFtsTrigger('trg_fts_insert') || isLegacyFtsTrigger('trg_fts_delete') || isLegacyFtsTrigger('trg_fts_update')) {
      conn.exec('DROP TRIGGER IF EXISTS trg_fts_insert; DROP TRIGGER IF EXISTS trg_fts_delete; DROP TRIGGER IF EXISTS trg_fts_update;');
      conn.exec(`
CREATE TRIGGER trg_fts_insert AFTER INSERT ON images BEGIN
  INSERT INTO images_fts(rowid, title, tags, keyword, note) VALUES (NEW.id, NEW.title, NEW.tags, NEW.keyword, NEW.note);
END;
CREATE TRIGGER trg_fts_delete AFTER DELETE ON images BEGIN
  DELETE FROM images_fts WHERE rowid = OLD.id;
END;
CREATE TRIGGER trg_fts_update AFTER UPDATE OF title, tags, keyword, note ON images BEGIN
  DELETE FROM images_fts WHERE rowid = OLD.id;
  INSERT INTO images_fts(rowid, title, tags, keyword, note) VALUES (NEW.id, NEW.title, NEW.tags, NEW.keyword, NEW.note);
END;`);
    }
    // 回填：FTS 空但 images 有数据时（老库首次升级）一次性构建。
    // 同样只探测存在性 —— COUNT(*) 在 FTS5 上要遍历整个索引，1.8 万文档就是秒级，
    // 而这段代码每次切库都会跑到
    const ftsEmpty = !conn.prepare('SELECT rowid FROM images_fts LIMIT 1').get();
    const hasImg = Boolean(conn.prepare('SELECT id FROM images LIMIT 1').get());
    if (ftsEmpty && hasImg) {
      conn.exec(
        'INSERT INTO images_fts(rowid, title, tags, keyword, note) SELECT id, title, tags, keyword, note FROM images'
      );
    }
  } catch (err) {
    console.error('[fts] FTS5 初始化失败（搜索退回 LIKE）:', err?.message || err);
  }
}

/**
 * 库内建表 + 触发器 + 结构迁移。对每个打开的库连接执行一遍。
 * 必须在迁移事务内调用（由 migrate.js 的 initLibrarySchema 负责）。
 *
 * 顺序固定：建表 → 注册 SQL 函数 → 建触发器 → 补列/补索引/回填。
 */
export function installLibrarySchema(conn) {
  conn.exec(LIBRARY_SCHEMA_SQL);
  registerTriggerFunctions(conn);
  conn.exec(LIBRARY_TRIGGER_SQL);
  reconcileColumns(conn);
}
