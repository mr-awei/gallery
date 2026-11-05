import { useCallback, useEffect, useRef, useState } from 'react';
import { UPLOAD_HINT, filesFromDataTransfer, importFiles, type ImportProgress } from '../lib/importer';

interface Props {
  /** 有文件成功入库后回调，父级据此刷新列表与统计 */
  onImported: (count: number) => void;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
}

/**
 * 全应用级「拖拽 / 粘贴入库」（Eagle 三件套之二）。
 * 图库页自己接管拖拽时会 preventDefault，这里就自动让位，避免同一批文件入库两次。
 */
export default function GlobalImport({ onImported, onToast }: Props) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<ImportProgress | null>(null);
  const depth = useRef(0);

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
            ? `入库完成：${r.saved} 成功 / ${r.failed} 失败${r.firstError ? `（${r.firstError}）` : ''}`
            : `已入库 ${r.saved} 个文件`
        );
      } else if (r.skipped) {
        onToast?.(`没有可入库的文件（${UPLOAD_HINT}）`);
      } else if (r.failed) {
        onToast?.(`入库失败：${r.failed} 个文件未通过${r.firstError ? `（${r.firstError}）` : ''}`);
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

  /* 拖拽：覆盖整个窗口，非图库页直接松手入库 */
  useEffect(() => {
    const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types || []).includes('Files');
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer) || e.defaultPrevented) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      depth.current = 0;
      setDragging(false);
      if (e.defaultPrevented) return; // 图库页已自带进度条处理
      e.preventDefault();
      void run(filesFromDataTransfer(e.dataTransfer));
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
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
            <b>松手入库</b>
            <span>{UPLOAD_HINT}</span>
          </div>
        </div>
      )}
      {busy && (
        <div className="gi-busy" role="status">
          <span className="gi-busy-dot" />
          正在入库 {busy.done}/{busy.total}
          {busy.saved ? ` · 成功 ${busy.saved}` : ''}
          {busy.failed ? ` · 失败 ${busy.failed}` : ''}
        </div>
      )}
    </>
  );
}
