/**
 * 服务端推送订阅（SSE）。
 * 后端在 /api/events 上推送：
 *  - job：任务状态快照 { crawl, import, enhance, clip, sr, aiUp, matting }（变化才推）
 *  - library：发生写操作（图片/设置/清单/回收站等变更）
 *  - live：动态壁纸配置变更
 * 全部页面共用一条连接（引用计数），组件卸载时退订即可。
 */
import { getApiToken } from './api';

type Handler = (data: any) => void;

const handlersByType = new Map<string, Set<Handler>>();
let source: EventSource | null = null;
let connecting: Promise<void> | null = null;
/**
 * 当前这条 EventSource 上已经挂过监听的类型。
 * 以前没有这个集合：某个类型退订到空就把 Map 里的 set 删掉，下次再订阅又走
 * `attach(type)` 重新 addEventListener —— 同一条连接上叠出第二个、第三个监听器，
 * 一次推送触发 N 次回调（详情页与网格同时订阅时表现为刷新风暴）。
 */
let attachedTypes = new Set<string>();

/** 还有没有存活的订阅者（Map 里可能留着空集合） */
function hasSubscriber() {
  for (const set of handlersByType.values()) if (set.size) return true;
  return false;
}

function attach(type: string) {
  if (!source || attachedTypes.has(type)) return;
  attachedTypes.add(type);
  source.addEventListener(type, (e) => {
    let data: any = {};
    try {
      data = JSON.parse((e as MessageEvent).data);
    } catch {
      /* 心跳等非 JSON 帧 */
    }
    handlersByType.get(type)?.forEach((fn) => {
      try {
        fn(data);
      } catch {
        /* 单个订阅者异常不拖垮其他 */
      }
    });
  });
}

async function ensure(): Promise<void> {
  if (source) return;
  if (connecting) return connecting;
  connecting = (async () => {
    const token = await getApiToken();
    const es = new EventSource(`/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    // 新连接 = 从零开始挂监听，旧连接的挂载记录必须作废
    attachedTypes = new Set();
    // 断线兜底：EventSource 默认自动重连；若连接被永久关闭则 10s 后重建
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        source = null;
        attachedTypes = new Set();
        setTimeout(() => {
          if (hasSubscriber()) void ensure();
        }, 10000);
      }
    };
    source = es;
    for (const type of handlersByType.keys()) attach(type);
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

/**
 * 订阅某类事件；返回退订函数（同步返回）。
 * 之前是 async：退订句柄要等建连 promise resolve 才拿得到，组件若在 resolve 前
 * 卸载（快速进出页面），清理执行的还是空函数，handler 就永远留在全局 Map 里。
 * handler 是同步入队的，退订没有理由异步化。
 */
export function subscribeEvents(type: 'job' | 'library' | 'live' | 'hello', fn: Handler): () => void {
  let set = handlersByType.get(type);
  if (!set) {
    set = new Set();
    handlersByType.set(type, set);
    // 连接早就建好的情况下才订阅这个类型：ensure() 里的 attach 循环已经跑过了，
    // 不在这里补挂一次，这个类型的事件永远收不到（谁先订阅谁活，后订阅的静默失效）
    if (source) attach(type);
  }
  set.add(fn);
  // 建连失败不抛给组件，静默退化为无推送（页面仍有初次加载与手动刷新）
  void ensure().catch(() => {});
  return () => {
    // 只移除订阅者，不删 Map 里的集合：删了下次订阅会重新 attach，监听器就叠起来了
    set?.delete(fn);
  };
}
