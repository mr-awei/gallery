import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { ApiError, api, quiet } from '../api';
import type { FolderNode, Library, SwitchLibraryResult, View } from '../types';
import { confirmDialog } from '../components/Dialogs';
import type { LoadGallery, Toast } from './types';
import i18n from '../i18n';

type Options = {
  showToast: Toast;
  setView: Dispatch<SetStateAction<View>>;
  setFolderId: Dispatch<SetStateAction<number | null>>;
  setFolders: Dispatch<SetStateAction<FolderNode[]>>;
  setShowCreateLib: Dispatch<SetStateAction<boolean>>;
  setActiveSavedId: Dispatch<SetStateAction<number | null>>;
  pageRef: MutableRefObject<number>;
  load: LoadGallery;
  refreshStats: () => void;
  followImport: () => Promise<void>;
  reloadFolders: () => void;
  reloadSavedFilters: () => void;
  libTotalRef: MutableRefObject<number>;
  folders: FolderNode[];
  folderId: number | null;
  /** 当前库 id 的 state 由 App 持有（统计 hook 在本 hook 之前就要用它） */
  activeLibId: number | null;
  setActiveLibId: Dispatch<SetStateAction<number | null>>;
};

/**
 * 多资源库会话：库列表 / 当前库 / 库锁 / 切换 / 删除 / 新建。
 *
 * 四个 effect 的相对顺序与拆分前一致：先拉库列表与文件夹树 → 由库列表推导解锁屏
 * → 订阅 423 事件 → 校验 URL 里的 folderId 是否属于当前库。
 */
