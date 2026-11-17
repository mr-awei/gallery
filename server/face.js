// @ts-check
/**
 * 人脸检测 + 特征提取（SCRFD det_10g + ArcFace w600k_r50），纯本地 ONNX 推理。
 *
 * 本文件只剩**门面**：对外保持原有的具名导出不变（routes/face.js、jobs.js、
 * lib/model-registry.js、reverse.js 都按名字 import），实现按职责拆到 server/face/ 下：
 *
 * - face/constants.js  路径常量与全部阈值（唯一一份定义）
 * - face/state.js      可变单例状态（下载进度、三件后台任务、本次扫描阈值）
 * - face/model.js      模型下载/校验/删除 + **惰性单例 ONNX 会话**（整进程只此一份）
 * - face/detect.js     预处理、检测、对齐、512 维特征、质量评估、analyzeImage
 * - face/cluster.js    增量聚类缓存（personCache 单例）、质心/封面维护、rebuildPerson
 * - face/scan.js       全库扫描任务
 * - face/cleanup.js    存量人脸质量重算 / 重选封面
 * - face/rebuild.js    人物分组全局重建
 * - face/store.js      人物与人脸的查询、封面、合并、改派、删除、裁切图
 * - face/status.js     faceStatus() 状态汇总
 *
 * 为什么是这两个模型：SCRFD 是少数「检测框 + 5 点关键点」一次出全的模型，
 * ArcFace 的 512 维特征在余弦空间里可分性稳定，两项都是工业界通用件，
 * 且权重只 ~191MB（det 16.9MB + rec 174MB），比整套 insightface 包（288MB）省。
 *
 * 关键约束：
 * - 权重必须过 server/model-pins.json 的可信哈希清单，装/加载前都复核（被替换直接报错）；
 * - 推理跑在 HTTP 主进程，但每张图之间 setImmediate 让出事件循环，避免扫库时把接口卡死；
 * - 进度落 jobs 表（kind='face-scan'），可取消、可重试、崩了能看出停在哪。
 */
import { faceStatus } from './face/status.js';
import { installModels, removeModels } from './face/model.js';
import { modelState } from './face/state.js';

/** 路径常量：下载中心要按同一份定义算体积与删除，不能另抄一份 */
export { FACE_DIR, DET_FILE, REC_FILE, DET_KEY, REC_KEY } from './face/constants.js';

export { faceStatus } from './face/status.js';
export { cancelFaceInstall } from './face/model.js';
export { analyzeImage } from './face/detect.js';
export { rebuildPerson } from './face/cluster.js';
export { cancelFaceScan, startFaceScan } from './face/scan.js';
export { cancelQualityCleanup, startQualityCleanup } from './face/cleanup.js';
export { cancelPersonRebuild, personRebuildStatus, startPersonRebuild } from './face/rebuild.js';
export {
  bestPhotoForPerson,
  countPersons,
  countWeakCoverPersons,
  deleteFace,
  deletePerson,
  faceCrop,
  facesOfImage,
  getPerson,
  listPersons,
  mergePersons,
  personImages,
  reassignFace,
  renamePerson,
  resetFaces,
  setFaceHidden,
  setPersonCover,
} from './face/store.js';

/**
 * 启动模型下载（不等待）：立即返回当前状态，进度由前端轮询 faceStatus 看。
 * 状态取自与 model.js 共用同一个 modelState，不会出现两套进度。
 */
export function startFaceInstall() {
  if (modelState.downloading) return { ok: true, started: false, ...faceStatus() };
  installFaceModels().catch((err) => {
    console.warn('[face] 模型安装失败：', err?.message || err);
  });
  return { ok: true, started: true, ...faceStatus() };
}

/** 下载两个权重；返回值是安装后的完整状态（下载本体在 model.js） */
export async function installFaceModels() {
  await installModels();
  return faceStatus();
}

/** 删除两个权重；返回删除后的状态 */
export async function removeFaceModels() {
  await removeModels();
  return faceStatus();
}
