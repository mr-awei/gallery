/**
 * CLIP 相似搜索 worker：CPU 密集的全库扫描不占 HTTP 主线程。
 * 只接收候选桶路径 + 查询向量，按块读磁盘；向量索引本体不进主线程内存。
 */
import { parentPort } from 'node:worker_threads';
import { scanBuckets } from './lib/clip-scan.js';

parentPort.on('message', (job) => {
  const { seq, payload } = job;
  try {
    parentPort.postMessage({ seq, ok: true, hits: scanBuckets(payload) });
  } catch (err) {
    parentPort.postMessage({ seq, ok: false, error: String(err?.message || err) });
  }
});
