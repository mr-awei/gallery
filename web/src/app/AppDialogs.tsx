import { Suspense, lazy } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { api, desktop } from '../api';
import BatchCreateDialog from '../components/BatchCreateDialog';
import BookmarkDialog from '../components/BookmarkDialog';
import CommandPalette, { type PaletteCommand } from '../components/CommandPalette';
import CreateLibraryDialog from '../components/CreateLibraryDialog';
import DeleteReasonDialog from '../components/DeleteReasonDialog';
import DialogHost from '../components/Dialogs';
import ErrorBoundary from '../components/ErrorBoundary';
import ExportGalleryDialog from '../components/ExportGalleryDialog';
import FolderAppearanceDialog from '../components/FolderAppearanceDialog';
import FolderCoverDialog from '../components/FolderCoverDialog';
import FolderLockDialog from '../components/FolderLockDialog';
import ForcedUpdateOverlay from '../components/ForcedUpdateOverlay';
import HotkeyHelp from '../components/HotkeyHelp';
import OnboardingTour from '../components/OnboardingTour';
import QuickClassifyDialog from '../components/QuickClassifyDialog';
import ReverseSearchDialog, { type ReverseTarget } from '../components/ReverseSearchDialog';
import ShareLinkDialog from '../components/ShareLinkDialog';
import StackViewer from '../components/StackViewer';
import TagMetaDialog from '../components/TagMetaDialog';
import type { LightboxState } from '../hooks/useLightbox';
import type { useAppUiState } from '../hooks/useAppUiState';
import type { Filters, FolderNode, ImageItem, Library, Stats, TagNode, View } from '../types';
import type { DialogState } from './useDialogState';
import type { LoadGallery } from './types';

// 灯箱是首屏用不到的重组件（自带一堆查看/编辑面板），改成按需加载：
// 主 chunk 少解析一大块，点开大图时才取这个分片，本地服务下就是几毫秒
const Lightbox = lazy(() => import('../components/Lightbox'));

type AppUi = ReturnType<typeof useAppUiState>;

type Props = {
  ui: AppUi;
  dialogs: DialogState;
  view: View;
  filters: Filters;
  folders: FolderNode[];
  folderId: number | null;
  selected: Set<number>;
  stats: Stats | null;
  tags: TagNode[];
  lb: LightboxState;
  activeLib: Library | null;
  activeLibName: string;
  activeFolder: FolderNode | null;
  onboarding: boolean | null;
  tourOpen: boolean;
  pendingDelete: ImageItem | null;
  confirmDelete: (payload: {
    reasons: string[];
    note: string;
    aiAnalysis: string;
    learn: boolean;
  }) => Promise<void>;
  rsTarget: ReverseTarget | null;
  setRsTarget: Dispatch<SetStateAction<ReverseTarget | null>>;
  paletteCommands: PaletteCommand[];
  lockFolderId: number | null;
  lockFolder: FolderNode | null;
  enhancingId: number | null;
  pageRef: MutableRefObject<number>;
  load: LoadGallery;
  refreshStats: () => void;
  openItem: (item: ImageItem, pool?: ImageItem[], full?: boolean) => void;
  revealGalleryItem: (id: number, pool: ImageItem[]) => Promise<void>;
  toggleFavorite: (item: ImageItem) => Promise<void>;
  saveTags: (item: ImageItem, tagList: string[]) => Promise<void>;
  requestDelete: (item: ImageItem) => void;
  setWallpaper: (item: ImageItem, style?: string) => Promise<void>;
  enhanceOne: (item: ImageItem) => Promise<void>;
  patchItem: (updated: ImageItem) => void;
  download: (item: ImageItem) => void;
  setAnnotationCounts: Dispatch<SetStateAction<Record<string, number>>>;
  setFolders: Dispatch<SetStateAction<FolderNode[]>>;
  setTags: Dispatch<SetStateAction<TagNode[]>>;
  setTagGroups: Dispatch<SetStateAction<string[]>>;
  setSelected: Dispatch<SetStateAction<Set<number>>>;
  setView: Dispatch<SetStateAction<View>>;
  setFolderId: Dispatch<SetStateAction<number | null>>;
  setLb: Dispatch<SetStateAction<LightboxState>>;
  setPeopleFocus: Dispatch<SetStateAction<{ id: number; n: number } | null>>;
  setPendingDelete: Dispatch<SetStateAction<ImageItem | null>>;
  setLockFolderId: Dispatch<SetStateAction<number | null>>;
  onFiltersChange: (patch: Partial<Filters>) => void;
  finishTour: () => void;
  finishOnboarding: () => void;
  onLibraryCreated: (library: Library) => void;
  showToast: (msg: string, kind?: 'info' | 'error') => void;
};

