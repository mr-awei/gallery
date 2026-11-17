// @ts-check
/**
 * 人脸模块的**可变单例状态**。
 *
 * 拆模块前这些都是 face.js 的模块级变量：下载进度、扫描/清理/重建三个后台任务的运行状态，
 * 以及本次扫描实际使用的余弦阈值。写的人和读的人必须看到同一个对象（status 接口要如实汇报），
 * 所以统一放这里由各职责模块共用；谁都不许自己再 new 一份状态。
 */
import { MATCH_COS } from './constants.js';

/** 模型下载状态：model.js 写，status.js 读 */
export const modelState = { downloading: false, progress: 0, message: '', error: '', cancelled: false };

/** 下载取消句柄（AbortController 由 model.js 创建与释放） */
let installAbort = null;

export function getInstallAbort() {
  return installAbort;
}

/** @param {AbortController|null} ctrl */
export function setInstallAbort(ctrl) {
  installAbort = ctrl;
}

/** 本次扫描实际使用的阈值（状态接口如实返回，避免界面显示默认值而实际跑的是别的） */
let activeCos = MATCH_COS;

export function getActiveCos() {
  return activeCos;
}

/** @param {number} cos */
export function setActiveCos(cos) {
  activeCos = cos;
}

/** 全库扫描任务状态 */
export const scanState = { running: false, cancelled: false, jobId: 0 };

/** 「清理模糊人脸 / 重选封面」后台任务状态，随 faceStatus 轮询推给前端 */
export const cleanState = {
  running: false,
  cancelled: false,
  done: 0,
  total: 0,
  hidden: 0,
  /** 各硬门槛命中数，界面如实说明「为什么排除」（模糊/过小/无纹理/过曝/非正面） */
  reasons: { 模糊: 0, 人脸过小: 0, 几乎没有纹理: 0, 过曝: 0, 欠曝: 0, '非正面/疑似后脑勺': 0 },
  message: '',
  error: '',
};

/** 「重建人物分组」后台任务状态 */
/** @type {{running:boolean, cancelled:boolean, done:number, total:number, message:string, error:string}} */
export const rebuildState = { running: false, cancelled: false, done: 0, total: 0, message: '', error: '' };
