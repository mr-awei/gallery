/**
 * 库内建表 / 索引 / 触发器的 DDL 原文。
 *
 * 只 import 叶子模块 foreign-keys.js（它不 import 任何东西），不会与 db.js 成环。
 *
 * 顺序有硬约束（历史踩过的坑）：
 * - 本文件在「逐列探测补列（ensureColumn）」之前执行，所以**不能**把依赖后加列的索引
 *   写进 LIBRARY_SCHEMA_SQL —— 老库此时还没有 taken_at 等列，建索引会直接抛
 *   no such column。这类索引统一放在 schema.js 的 reconcile 段、对应补列之后。
 * - LIBRARY_TRIGGER_SQL 依赖三个 SQL 函数（sync_item_tags / delete_item_tags /
 *   delete_image_notes），执行前必须先用 conn.function() 注册（见 schema.js）。
 * - 外键约束统一由 fkTail('表名') 追加：约束清单只放在 foreign-keys.js 一处，
 *   新建库与老库重建（applyForeignKeys）用的是同一份定义，免得两边写法漂移。
 */
import { fkTail } from './foreign-keys.js';

/** 建表 + 索引（不含依赖后加列的索引） */
export const LIBRARY_SCHEMA_SQL = `
-- 库内设置表：除应用级键（主题/首次引导/自启/更新源，见 GLOBAL_SETTING_KEYS）外的
-- 所有设置都存在这里——每个资源库一套独立的采集源、AI、壁纸、网络配置
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  abs_path TEXT NOT NULL,
  thumb TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  keyword TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL DEFAULT '',
  phash TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  -- 拍摄时间（EXIF DateTimeOriginal 优先，取不到时退回文件 mtime / 入库时间）。
  -- 时间线视图按它排序与聚合；空串表示老数据尚未补算（reconcile 会先按 created_at 兜底）。
  taken_at TEXT NOT NULL DEFAULT '',
  viewed_at TEXT NOT NULL DEFAULT '',
  view_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_images_source ON images(source);
CREATE INDEX IF NOT EXISTS idx_images_path ON images(abs_path);
CREATE INDEX IF NOT EXISTS idx_images_favorite ON images(favorite);
CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at);
-- 注意：taken_at 的索引不能写在这里。老库（v3 之前）还没有这一列，
-- 建索引会直接抛 no such column；下面 ensureColumn 加完列之后统一建。

CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER,
  created_at TEXT NOT NULL,
  reasons TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  ai_analysis TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS kb_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  weight INTEGER NOT NULL DEFAULT 12,
  hits INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'user',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  origin_path TEXT NOT NULL,
  trash_path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL DEFAULT '',
  phash TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  deleted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  image_id INTEGER NOT NULL,
  added_at TEXT NOT NULL,
  UNIQUE(playlist_id, image_id)${fkTail('playlist_items')}
);
CREATE INDEX IF NOT EXISTS idx_playlist_items ON playlist_items(playlist_id);

CREATE TABLE IF NOT EXISTS tidy_skip (
  recommend_id INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS wallpaper_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER,
  scope TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_desc (
  image_id INTEGER PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  issues TEXT NOT NULL DEFAULT '',
  quality INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL${fkTail('ai_desc')}
);

CREATE TABLE IF NOT EXISTS clip_vec (
  image_id INTEGER PRIMARY KEY,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  created_at TEXT NOT NULL${fkTail('clip_vec')}
);

-- 人脸：一张图可检出多张脸，每张脸存 512 维归一化特征（ArcFace）。
-- vec 存原始 float32 小端字节（与 clip_vec 一致，不入库量化），对齐后的 112 裁剪按 bbox 现算。
CREATE TABLE IF NOT EXISTS faces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER NOT NULL,
  person_id INTEGER,
  x1 REAL NOT NULL, y1 REAL NOT NULL, x2 REAL NOT NULL, y2 REAL NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  det REAL NOT NULL DEFAULT 0,
  vec BLOB NOT NULL,
  created_at TEXT NOT NULL${fkTail('faces')}
);
CREATE INDEX IF NOT EXISTS idx_faces_image ON faces(image_id);
CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id);

-- 人物：聚类结果。centroid 存归一化质心，增量聚类时不必每次重算全表平均。
CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  cover_face_id INTEGER,
  count INTEGER NOT NULL DEFAULT 0,
  centroid BLOB,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS image_quality (
  image_id INTEGER PRIMARY KEY,
  sharpness REAL NOT NULL,
  created_at TEXT NOT NULL${fkTail('image_quality')}
);

CREATE TABLE IF NOT EXISTS wallpaper_fit (
  image_id INTEGER PRIMARY KEY,
  score INTEGER NOT NULL DEFAULT 60,
  safe_area TEXT NOT NULL DEFAULT 'center',
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'local',
  brightness INTEGER,
  likes INTEGER NOT NULL DEFAULT 0,
  dislikes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL${fkTail('wallpaper_fit')}
);

CREATE TABLE IF NOT EXISTS smart_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  rules TEXT NOT NULL DEFAULT '{}',
  auto_tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 标签倒排表：tags 列是逗号串，LIKE '%x%' 无法走索引（每次筛选全表扫）。
-- 这里拆成一行一 tag，触发器自动同步（含绕过应用层的直接 SQL 写入），查询走主键索引。
CREATE TABLE IF NOT EXISTS item_tags (
  tag TEXT NOT NULL,
  image_id INTEGER NOT NULL,
  PRIMARY KEY (tag, image_id)${fkTail('item_tags')}
);
CREATE INDEX IF NOT EXISTS idx_item_tags_image ON item_tags(image_id);

-- 文件夹树：物化路径（path 含自身 id），点父夹聚合后代用前缀 LIKE 走索引
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  path TEXT NOT NULL DEFAULT '',       -- 祖先路径 + 自身 id，如 '/1/5/9/'
  sort_order INTEGER NOT NULL DEFAULT 0,
  anchor_path TEXT NOT NULL DEFAULT '', -- 对应磁盘目录相对路径；纯虚拟夹为空
  lock_hash TEXT NOT NULL DEFAULT '',    -- 隐私空间：密码哈希（scrypt），空串 = 未加锁
  lock_salt TEXT NOT NULL DEFAULT '',    -- 哈希用盐；明文密码永不落库
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL${fkTail('folders')}
);
CREATE INDEX IF NOT EXISTS idx_folders_path ON folders(path);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

-- 图 ↔ 文件夹 多对多（一张图可属多个文件夹，Eagle 式一图多夹）
CREATE TABLE IF NOT EXISTS image_folders (
  image_id INTEGER NOT NULL,
  folder_id INTEGER NOT NULL,
  PRIMARY KEY (image_id, folder_id)${fkTail('image_folders')}
);
CREATE INDEX IF NOT EXISTS idx_image_folders_folder ON image_folders(folder_id);

-- 标签元数据：分组 / 颜色 / 父标签（层级）/ 手动排序。
-- 标签本体仍是 images.tags 逗号串 + item_tags 倒排，这里只存「展示属性」，
-- 标签被改名/删除/合并时由 lib/tags.js 同步维护，避免出现孤儿元数据。
CREATE TABLE IF NOT EXISTS tag_meta (
  tag TEXT PRIMARY KEY,
  tag_group TEXT NOT NULL DEFAULT '',   -- 分组名（Eagle 的「标签群组」）
  color TEXT NOT NULL DEFAULT '',       -- #rrggbb，空 = 跟随主题
  parent TEXT NOT NULL DEFAULT '',      -- 父标签名，空 = 顶层（Eagle 的「标签层级」）
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ''
);

-- 图片标注：整层存一份 JSON 数组（Eagle 的标注是一张图上的一个可编辑图层，
-- 拆成行反而要处理 z-order / 增删改的批处理，这里按整层读写最简单可靠）。
-- 标签别名 / 同义词：搜「界面」也能命中「ui」。别名不写进 images.tags（单一事实来源不变），
-- 只在查询期展开成正式标签，所以合并/改名时要跟着迁移，否则会留下悬空别名。
CREATE TABLE IF NOT EXISTS tag_alias (
  alias TEXT PRIMARY KEY,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS image_annotations (
  image_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT ''${fkTail('image_annotations')}
);

-- 图片评论：Eagle 4 的图注评论，按时间正序展示
CREATE TABLE IF NOT EXISTS image_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL${fkTail('image_comments')}
);
CREATE INDEX IF NOT EXISTS idx_image_comments_image ON image_comments(image_id);

-- 完全重复检测用的内容指纹按 (size_bytes, md5) 分组，先按大小粗筛再比对哈希
CREATE INDEX IF NOT EXISTS idx_images_size ON images(size_bytes);

-- 编辑历史（覆盖写回前的原文件备份）：
-- 裁切/调色/增强/旋转默认直接覆盖原图且不可逆，这里留一份原始副本支持「撤销」。
-- 只保留最近若干条，避免长期占盘。
CREATE TABLE IF NOT EXISTS edit_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER NOT NULL,
  backup_path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'edit',
  prev_width INTEGER NOT NULL DEFAULT 0,
  prev_height INTEGER NOT NULL DEFAULT 0,
  prev_size INTEGER NOT NULL DEFAULT 0,
  prev_phash TEXT NOT NULL DEFAULT '',
  prev_obj_phash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  -- 0 = 待撤销（undo 栈），1 = 已撤销可重做（redo 栈）
  undone INTEGER NOT NULL DEFAULT 0${fkTail('edit_history')}
);
CREATE INDEX IF NOT EXISTS idx_edit_history_image ON edit_history(image_id, id);

-- 后台任务（采集 / 批量编辑 / 增强 / 模型下载）：
-- 以前这些任务全是内存里的单例，进程一退就没了 —— 既没有历史，也没法重试，
-- 崩了以后连「上次跑到哪」都查不到。这里落表，做历史 + 中断标记 + 重试依据。
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  payload TEXT NOT NULL DEFAULT '{}',
  progress REAL NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_jobs_kind ON jobs(kind, id DESC);

-- 统一操作日志：撤销原先只覆盖「编辑类」（edit_history 的原图备份）。
-- 打标、移动文件夹、删除、回收站恢复、批量导入都不可回滚，误操作只能靠人肉复原。
-- 这里记录每次批量操作的逆操作描述，支持逐条撤销。
CREATE TABLE IF NOT EXISTS op_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  undone INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_op_log_id ON op_log(id DESC);

-- 图片文字识别结果（OCR）：单独成表而不是给 images 加列，
-- 因为一张图的识别文本可能很长，且绝大多数图没有；放主表会拖慢列表扫描。
-- 关键词搜索时用 image_id IN (SELECT ... LIKE) 挂进主查询。
CREATE TABLE IF NOT EXISTS image_ocr (
  image_id INTEGER PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT '',
  engine TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL${fkTail('image_ocr')}
);
CREATE INDEX IF NOT EXISTS idx_image_ocr_created ON image_ocr(created_at);

-- 动作（Actions）：把「打标签 + 归类 + 改名 + AI 描述」这类固定流程存成可复用宏，
-- 对齐 Eagle 4 的「动作」与 Build 22 的 AI Action。steps 是 JSON 数组。
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  -- 执行条件（JSON：{combine:'and'|'or', rules:{...}}），与智能文件夹共用同一套规则语义；
  -- 空串 = 无条件，对选区全量执行
  conditions TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_run_at TEXT NOT NULL DEFAULT ''
);

-- 保存的筛选器：把当前筛选栏（关键词/类型/星级/标签/文件夹…）整套存下来，
-- 侧栏一键回到同一视图。query 存 JSON，不做字段拆分 —— 筛选参数还在演进，
-- 拆成列每次加参数都要迁移，而这里只做整体回放。
CREATE TABLE IF NOT EXISTS saved_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  query TEXT NOT NULL DEFAULT '{}',
  icon TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ''
);

-- 素材笔记：Eagle 式「文字笔记 + 视频时间点笔记」。
-- ts > 0 表示钉在音视频的某个时间点（秒），0 = 纯文本笔记。
-- 单独成表而不是给 images.note 加数组：一张图可以有任意多条带时间的笔记。
CREATE TABLE IF NOT EXISTS image_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  ts REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL${fkTail('image_notes')}
);
CREATE INDEX IF NOT EXISTS idx_image_notes_image ON image_notes(image_id, id);
`;
export const LIBRARY_TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_item_tags_insert AFTER INSERT ON images BEGIN
  SELECT sync_item_tags(NEW.id, NEW.tags);