/**
 * 全部浮层与对话框（灯箱 / 命令面板 / 各类弹窗 / 服务状态遮罩 / toast）。
 * 只做渲染，不含任何 effect —— 搬出来不会影响 App 里 effect 的注册顺序。
 */
export default function AppDialogs(props: Props) {
  const {
    ui, dialogs, view, filters, folders, folderId, selected, stats, tags, lb, activeLib, activeLibName,
    activeFolder, onboarding, tourOpen, pendingDelete, confirmDelete, rsTarget, setRsTarget,
    paletteCommands, lockFolderId, lockFolder, enhancingId, pageRef, load, refreshStats, openItem,
    revealGalleryItem, toggleFavorite, saveTags, requestDelete, setWallpaper, enhanceOne, patchItem,
    download, setAnnotationCounts, setFolders, setTags, setTagGroups, setSelected, setView, setFolderId,
    setLb, setPeopleFocus, setPendingDelete, setLockFolderId, onFiltersChange, finishTour,
    finishOnboarding, onLibraryCreated, showToast,
  } = props;
  const {
    toast,
    serviceRestarting,
    serviceOffline,
    serviceError,
    showCreateLib,
    setShowCreateLib,
    bookmarkOpen,
    setBookmarkOpen,
    exportOpen,
    setExportOpen,
    coverFolderId,
    setCoverFolderId,
    palette,
    setPalette,
  } = ui;
  const {
    shareOpen, setShareOpen, tagEdit, setTagEdit, appearanceFolderId, setAppearanceFolderId,
    batchCreate, setBatchCreate, quickClassifyIds, setQuickClassifyIds, stackViewId, setStackViewId,
    helpOpen, setHelpOpen,
  } = dialogs;

  return (
    <>
      {helpOpen && <HotkeyHelp onClose={() => setHelpOpen(false)} />}

      <CommandPalette
        open={palette !== null}
        mode={palette || 'command'}
        onClose={() => setPalette(null)}
        commands={paletteCommands}
        filters={filters}
        onFilter={onFiltersChange}
        folders={folders}
        onOpenFolder={(id) => {
          setView('gallery');
          setFolderId(id);
        }}
      />

      {lockFolderId != null && lockFolder && (
        <FolderLockDialog
          folder={lockFolder}
          onClose={() => setLockFolderId(null)}
          onFolders={(fs) => {
            setFolders(fs);
            // 加锁 / 解锁会改变可见集：当前正停留在这个夹里且它被重新锁上，就退回全库
            const cur = fs.find((f) => f.id === lockFolderId);
            if (folderId === lockFolderId && cur && !cur.unlocked) setFolderId(null);
            load(1, true);
            refreshStats();
          }}
          onToast={showToast}
        />
      )}

      {lb && (
        // 大图/水印面板在内容区那个 ErrorBoundary 之外（它是全屏浮层），
        // 一旦渲染期抛错整棵树会被卸载 —— 用户看到的是一片白，连侧栏都没了。
        // 这里单独兜一层：崩了就显示错误卡片，换张图自动重置。
        <ErrorBoundary resetKey={`lb:${lb.items[lb.index]?.id ?? ''}`}>
          <Suspense fallback={null}>
            <Lightbox
              items={lb.items}
              index={lb.index}
              // 服务端一定会给 library；这里再拿库列表兜一层，任何情况下都不显示空
              // （旧版服务/竞态时 stats.library 可能缺失，用户就分不清图在哪个库了）
              library={
                stats?.library ||
                (activeLib
                  ? { id: String(activeLib.id), name: activeLib.name, path: activeLib.root_path || '' }
                  : null)
              }
              onClose={() => {
                const last = lb.items[lb.index];
                setLb(null);
                // 图库/收藏页打开的大图：退出后把列表定位到最后浏览的那张
                if (last && (view === 'gallery' || view === 'favorites')) revealGalleryItem(last.id, lb.items);
              }}
              onIndex={(index) => setLb((prev) => (prev ? { ...prev, index } : prev))}
              onToggleFavorite={toggleFavorite}
              onSaveTags={saveTags}
              onDelete={requestDelete}
              onSetWallpaper={setWallpaper}
              onEnhance={enhanceOne}
              enhancing={enhancingId === lb.items[lb.index]?.id}
              onViewed={patchItem}
              onAnnotCount={(id, n) => setAnnotationCounts((prev) => ({ ...prev, [String(id)]: n }))}
              onDownload={download}
              onPatch={async (target, patch) => {
                try {
                  patchItem(await api.patch(target.id, patch));
                } catch (err) {
                  showToast((err as Error).message);
                }
              }}
              onOpenSimilar={(pool, id) =>
                setLb({ items: pool, index: Math.max(0, pool.findIndex((x) => x.id === id)) })
              }
              onOpenStack={(sid) => setStackViewId(sid)}
              onOpenFolder={(fid) => {
                // 详情面板里点归属夹名：关掉大图，回图库只看这一夹
                setLb(null);
                setView('gallery');
                setFolderId(fid);
              }}
              onGotoPerson={(pid) => {
                // 详情面板里点「人物 #123」：关掉大图，进人物页直接打开这个人的照片墙
                setLb(null);
                setView('people');
                setPeopleFocus({ id: pid, n: Date.now() });
              }}
              onChangeToast={(msg) => {
                showToast(msg);
                refreshStats();
                pageRef.current = 1;
                load(1, true);
              }}
              onFindColor={(hue) => {
                onFiltersChange({ hue });
                setLb(null);
                setView('gallery');
              }}
              onReplaceItem={patchItem}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {pendingDelete && (
        <DeleteReasonDialog
          item={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
          onToast={showToast}
        />
      )}

      {toast && <div className={`toast${toast.kind === 'error' ? ' toast-error' : ''}`}>{toast.text}</div>}

      {/* 应用内 prompt/confirm 对话框（替代原生弹窗，全局唯一挂载点） */}
      <DialogHost />

      {/* 全网以图搜图：图库右键、人物右键、灯箱都唤起同一个面板 */}
      <ReverseSearchDialog target={rsTarget} onClose={() => setRsTarget(null)} onToast={showToast} />

      {/* 本地服务重启中：端口可能变，界面此刻的请求都会失败，先遮住再重载 */}
      {serviceRestarting && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9998,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            background: 'rgba(10, 12, 18, 0.72)',
            backdropFilter: 'blur(3px)',
            color: '#e8ecf5',
            fontSize: 13.5,
          }}
          role="alertdialog"
          aria-label={'本地服务正在重启'}
        >
          <span className="spinner" />
          <div>{'本地服务正在重启，请稍候…'}</div>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>{'正在进行的上传/导入会被中断，完成后自动恢复。'}</div>
        </div>
      )}

      {/* 服务彻底起不来：常驻离线横幅（不遮罩），用户仍可浏览界面 */}
      {serviceOffline && !serviceRestarting && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 9997,
            padding: '9px 18px',
            background: 'rgba(120, 34, 46, 0.94)',
            color: '#fff',
            fontSize: 12.5,
            textAlign: 'center',
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
          role="alert"
        >
          <span>
            {'本地服务不可用：换壁纸、收藏、导入等接口暂时失效。'}
            {serviceError && <span style={{ opacity: 0.85 }}>{' 原因：'}{serviceError}</span>}
          </span>
          <button
            className="btn sm"
            onClick={() => {
              if (!desktop?.restartService) {
                showToast('当前是开发模式，请重启 npm run dev', 'error');
                return;
              }
              void desktop
                .restartService()
                .then((r) => {
                  if (!r?.ok) showToast('重启未成功，可在托盘右键选「重启本地服务」再试一次', 'error');
                })
                .catch((err) => showToast(`重启失败：${(err as Error)?.message || err}`, 'error'));
            }}
          >
            {'立即重启服务'}
          </button>
        </div>
      )}

      {/* 强制更新：确认有新版本后全屏接管，装完才允许继续用 */}
      <ForcedUpdateOverlay />

      {tagEdit && (
        <TagMetaDialog
          tag={tagEdit}
          tags={tags}
          onClose={() => setTagEdit(null)}
          onSaved={(r) => {
            setTags(r.tags);
            setTagGroups(r.groups);
            setTagEdit(null);
          }}
          onToast={showToast}
        />
      )}

      {showCreateLib && (
        <CreateLibraryDialog
          onCancel={() => setShowCreateLib(false)}
          onDone={onLibraryCreated}
          onToast={showToast}
        />
      )}

      {bookmarkOpen && (
        <BookmarkDialog
          onClose={() => setBookmarkOpen(false)}
          onToast={showToast}
          onSaved={() => {
            setBookmarkOpen(false);
            // 书签是按当前库入库的：留在原视图刷新首屏即可看到
            setView('gallery');
            pageRef.current = 1;
            load(1, true);
            refreshStats();
          }}
        />
      )}

      {exportOpen && (
        <ExportGalleryDialog
          defaultTitle={activeFolder ? activeFolder.name : activeLibName}
          folderId={folderId}
          folderName={activeFolder?.name}
          selectedIds={selected.size ? [...selected] : undefined}
          onClose={() => setExportOpen(false)}
          onToast={showToast}
        />
      )}

      {shareOpen && (
        <ShareLinkDialog
          defaultTitle={activeFolder ? activeFolder.name : activeLibName}
          folderId={folderId}
          folderName={activeFolder?.name}
          selectedIds={selected.size ? [...selected] : undefined}
          onClose={() => setShareOpen(false)}
          onToast={showToast}
        />
      )}

      {coverFolderId != null &&
        (() => {
          const target = folders.find((f) => f.id === coverFolderId);
          if (!target) return null;
          return (
            <FolderCoverDialog
              folder={target}
              onClose={() => setCoverFolderId(null)}
              onSaved={(next, msg) => {
                setFolders(next);
                showToast(msg);
              }}
              onToast={showToast}
            />
          );
        })()}

      {appearanceFolderId != null &&
        (() => {
          const target = folders.find((f) => f.id === appearanceFolderId);
          if (!target) return null;
          return (
            <FolderAppearanceDialog
              folder={target}
              onClose={() => setAppearanceFolderId(null)}
              onSaved={setFolders}
              onToast={showToast}
            />
          );
        })()}

      {batchCreate && (
        <BatchCreateDialog
          mode={batchCreate.mode}
          parentId={batchCreate.parentId}
          parentName={
            batchCreate.parentId != null ? folders.find((f) => f.id === batchCreate.parentId)?.name || '' : ''
          }
          onClose={() => setBatchCreate(null)}
          onFolders={setFolders}
          onTags={(r) => {
            setTags(r.tags);
            setTagGroups(r.groups);
          }}
          onToast={showToast}
        />
      )}

      {quickClassifyIds && quickClassifyIds.length > 0 && (
        <QuickClassifyDialog
          ids={quickClassifyIds}
          folders={folders}
          currentFolderId={folderId}
          onClose={() => setQuickClassifyIds(null)}
          onDone={() => {
            setSelected(new Set());
            pageRef.current = 1;
            load(1, true);
            refreshStats();
          }}
          onToast={showToast}
        />
      )}

      {stackViewId != null && (
        <StackViewer
          stackId={stackViewId}
          onClose={() => setStackViewId(null)}
          onChanged={() => {
            pageRef.current = 1;
            load(1, true);
          }}
          onToast={showToast}
          onOpenItem={(it) => openItem(it, [it])}
        />
      )}

      {/* 教程：建库引导优先，教程等它关掉后再自动弹 */}
      <OnboardingTour open={tourOpen && onboarding === true} onClose={finishTour} />

      {onboarding === false && (
        <CreateLibraryDialog
          welcome
          onCancel={finishOnboarding}
          onDone={(library) => {
            onLibraryCreated(library);
            finishOnboarding();
          }}
          onToast={showToast}
        />
      )}
    </>
  );
}
