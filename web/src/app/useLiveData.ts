import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { api, quiet } from '../api';
import { subscribeEvents } from '../events';
import { installModalA11y } from '../lib/modal-a11y';
import type { ImportProgress } from './useImportWatch';
import type { LoadGallery, Toast } from './types';

type Options = {
  refreshStats: () => void;
  scheduleStatsRefresh: () => void;
  reloadOnIngest: () => void;
  statsThrottleRef: MutableRefObject<number>;
  setImporting: Dispatch<SetStateAction<boolean>>;
  setImportProgress: Dispatch<SetStateAction<ImportProgress>>;
  wasImportingRef: MutableRefObject<boolean>;
  followImport: () => Promise<void>;
  showToast: Toast;
  load: LoadGallery;
  pageRef: MutableRefObject<number>;
};

/**
 * 服务端推送接线（两个 effect，顺序与拆分前一致）：
 * ① 弹窗无障碍 + 统计定时兜底 + library 事件
 * ② job 事件里的导入进度 + 打开页面时补一次 importStatus
 */
export function useLiveData({
  refreshStats,
  scheduleStatsRefresh,
  reloadOnIngest,
  statsThrottleRef,
  setImporting,
  setImportProgress,
  wasImportingRef,
  followImport,
  showToast,
  load,
  pageRef,
}: Options) {
  /** 采集是否正在跑（记录上一次快照，用于在「刚结束」那一刻刷一次列表） */
  const crawlRunningRef = useRef(false);

  useEffect(() => {
    // 弹窗的键盘与无障碍（Esc / 焦点陷阱 / role=dialog）在 document 层统一装一次，
    // 不依赖 25 个弹窗各自记得写 —— 详见 lib/modal-a11y.ts
    installModalA11y();
    refreshStats(); // 首次调用即建立 libTotalRef 基线
    // 服务端写操作会推 library 事件；与 job 推送共用 800ms 节流。
    // 60s 低频兜底覆盖推送遗漏（如多标签页）场景；页面隐藏时不发请求
    const timer = window.setInterval(() => {
      if (!document.hidden) refreshStats();
    }, 60000);
    // source: 'ingest' 是服务端目录监听 / 采集协程自己入库（不走 HTTP，前端没有别的时机知道）
    // → 直接重载列表；其余 library 事件只是写操作的附带通知，交给 stats 对账就够
    const off = subscribeEvents('library', (d) => {
      if (d?.source === 'ingest') reloadOnIngest();
      else scheduleStatsRefresh();
    });
    return () => {
      clearInterval(timer);
      off();
      // 卸载 / 重订阅后，在途的节流回调不能再 setState、也不能再打接口
      if (statsThrottleRef.current) {
        window.clearTimeout(statsThrottleRef.current);
        statsThrottleRef.current = 0;
      }
    };
  }, [refreshStats, scheduleStatsRefresh, reloadOnIngest, statsThrottleRef]);

  useEffect(() => {
    // 导入状态改为订阅 job 事件（原 3s 轮询）；导入进行中顺带刷新统计
    const off = subscribeEvents('job', (d) => {
      // 采集的下载与入库全在后台协程里，前端只在「跑完」这一刻对账一次：
      // 否则用户盯着采集页看进度，切回列表还以为一张新图都没进
      const crawl = d?.crawl;
      if (crawl) {
        if (crawl.running) crawlRunningRef.current = true;
        else if (crawlRunningRef.current) {
          crawlRunningRef.current = false;
          refreshStats();
          if (pageRef.current <= 1) load(1, true);
        }
      }
      const imp = d?.import;
      if (!imp) return;
      setImporting(!!imp.running);
      if (imp.running) {
        wasImportingRef.current = true;
        setImportProgress({
          progress: Number(imp.progress) || 0,
          saved: Number(imp.result?.saved) || 0,
          total: Number(imp.result?.total) || 0,
          unchanged: Number(imp.result?.unchanged) || 0,
          message: imp.message || '',
        });
        // 进度快照每秒好几条：走节流，别每条都打一遍 stats/tags/pending/missing
        scheduleStatsRefresh();
      } else {
        setImportProgress(null);
        // 结束时一次性提示：有目录因超过深度上限没被扫到（以前完全静默，用户只看到"少了一半图"）
        if (wasImportingRef.current) {
          wasImportingRef.current = false;
          const skipped = imp.result?.depthSkippedDirs;
          if (Array.isArray(skipped) && skipped.length) {
            showToast(
              `有 ${skipped.length} 个目录超过导入深度上限未扫描，可在设置里调大「导入深度」`
            );
          }
        }
      }
    });
    // 页面打开时可能正赶上一次导入（含「上次导入未完成，重启后自动继续」）。
    // 只置 importing 不跟进度的话，横幅会永久停在 0% 且不会在结束时消失（P1），
    // 所以这里必须同时补上进度并开启轮询跟随。
    api
      .importStatus()
      .then((s) => {
        setImporting(s.running);
        if (!s.running) {
          setImportProgress(null);
          // 打开页面时上一次扫描已经失败了：也得说一声
          if (s.error) showToast(`上次扫描失败：${s.error}（可到 设置 → 数据维护 重新扫描）`, 'error');
          return;
        }
        setImportProgress({
          progress: Number(s.progress) || 0,
          saved: Number(s.result?.saved) || 0,
          total: Number(s.result?.total) || 0,
          unchanged: Number(s.result?.unchanged) || 0,
          message: s.message || '',
          speed: Number(s.speed) || 0,
          etaSec: s.etaSec == null ? null : Number(s.etaSec),
        });
        if (s.message) showToast(s.message);
        followImport();
      })
      .catch(quiet);
    return () => {
      off();
    };
  }, [
    refreshStats,
    scheduleStatsRefresh,
    followImport,
    showToast,
    load,
    pageRef,
    setImporting,
    setImportProgress,
    wasImportingRef,
    ]);
}
