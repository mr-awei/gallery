/**
 * 库结构层的可变状态。单独成一个叶子模块（不 import 任何东西），
 * 让 db.js / schema.js 都能读写同一份状态而互不形成循环。
 */

/**
 * 结构层面的「修失败了但还能跑」的状态。
 * 这类问题以前一律裸 catch 吞掉：界面照常打开，只是颜色筛选/计数悄悄不准。
 * 现在收集起来，由「数据与维护 → 库健康」展示，重启或下一个版本可据此排查。
 */
let schemaWarnings = [];

export function getSchemaWarnings() {
  return schemaWarnings.slice();
}

/** 每次 open（含切库）重置：告警只描述「当前这个库」的状态 */
export function resetSchemaWarnings() {
  schemaWarnings = [];
}

export function noteSchemaWarning(msg) {
  if (!schemaWarnings.includes(msg)) schemaWarnings.push(msg);
  console.warn('[db]', msg);
}

/**
 * abs_path 唯一索引的健康状态。
 * 老库里若已有重复路径，建唯一索引会失败 —— 以前只 console.warn，用户永远看不到，
 * 于是「一图一记录」这个前提在没有任何保障的情况下继续用（并发 watch + rescan 仍可能插两条）。
 * 现在把状态暴露给「数据与维护」，并提供清理后的补建入口。
 */
let pathIndexState = { ok: true, duplicates: 0, error: '' };

export function getPathIndexState() {
  return { ...pathIndexState };
}

export function setPathIndexState(next) {
  pathIndexState = { ...next };
}
