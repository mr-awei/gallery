import { useCallback, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { api } from '../api';
import type { LoadGallery, Toast } from './types';

export type ImportProgress = {
  progress: number;
  saved: number;
  total?: number;
  unchanged?: number;
  message?: string;
} | null;

/**
 * 导入进度：状态 + 「跟随轮询」兜底。
 *
 * 这里刻意**不放 effect**：importingRef 的同步 effect 留在 App 里原来的位置，
 * 保证拆分前后所有 effect 的注册顺序一字不差（它只写 ref，但位置也别乱动）。
 */
export function useImportWatch({
  showToast,
  refreshStats,
  load,
  pageRef,
  importingRef,
}: {
  showToast: Toast;
  refreshStats: () => void;
  load: LoadGallery;
  pageRef: MutableRefObject<number>;
  importingRef: MutableRefObject<boolean>;
}) {
  const [importing, setImporting] = useState(false);
  // 导入进度（图库空态/顶部提示用）：progress 0-100，saved 为已入库张数，message 为任务名
  const [importProgress, setImportProgress] = useState<ImportProgress>(null);
  /** 导入是否正处于「进行中」（用于在结束那一刻只提示一次深度截断） */
  const wasImportingRef = useRef(false);

  /**
   * 选文件夹后的「导入跟随」：主动轮询导入状态直到结束，期间每 1.2s 刷新一次列表。
   * 作为 SSE 事件的可靠兜底 —— 真实运行环境（尤其 Electron）在导入的 CPU 密集期，
   * SSE 心跳可能超时断连、丢失中间 library 事件，前端停在断连前的张数不再前进。
   * 轮询直接查 importStatus + stats，不依赖任何推送，确保图库持续自动展示。
   */
  const followRunningRef = useRef(false);
  const followImport = useCallback(async () => {
    // 单实例：库事件 / 建库 / 切库可能连着触发多次 followImport，并发多路
    // 轮询只会放大请求量（每路约 2.5 req/s），后到的直接让路 —— 在跑的这路
    // 每轮都会拉最新的 importStatus，自然覆盖新触发的场景
    if (followRunningRef.current) return;
    followRunningRef.current = true;
    try {
      // 首次观察到「未在运行」时不急着收尾：切库时旧库的扫描被叫停后，
      // 新库的扫描是排队补跑的，可能晚几百毫秒才置 running，需要再确认一次
      let confirmed = false;
      for (let i = 0; i < 240; i++) {
        let status;
        try {
          status = await api.importStatus();
        } catch {
          return;
        }
        if (status.running) {
          confirmed = true;
          setImporting(true);
          setImportProgress({
            progress: Number(status.progress) || 0,
            saved: Number(status.result?.saved) || 0,
            total: Number(status.result?.total) || 0,
            unchanged: Number(status.result?.unchanged) || 0,
            message: status.message || '',
          });
          refreshStats(); // 内含库增长对账：stats.total 变大则 load(1, true)
        } else if (!confirmed) {
          confirmed = true;
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        } else {
          setImporting(false);
          setImportProgress(null);
          refreshStats();
          // 扫描崩溃不能静默收尾：以前只在 importState 里留一句话，界面上就是
          // 「库是空的、也没有任何提示」，用户只能以为图丢了。
          if (status.error) {
            showToast(`扫描失败：${status.error}（可到 设置 → 数据维护 重新扫描）`, 'error');
          }
          // 收尾强制重载一次：若导入在最后一次对账后才落库，列表会停在旧张数
          pageRef.current = 1;
          load(1, true);
          return;
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      refreshStats();
    } finally {
      followRunningRef.current = false;
    }
  }, [refreshStats, load, showToast, pageRef]);

  return {
    importing,
    setImporting,
    importProgress,
    setImportProgress,
    wasImportingRef,
    followImport,
  };
}
