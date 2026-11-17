// @ts-check
/**
 * 人脸模块的状态汇总接口：一次把模型、人物、四个后台任务的状态给前端。
 *
 * 这里只读不写，读的全是各模块的同一份单例状态（state.js 的模型/任务状态、
 * model.js 的文件体积、cluster 的封面统计），所以不会出现「界面显示默认阈值，
 * 实际扫描跑的是另一个」这种两套数据。
 */
import { db } from '../db.js';
import { isPinned } from '../model-fetch.js';
import { QUALITY_GATES, SOFT_QUALITY } from '../lib/face-quality.js';
import { detBytes, recBytes, modelsReady } from './model.js';
import { countWeakCoverPersons } from './store.js';
import { REPO, DET_KEY, REC_KEY } from './constants.js';
import { modelState, scanState, cleanState, rebuildState, getActiveCos } from './state.js';

export function faceStatus() {
  let persons = 0;
  let faces = 0;
  let pending = 0;
  let hiddenFaces = 0;
  let unassessedFaces = 0;
  let weakCoverPersons = 0;
  try {
    persons = Number(db.prepare('SELECT COUNT(*) AS c FROM persons WHERE count > 0').get()?.c) || 0;
    faces = Number(db.prepare('SELECT COALESCE(SUM(count), 0) AS c FROM persons').get()?.c) || 0;
    // 只数「待扫」：face_scanned 上建了部分索引，这个计数不会全表扫（已扫完时索引为空）
    pending = Number(db.prepare('SELECT COUNT(*) AS c FROM images WHERE face_scanned = 0').get()?.c) || 0;
    hiddenFaces = Number(db.prepare('SELECT COUNT(*) AS c FROM faces WHERE hidden = 1').get()?.c) || 0;
    unassessedFaces = Number(db.prepare('SELECT COUNT(*) AS c FROM faces WHERE quality < 0').get()?.c) || 0;
    weakCoverPersons = countWeakCoverPersons();
  } catch {
    /* 老库还没迁移完时不该让状态接口 500 */
  }
  return {
    downloaded: modelsReady(),
    downloading: modelState.downloading,
    progress: modelState.progress,
    message: modelState.message,
    error: modelState.error,
    cancelled: modelState.cancelled,
    model: REPO,
    size: detBytes() + recBytes(),
    /**
     * true = 两个权重都与随包清单一致（可信）；
     * false = 没下载，或只是与本机 sidecar 自洽，不能对外宣称「校验通过」。
     */
    verified: isPinned(DET_KEY) && isPinned(REC_KEY),
    persons,
    faces,
    pending,
    hiddenFaces,
    unassessedFaces,
    /** 封面脸不够清晰的人物数：人物页默认折叠这部分（可一键切回「全部」） */
    weakCoverPersons,
    /** 「不够清晰」判定线，前端只用于显示说明，不自己算 */
    softQuality: SOFT_QUALITY,
    scanning: scanState.running,
    matchCos: getActiveCos(),
    cleaning: cleanState.running,
    cleanDone: cleanState.done,
    cleanTotal: cleanState.total,
    cleanHidden: cleanState.hidden,
    cleanReasons: { ...cleanState.reasons },
    cleanMessage: cleanState.message,
    cleanError: cleanState.error,
    /** 「重建人物分组」后台任务：只重算聚类与封面，不解码图片 */
    rebuilding: rebuildState.running,
    rebuildDone: rebuildState.done,
    rebuildTotal: rebuildState.total,
    rebuildMessage: rebuildState.message,
    rebuildError: rebuildState.error,
    qualityGates: QUALITY_GATES,
  };
}