export function useLibraries({
  showToast,
  setView,
  setFolderId,
  setFolders,
  setShowCreateLib,
  setActiveSavedId,
  pageRef,
  load,
  refreshStats,
  followImport,
  reloadFolders,
  reloadSavedFilters,
  libTotalRef,
  folders,
  folderId,
  activeLibId,
  setActiveLibId,
}: Options) {
  const [libraries, setLibraries] = useState<Library[]>([]);
  /** 当前库锁着时的信息；非空就把整页切到解锁屏（服务端此时只回 423） */
  const [lockInfo, setLockInfo] = useState<{ id: number; name: string } | null>(null);

  // 加载资源库列表与当前库的文件夹树
  useEffect(() => {
    api
      .libraries()
      .then((r) => {
        setLibraries(r.libraries);
        setActiveLibId(r.activeId);
      })
      .catch(quiet);
    reloadFolders();
    reloadSavedFilters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 拉一次库列表并把 hasPassword / locked 同步到本地。
   * 切库必须 await 它：服务端在 activateLibrary 里会清空所有解锁态再记上目标库，
   * 本地快照不同步就会出现两种错——刚输过密码的库又弹一次解锁屏；切走的库
   * 本地还显示「已解锁」，点回来不带密码直接 423。
   */
  const syncLibraries = useCallback(async () => {
    try {
      const r = await api.libraries();
      setLibraries(r.libraries);
      setActiveLibId(r.activeId);
      return r;
    } catch (err) {
      quiet(err);
      return null;
    }
  }, []);

  /** 重新拉库列表（设/改/删密码、立即上锁之后用） */
  const reloadLibraries = useCallback(() => {
    void syncLibraries();
  }, [syncLibraries]);

  // 当前库锁着（且本次会话没解锁）→ 整页停下输密码。判断统一走这里，
  // 启动、切库、立即上锁后都自动生效，不用各处重复写
  useEffect(() => {
    const cur = libraries.find((l) => l.id === activeLibId);
    if (cur?.locked) {
      setLockInfo((prev) => (prev?.id === cur.id ? prev : { id: cur.id, name: cur.name }));
    } else if (cur) {
      setLockInfo(null);
    }
  }, [libraries, activeLibId]);

  // 任何接口回 423（当前库锁着）都会派发这个事件：刷新一次库状态，让上面的 effect 接管。
  // 锁定后页面组件会疯狂重试，这里用一个标志挡掉并发探测
  const lockProbeRef = useRef(false);
  useEffect(() => {
    const onLocked = () => {
      if (lockProbeRef.current) return;
      lockProbeRef.current = true;
      api
        .libraries()
        .then((r) => {
          setLibraries(r.libraries);
          setActiveLibId(r.activeId);
        })
        .catch(quiet)
        .finally(() => {
          lockProbeRef.current = false;
        });
    };
    window.addEventListener('tuku:library-locked', onLocked);
    return () => window.removeEventListener('tuku:library-locked', onLocked);
  }, []);

  /* 分享链接里的 folder 可能属于别的库、或已被删除：树一到就校验，失配退回全库 */
  useEffect(() => {
    if (!folderId || !folders.length) return;
    if (!folders.some((f) => f.id === folderId)) setFolderId(null);
  }, [folders, folderId, setFolderId]);

  /** 切库 / 建库 / 删库后重置「库张数」基线。
   *  refreshStats 靠 total 变大判断要不要重载列表；换库后新旧库张数没有可比性
   *  （旧库 5008 → 新库 0），不重置的话新库导入期间永远判定为「没增长」，
   *  列表就停在切库那一刻的张数不再刷新。 */
  const resetLibBaseline = useCallback(() => {
    libTotalRef.current = -1;
  }, [libTotalRef]);

  // 切换到另一个资源库：重载列表、统计、文件夹树
  // 返回 SwitchLibraryResult：失败时给调用方文案，并说明「是不是缺密码」
  const switchLibrary = useCallback(
    async (id: number, password?: string): Promise<SwitchLibraryResult> => {
      if (id === activeLibId) return { ok: true };
      try {
        await api.activateLibrary(id, password);
        // 先同步库列表再落 activeLibId：本地库列表里目标库的 locked 还是旧值（true），
        // 不刷新的话整页解锁屏会紧接着弹出来 —— 用户刚在切库框输完密码，又被要求
        // 在另一个界面输第二遍（v1.2.14 报的问题）。反过来说，切走后旧库会被服务端
        // 重新锁上，本地不同步就会在下次点回来时「不发密码直接切」→ 423 只剩一句 toast。
        if (!(await syncLibraries())) setActiveLibId(id);
        setFolderId(null);
        setFolders([]);
        setView('gallery');
        pageRef.current = 1;
        resetLibBaseline();
        load(1, true);
        refreshStats();
        // 切库会触发后台扫描（activate 路由 startLocalImport），
        // SSE 在导入 CPU 密集期会丢事件，必须开轮询兜底
        followImport();
        reloadFolders();
        // 保存的筛选器存在各库自己的 gallery.db：不重载就会继续显示上一个库的条目
        setActiveSavedId(null);
        reloadSavedFilters();
        return { ok: true };
      } catch (err) {
        const message = (err as Error).message;
        // 服务端说「这个库有密码、本次运行还没解锁」→ 调用方该弹密码框，不是丢一句 toast
        const needsPassword = err instanceof ApiError && err.code === 'library_locked';
        // 带着密码来的调用方是对话框，它自己把错误显示在框里
        if (!password && !needsPassword) showToast(message);
        return { ok: false, message, needsPassword };
      }
    },
    [
      activeLibId,
      load,
      refreshStats,
      followImport,
      resetLibBaseline,
      showToast,
      syncLibraries,
      setFolderId,
      setFolders,
      setView,
      pageRef,
      reloadFolders,
      setActiveSavedId,
      reloadSavedFilters,
    ]
  );

  // 删除资源库（Eagle 式「从列表删除」：可删任意库，不必先切换过去。
  // 只删库自建产物，素材图片保留；默认库不可删。删当前库则切回剩余库并重载）
  const deleteLibraryAt = useCallback(
    async (lib: Library) => {
      if (!lib.deletable) return showToast(i18n.t('k90fa3792'));
      const isCurrent = lib.id === activeLibId;
      const ok = await confirmDialog(
        i18n.t('k3d78afe5', { p0: lib.name }) +
          (isCurrent ? i18n.t('k6552bd98') : '')
      );
      if (!ok) return;
      try {
        const r = await api.deleteLibrary(lib.id);
        setLibraries(r.libraries);
        if (isCurrent) {
          setActiveLibId(r.activeId);
          setFolderId(null);
          setFolders([]);
          setView('gallery');
          pageRef.current = 1;
          resetLibBaseline();
          load(1, true);
          refreshStats();
          reloadFolders();
          setActiveSavedId(null);
          reloadSavedFilters();
        }
        showToast(i18n.t('k1a0f04b5', { p0: lib.name }));
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [
      activeLibId,
      load,
      refreshStats,
      resetLibBaseline,
      showToast,
      setActiveSavedId,
      setFolderId,
      setFolders,
      setView,
      pageRef,
      reloadFolders,
      reloadSavedFilters,
      ]
  );

  // 新建资源库后：刷新库列表、切到新库并扫描
  const onLibraryCreated = useCallback(
    (library: Library) => {
      setShowCreateLib(false);
      setActiveLibId(library.id);
      setFolderId(null);
      setFolders([]);
      setView('gallery');
      pageRef.current = 1;
      resetLibBaseline();
      load(1, true);
      refreshStats();
      // 新建库后服务端会后台扫描素材目录（activate 路由 startLocalImport）。
      // 导入的 CPU 密集段 SSE 心跳会断、library 事件全丢，前端会停在「导入完成
      // 但列表/统计不更新」的中间状态，必须开轮询兜底。
      followImport();
      api
        .libraries()
        .then((r) => {
          setLibraries(r.libraries);
          setActiveLibId(r.activeId);
        })
        .catch(quiet);
      reloadFolders();
      setActiveSavedId(null);
      reloadSavedFilters();
      showToast(i18n.t('k77e86b13'));
    },
    [
      load,
      refreshStats,
      followImport,
      resetLibBaseline,
      showToast,
      setShowCreateLib,
      setFolderId,
      setFolders,
      setView,
      pageRef,
      reloadFolders,
      setActiveSavedId,
      reloadSavedFilters,
      ]
  );

  return {
    libraries,
    setLibraries,
    lockInfo,
    syncLibraries,
    reloadLibraries,
    switchLibrary,
    deleteLibraryAt,
    onLibraryCreated,
    resetLibBaseline,
  };
}
