// @ts-check
/**
 * 人脸模块的路径常量与阈值。
 *
 * 拆模块前这些都写在 face.js 顶部；现在只留这一份定义，下载中心（model-registry）、
 * 检测、聚类都 import 同一份，绝不允许另抄 —— 抄一份就会出现「下载中心按 17MB、
 * 推理按别的门槛」这种两边各说各话的坑。
 */
import path from 'node:path';
import { DATA_DIR } from '../config.js';

/** 路径常量对外导出：下载中心要按同一份定义算体积与删除，不能另抄一份 */
export const FACE_DIR = path.join(DATA_DIR, 'ai', 'face');
export const DET_FILE = path.join(FACE_DIR, 'det_10g.onnx');
export const REC_FILE = path.join(FACE_DIR, 'w600k_r50.onnx');
export const REPO = 'public-data/insightface';
export const MIRRORS = ['https://hf-mirror.com/', 'https://huggingface.co/'];
export const DET_KEY = `${REPO}/models/buffalo_l/det_10g.onnx`;
export const REC_KEY = `${REPO}/models/buffalo_l/w600k_r50.onnx`;

export const DET_SIZE = 640; // SCRFD 固定输入
export const ARC_SIZE = 112; // ArcFace 固定输入
export const DIM = 512;
export const DET_THRESH = 0.5;
export const NMS_IOU = 0.4;
/**
 * 同一人的余弦阈值默认值。
 * w600k_r50 在通用基准上 0.4 左右开始出现「把路人并成同一个人」，而同一人换角度可能掉到
 * 0.45 附近 —— 这是唯一一个没有标准答案的参数，所以做成扫描时可调，默认取偏严的 0.42。
 */
export const MATCH_COS = 0.42;
/**
 * 建新人物的门槛（「高置信种子」）：只有检测分足够高的脸才有资格开一个新人物。
 * 后脑勺/耳朵/半张脸这类伪造检测的检测分中位数只有 0.58（真实库 562 张脸的簇），
 * 它们没有资格当种子；一张 0.55 分的脸只能「加入」已有的人，不能「自立门户」。
 */
export const SEED_SCORE = 0.75;
export const SEED_QUALITY = 0.5;
/** 加入已有人的余弦下限（比质心门槛略松，但配同图排他与簇健康度），扫描与重建共用 */
export const JOIN_COS = 0.45;
/** 簇健康度：一簇脸的平均检测分低于此值且规模够大，判定为「垃圾簇」整体解散 */
export const HEALTH_MIN_SCORE = 0.68;
export const HEALTH_MIN_COUNT = 15;

/** 人脸框短边（原图像素）。width/height 缺失时按工作分辨率 1600 估算，只为排序不至于退化。 */
export const FACE_PX_EXPR = 'MIN((f.x2 - f.x1) * COALESCE(i.width, 1600), (f.y2 - f.y1) * COALESCE(i.height, 1600))';
/** 检测分辨率上限：再大也只是喂给 640 的模型，白白多花解码时间 */
export const WORK_MAX = 1600;
/** 单张图最多取的人脸数：合影够用，也防极端图把一次扫描拖死 */
export const MAX_FACES = 24;