END;
CREATE TRIGGER IF NOT EXISTS trg_item_tags_update AFTER UPDATE OF tags ON images BEGIN
  SELECT sync_item_tags(NEW.id, NEW.tags);
END;
CREATE TRIGGER IF NOT EXISTS trg_item_tags_delete AFTER DELETE ON images BEGIN
  SELECT delete_item_tags(OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_image_notes_delete AFTER DELETE ON images BEGIN
  SELECT delete_image_notes(OLD.id);
END;
-- 素材被彻底删除时一并清掉人脸记录：否则人物页会一直挂着已删素材的裁切图，
-- 聚类质心也被幽灵向量污染。人物行本身保留（用户可能已改名，宁可空着也不丢名字）。
CREATE TRIGGER IF NOT EXISTS trg_faces_delete AFTER DELETE ON images BEGIN
  DELETE FROM faces WHERE image_id = OLD.id;
END;
-- 同理清掉「图 ↔ 文件夹」关联：以前只有回收站/导入两条路径手工清，
-- 去重回滚与批量淘汰直接 DELETE images 就留下了孤儿 —— 侧栏张数虚高、封面指向已删图。
CREATE TRIGGER IF NOT EXISTS trg_image_folders_delete AFTER DELETE ON images BEGIN
  DELETE FROM image_folders WHERE image_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_image_comments_delete AFTER DELETE ON images BEGIN
  DELETE FROM image_comments WHERE image_id = OLD.id;
END;
-- 向量也要跟着走：去重回滚只删 images 行时，残留向量会让「相似图」把已删素材召回。
CREATE TRIGGER IF NOT EXISTS trg_clip_vec_delete AFTER DELETE ON images BEGIN
  DELETE FROM clip_vec WHERE image_id = OLD.id;
END;
-- 画质分 / 标注 / OCR 同样是 image_id 主键：以前只在业务路径手工清，
-- 去重回滚、批量淘汰、清空回收站这些硬删除会留下孤儿（画质分还会被「整理」页当有效数据读）。
CREATE TRIGGER IF NOT EXISTS trg_image_quality_delete AFTER DELETE ON images BEGIN
  DELETE FROM image_quality WHERE image_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_image_annotations_delete AFTER DELETE ON images BEGIN
  DELETE FROM image_annotations WHERE image_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_image_ocr_delete AFTER DELETE ON images BEGIN
  DELETE FROM image_ocr WHERE image_id = OLD.id;
END;
`;
