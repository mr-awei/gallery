/**
 * 跨域的数据形状：人脸、以图搜索、拼接模板。
 * 与 types.ts 的区别是它只被少数几个域模块用到。
 */
export interface FaceStatus {
  downloaded: boolean;
  downloading: boolean;
  progress: number;
  message: string;
  error: string;
  cancelled: boolean;
  model: string;
  size: number;
  /** true = 两个权重都与随包可信哈希一致 */
  verified: boolean;
  persons: number;
  faces: number;
  /** 还没扫过的图片数 */
  pending: number;
  /** 被自动排除的低质量脸数量（模糊 / 太小 / 后脑勺） */
  hiddenFaces?: number;
  /** 封面脸不够清晰的人物数（默认折叠在「全部人物」里） */
  weakCoverPersons?: number;
  /** 服务端「不够清晰」判定线，界面只用来显示，不自己算 */
  softQuality?: number;
  /** 还没有质量分的老数据数量（点「清理」后回填） */
  unassessedFaces?: number;
  scanning: boolean;
  /** 本次扫描实际使用的同人余弦阈值 */
  matchCos: number;
  /** 后台「清理模糊人脸并重选封面」任务 */
  cleaning?: boolean;
  cleanDone?: number;
  cleanTotal?: number;
  cleanHidden?: number;
  /** 已排除的按原因分类计数：模糊 / 人脸过小 / 几乎没有纹理 / 非正面 / 清晰度不足 */
  cleanReasons?: Record<string, number>;
  cleanMessage?: string;
  cleanError?: string;
  /** 后台「重建人物分组」任务（只重算聚类与封面，不解码图片） */
  rebuilding?: boolean;
  rebuildDone?: number;
  rebuildTotal?: number;
  rebuildMessage?: string;
  rebuildError?: string;
  /** 实际生效的质量门槛（界面如实显示，避免与后端不一致） */
  qualityGates?: {
    LAP_REJECT: number;
    LAP_CLUSTER: number;
    LAP_FULL: number;
    FACE_PX_MIN: number;
    FACE_PX_CLUSTER: number;
    STD_MIN: number;
    FRONTAL_MIN: number;
    FRONTAL_CLUSTER: number;
    COVER_PX_MIN?: number;
    COVER_Q_MIN?: number;
    COVER_SCORE_MIN?: number;
    SCORE_CLUSTER?: number;
  };
}

export interface FacePerson {
  id: number;
  name: string;
  /** 人脸数（同一张合影里出现两次会算两条） */
  count: number;
  /** 去重后的照片数 —— 界面上一律写「N 张照片」，别再拿人脸数当张数 */
  photoCount?: number;
  coverFaceId: number | null;
  /** 封面脸所在照片 id：人像照片墙据此标「当前封面」 */
  coverImageId?: number | null;
  /** 用户手动指定过封面（自动挑选不会再覆盖它） */
  coverLocked?: boolean;
  /** 封面脸在原图里的短边像素；0 表示这个人没有够格当封面的清晰脸 */
  coverPx?: number;
  /** 封面脸的质量分（低分说明这个人暂时没有清晰正脸） */
  coverQuality?: number;
}

/** 全网以图搜图的引擎 */
export interface ReverseEngine {
  id: string;
  name: string;
  /** cn = 国内，global = 国外（要过国际网络） */
  region: 'cn' | 'global';
  /** upload = 服务端真上传；manual = 只能打开识图页由用户粘贴 */
  mode: 'upload' | 'manual';
  desc: string;
  /** manual 档的识图页地址 */
  url?: string;
  /** manual 档为什么不支持代传（界面上原样显示，不糊弄） */
  why?: string;
  /** upload 档在国际网络不通时为 false */
  ready: boolean;
  reason: string;
}

export interface ReverseNetworkProbe {
  ok: boolean;
  ms: number;
  error: string;
}

/** 国际网络体检结果（按引擎分别给，前端提示「哪几个国外引擎这次用不了」） */
export interface ReverseNetwork {
  ok: boolean;
  engines: Record<string, ReverseNetworkProbe>;
  checkedAt: number;
}

/** SauceNAO 这类能解析出候选的引擎返回的命中条目 */
export interface ReverseHit {
  similarity: number;
  title: string;
  detail: string;
  thumb: string;
  link: string;
}

export interface ReverseEngineResult {
  engine: string;
  name: string;
  region: 'cn' | 'global';
  /** url = 采集来的图有公网地址，直接拿地址去搜（不用上传、也不用粘剪贴板） */
  mode: 'upload' | 'manual' | 'url';
  ok: boolean;
  /** 结果页 / 识图页地址 */
  url?: string;
  /** 引擎侧预览图（Yandex 上传后的托管地址） */
  previewUrl?: string;
  note?: string;
  /** manual 档：前端要先把图片放进剪贴板 */
  needsClipboard?: boolean;
  results?: ReverseHit[];
  error?: string;
}

export interface ReverseSearchResponse {
  ok: boolean;
  image: { id: number; title: string; width: number; height: number };
  personId: number | null;
  picked: { faceId: number; imageId: number; quality: number; facePx: number } | null;
  bytes: number;
  results: ReverseEngineResult[];
}

/* ------------------------------ 拼图模板 ------------------------------ */
/** 文字层规格：y / size 都是画布归一化值，与输出像素无关 */
export interface StitchTextSpec {
  y: number;
  size: number;
  weight?: number;
  tracking?: number;
  color?: string;
  align?: string;
  upper?: boolean;
}

/** 拼图模板：画布比例 + 若干归一化矩形 + 文字层位置（服务端 stitch-templates.js） */
export interface StitchTemplate {
  id: string;
  name: string;
  hint: string;
  ratio: string;
  min: number;
  max: number;
  /** [x, y, w, h] 归一化，长度即格数 */
  slots: number[][];
  pad?: number;
  radius?: number;
  shadow?: number;
  border?: number;
  borderSlots?: number[];
  backdrop?: boolean;
  band?: number;
  bg?: string;
  /** 格子之间的基础缝（按画布短边归一化） */
  gap?: number;
  /** 模板本身就是无缝排法（长图、三联画…）：不允许再被留白/圆角打断 */
  seamless?: boolean;
  title?: StitchTextSpec;
  sub?: StitchTextSpec;
  billing?: StitchTextSpec;
  masthead?: StitchTextSpec;
  sprocket?: boolean;
}

/** 一格的构图：焦点（0~1 归一化）+ 缩放（1~4，1 = 刚好铺满） */
export interface StitchCrop {
  fx: number;
  fy: number;
  z: number;
}
