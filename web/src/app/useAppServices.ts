import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { desktop, onApiError } from '../api';
import type { ReverseTarget } from '../components/ReverseSearchDialog';
import type { ImageItem, View } from '../types';
import type { Toast } from './types';

type Options = {
  setLoadError: Dispatch<SetStateAction<string>>;
  showToast: Toast;
  setServiceRestarting: Dispatch<SetStateAction<boolean>>;
  setServiceOffline: Dispatch<SetStateAction<boolean>>;
  setServiceError: Dispatch<SetStateAction<string>>;
  setView: Dispatch<SetStateAction<View>>;
  setFolderId: Dispatch<SetStateAction<number | null>>;
  openItem: (item: ImageItem, pool?: ImageItem[], full?: boolean) => void;
};

/**
 * 应用级「服务与跨页面事件」接线：
 * 后台请求失败收口 / 本地服务状态 / 事件回调异常 toast / 全网搜图 / 在图库中定位。
 *
 * 五个 effect 的顺序与拆分前一致（业务代码里它们本来就是连着的一段）。
 */
export function useAppServices({
  setLoadError,
  showToast,
  setServiceRestarting,
  setServiceOffline,
  setServiceError,
  setView,
  setFolderId,
  openItem,
}: Options) {
  /* 「全网搜图」是一个跨页面的面板：图库卡片、人物卡片、灯箱都能唤起，
     统一在这里挂一个，别让每个页面各自复制一份对话框 */
  const [rsTarget, setRsTarget] = useState<ReverseTarget | null>(null);
  /* 灯箱点人名 → 人物页要打开的那个人（nonce 让「连点同一个人」也能再次跳转） */
  const [peopleFocus, setPeopleFocus] = useState<{ id: number; n: number } | null>(null);

  // 后台请求失败统一收口：同一条错误只显示一次，用户关掉后不再反复弹
  useEffect(() => onApiError((err) => setLoadError((prev) => prev || err.message)), [setLoadError]);

  // 本地服务重启：先遮住，恢复后主进程会重载页面，遮罩自然消失
  useEffect(() => {
    if (!desktop?.onServiceState) return;
    return desktop.onServiceState((s) => {
      setServiceRestarting(!!s.restarting);
      // dead 态不遮罩锁死，但要常驻一条离线横幅，别让用户对着「点不动」猜原因
      setServiceOffline(!!s.dead);
      setServiceError(String(s.error || ''));
      if (s.error) setLoadError(`本地服务重启失败：${s.error}`);
    });
  }, [setLoadError, setServiceError, setServiceOffline, setServiceRestarting]);

  /* 事件回调里抛的错（定时器、onClick 里的 await）到不了 React 错误边界，
     由 main.tsx 统一转成 tuku:error，这里用 toast 让用户至少知道「刚才那下失败了」 */
  useEffect(() => {
    const onErr = (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (typeof msg === 'string' && msg) showToast(`出现异常：${msg}`, 'error');
    };
    window.addEventListener('tuku:error', onErr);
    return () => window.removeEventListener('tuku:error', onErr);
  }, [showToast]);

  useEffect(() => {
    const onReverse = (e: Event) => {
      const d = (e as CustomEvent<{ imageId?: number; title?: string; previewUrl?: string }>).detail;
      if (!d || !d.imageId) return;
      setRsTarget({ imageId: d.imageId, title: d.title || '', previewUrl: d.previewUrl || '' });
    };
    window.addEventListener('tuku:reverse-search', onReverse);
    return () => window.removeEventListener('tuku:reverse-search', onReverse);
  }, []);

  /* 「在图库中定位」：人物页右键一张照片 → 切回图库、把筛选切到它所在的文件夹，
     并直接打开这张图（信息面板里能看到归属文件夹 / 资源库，关掉就在那一夹里）。 */
  useEffect(() => {
    const onLocate = (e: Event) => {
      const d = (e as CustomEvent<{ item?: ImageItem; folderId?: number | null }>).detail;
      if (!d || !d.item) return;
      setView('gallery');
      setFolderId(d.folderId ?? null);
      openItem(d.item, [d.item]);
    };
    window.addEventListener('tuku:locate-image', onLocate);
    return () => window.removeEventListener('tuku:locate-image', onLocate);
  }, [openItem, setFolderId, setView]);

  return { rsTarget, setRsTarget, peopleFocus, setPeopleFocus };
}
