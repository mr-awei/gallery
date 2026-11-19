import { useCallback, useEffect, useState } from 'react';
import { UPLOAD_HINT, filesFromDataTransfer, importFiles, type ImportProgress } from '../lib/importer';
import i18n from '../i18n';

interface Props {
  /** 有文件成功入库后回调，父级据此刷新列表与统计 */
  onImported: (count: number) => void;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
}

/**
 * 全应用级「拖拽 / 粘贴入库」（Eagle 三件套之二）。
 *
 * 拖拽不再要求落进屏幕中央的靶盘：只要把文件拖进窗口，松手就入库。
 * 老版本「必须落在圆圈里」等于给每次拖拽加了一道确认，用户拖到侧栏/空白处
 * 都会被判失败；真正需要防的是「拖文件路过窗口」——那种场景光标不会悬停，
 * 这里用 dragenter/dragleave 的覆盖层提示，松手才真正写入。
 * Ctrl+V 不受影响，任何页面都能粘。
 */
export default function GlobalImport({ onImported, onToast }: Props) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<ImportProgress | null>(null);

  const run = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setBusy({ done: 0, total: files.length, saved: 0, failed: 0 });
      const r = await importFiles(files, setBusy);
      setBusy(null);
      if (r.saved) {
        onImported(r.saved);
        // 有失败时把第一条原因带上，否则用户只知道「失败了」却无从下手
        onToast?.(
          r.failed
            ? i18n.t('k114b20a0', { p0: r.saved, p1: r.failed, p2: r.firstError ? `（${r.firstError}）` : '' })
            : i18n.t('k092eb236', { p0: r.saved })
        );
      } else if (r.skipped) {
        onToast?.(i18n.t('kfad63985', { p0: UPLOAD_HINT }));
      } else if (r.failed) {
        onToast?.(i18n.t('k199695f7', { p0: r.failed, p1: r.firstError ? `（${r.firstError}）` : '' }));
      }
    },
    [onImported, onToast]
  );

  /* Ctrl+V：任何页面都能粘，输入框里不劫持（和 Eagle 一致） */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const files = filesFromDataTransfer(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      void run(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [run]);

  /* 拖拽：只要文件进了窗口，松手就入库（不再要求落在固定区域） */
  useEffect(() => {
    const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types || []).includes('Files');

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!hasFiles(dt) || !dt) return;
      e.preventDefault();
      dt.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      // relatedTarget 为空 = 真的离开窗口；子元素间移动不算
      if (!e.relatedTarget) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      setDragging(false);
      if (e.defaultPrevented) return; // 页面内自己接管了（画布按落点放图、文件夹重排等）
      e.preventDefault();
      void run(filesFromDataTransfer(e.dataTransfer));
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [run]);

  return (
    <>
      {dragging && (
        <div className="gi-drop" aria-hidden>
          <div className="gi-drop-box">
            <b>{i18n.t('kc928da5d')}</b>
            <span>{UPLOAD_HINT}</span>
            <em>{i18n.t('k7c3f1c2e')}</em>
          </div>
        </div>
      )}
      {busy && (
        <div className="gi-busy" role="status">
          <span className="gi-busy-dot" />
          正在入库 {busy.done}/{busy.total}
          {busy.saved ? i18n.t('k9aee1908', { p0: busy.saved }) : ''}
          {busy.failed ? i18n.t('k1b84532a', { p0: busy.failed }) : ''}
        </div>
      )}
    </>
  );
}
