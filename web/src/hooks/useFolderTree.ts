import { useCallback, useState } from 'react';
import { api, quiet } from '../api';
import type { FolderNode, ImageItem } from '../types';
import { confirmDialog, promptDialog } from '../components/Dialogs';

type Toast = (msg: string, kind?: 'info' | 'error') => void;

/**
 * 虚拟文件夹树：进入 / 新建 / 改名 / 打标签 / 排序 / 删除，以及隐私夹的解锁弹窗状态。
 * 文件夹只是归类关系，任何操作都不会动素材文件本身。
 */
export function useFolderTree({
  showToast,
  items,
  load,
  refreshStats,
  initialFolderId,
  showGallery,
}: {
  showToast: Toast;
  items: ImageItem[];
  load: (page: number, reset: boolean) => Promise<void>;
  refreshStats: () => void;
  /** 首屏可从 URL 直接落到某个文件夹（分享链接 / 刷新还原） */
  initialFolderId: number | null;
  /** 进入文件夹要切回图库视图（视图由 App 管，hook 不碰路由） */
  showGallery: () => void;
}) {
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [folderId, setFolderId] = useState<number | null>(initialFolderId);
  // 隐私空间的密码弹窗目标（null = 关闭）
  const [lockFolderId, setLockFolderId] = useState<number | null>(null);

  const reload = useCallback(() => {
    api
      .folders()
      .then((r) => setFolders(r.folders))
      .catch(quiet);
  }, []);

  // 进入某个文件夹（含后代聚合视图）
  const enterFolder = useCallback(
    (id: number) => {
      const f = folders.find((x) => x.id === id);
      // 已加锁且本次会话没解锁：先要密码，别让用户白等一次 403
      if (f?.locked && !f.unlocked) {
        setLockFolderId(id);
        return;
      }
      showGallery();
      setFolderId(id);
    },
    [folders, showGallery]
  );

  const lockFolder = lockFolderId != null ? folders.find((f) => f.id === lockFolderId) || null : null;

  // 新建虚拟文件夹（根级 parentId=null 或某夹下）
  const createFolderAt = useCallback(
    async (parentId: number | null) => {
      const name = await promptDialog(parentId == null ? '新建文件夹' : '新建子文件夹', '', '文件夹名称');
      if (name === null) return;
      if (!name.trim()) return showToast('文件夹名称不能为空');
      try {
        const r = await api.createFolder(name.trim(), parentId);
        setFolders(r.folders);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [showToast]
  );

  // 重命名文件夹
  const renameFolderAt = useCallback(
    async (id: number) => {
      const folder = folders.find((f) => f.id === id);
      const name = await promptDialog('重命名文件夹', folder?.name || '', '新名称');
      if (name === null || !name.trim()) return;
      try {
        const r = await api.renameFolder(id, name.trim());
        setFolders(r.folders);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [folders, showToast]
  );

  /**
   * 文件夹标签：夹上打标签，夹内素材在搜索/筛选时自动继承（Eagle 的老习惯）。
   * 只写 folders.tags，图片记录不动 —— 撤销只要把标签清掉，不用逐张回滚。
   */
  const editFolderTags = useCallback(
    async (id: number) => {
      const folder = folders.find((f) => f.id === id);
      const cur = String(folder?.tags || '');
      const next = await promptDialog('文件夹标签', cur, '多个用逗号分隔，夹内素材自动继承');
      if (next === null) return;
      const tags = next
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      try {
        const r = await api.setFolderTags(id, tags);
        setFolders(r.folders);
        showToast(tags.length ? `已给「${folder?.name || '文件夹'}」打上 ${tags.length} 个标签` : '已清空文件夹标签');
        refreshStats();
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [folders, showToast, refreshStats]
  );

  /**
   * 手动排序：把拖动的几张插到目标卡片后面，把整份新顺序发给后端。
   * 只在文件夹视图里有意义（同一张图在不同夹可以有不同的位置）。
   */
  const reorderInFolder = useCallback(
    async (dragIds: number[], targetId: number) => {
      if (!folderId) {
        showToast('手动排序只在文件夹里生效：先打开一个文件夹');
        return;
      }
      const ids = items.map((i) => i.id);
      const moving = ids.filter((id) => dragIds.includes(id));
      if (!moving.length) return;
      const rest = ids.filter((id) => !dragIds.includes(id));
      const at = rest.indexOf(targetId);
      if (at < 0) return;
      const next = [...rest.slice(0, at + 1), ...moving, ...rest.slice(at + 1)];
      try {
        await api.reorderFolder(folderId, next);
        // 拖放只在 sort=manual 且已打开文件夹时才启用，这里不必再改筛选，按当前排序重取即可
        load(1, true);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [folderId, items, load, showToast]
  );

  // 删除文件夹（仅解除关联，不删图片）
  const deleteFolderAt = useCallback(
    async (id: number) => {
      const folder = folders.find((f) => f.id === id);
      const ok = await confirmDialog(`删除文件夹「${folder?.name || ''}」？只会解除归类，不会删除任何图片。`);
      if (!ok) return;
      try {
        const r = await api.deleteFolder(id);
        setFolders(r.folders);
        if (folderId === id) setFolderId(null); // 删的是当前视图，退回全库
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [folders, folderId, showToast]
  );

  /** 文件夹同父级拖动排序：把 dragId 插到 targetId 前/后，整份新顺序发给后端 */
  const reorderFoldersAt = useCallback(
    async (dragId: number, targetId: number, position: 'before' | 'after') => {
      const target = folders.find((f) => f.id === targetId);
      if (!target) return;
      const parent = target.parent_id ?? null;
      const siblings = folders
        .filter((f) => (f.parent_id ?? null) === parent)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
      const dragged = siblings.find((f) => f.id === dragId);
      if (!dragged) return;
      const without = siblings.filter((f) => f.id !== dragId);
      const at = without.findIndex((f) => f.id === targetId);
      if (at < 0) return;
      const next = [...without];
      next.splice(position === 'before' ? at : at + 1, 0, dragged);
      try {
        const r = await api.reorderFolders(parent, next.map((f) => f.id));
        setFolders(r.folders);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [folders, showToast]
  );

  /** 拖图到文件夹卡片上：归档并刷新夹上的数量/封面 */
  const dropImagesOnFolderAt = useCallback(
    async (targetFolderId: number, ids: number[]) => {
      try {
        const r = await api.addToFolder(targetFolderId, ids);
        showToast(`已把 ${ids.length} 张放进文件夹（新增 ${r.added} 条归属）`);
        reload();
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [reload, showToast]
  );

  /** 侧栏文件夹树接收拖入的素材（拖拽归类，Eagle 式交互） */
  const dropImagesIntoFolder = useCallback(
    async (targetId: number, ids: number[]) => {
      if (!ids.length) return;
      try {
        const res = await api.addToFolder(targetId, ids);
        setFolders(res.folders);
        showToast(res.added ? `已归入文件夹（新增 ${res.added} 张）` : '这些素材已在该文件夹里');
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [showToast]
  );

  return {
    folders,
    setFolders,
    reload,
    folderId,
    setFolderId,
    enterFolder,
    lockFolderId,
    setLockFolderId,
    lockFolder,
    createFolderAt,
    renameFolderAt,
    editFolderTags,
    reorderInFolder,
    deleteFolderAt,
    reorderFoldersAt,
    dropImagesOnFolderAt,
    dropImagesIntoFolder,
  };
}
