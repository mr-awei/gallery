import { useCallback, useEffect, useRef, useState } from 'react';
import { UPLOAD_HINT, filesFromDataTransfer, importFiles, type ImportProgress } from '../lib/importer';

interface Props {
  /** 有文件成功入库后回调，父级据此刷新列表与统计 */
  onImported: (count: number) => void;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
}

/**
 * 全应用级「拖拽 / 粘贴入库」（Eagle 三件套之二）。
 *
 * 拖拽只认中间的圆形采集区：光标扫过窗口只弹靶盘，松手落在靶盘外一律不入库，
 * 也不会把正在用的界面当成投放区（用户拖文件路过窗口时不该突然多出一批素材）。
 * Ctrl+V 不受影响，任何页面都能粘。
 */
export default function GlobalImport({ onImported, onToast }: Props) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<ImportProgress | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

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

  /* 拖拽：光标扫过窗口只弹靶盘，松手必须落在靶盘内才入库 */
  useEffect(() => {
    const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types || []).includes('Files');

    /** 松手点是否落在圆形采集区里（靶盘是视觉圆，判定用外接矩形即可，容错更宽） */
    const onTarget = (e: DragEvent) => {
      const r = boxRef.current?.getBoundingClientRect();
      if (!r) return false;
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!hasFiles(dt) || !dt) return;
      e.preventDefault();
      // 靶盘外显示「不可放置」，用户一眼就知道该往哪拖
      dt.dropEffect = onTarget(e) ? 'copy' : 'none';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      // relatedTarget 为空 = 真的离开窗口；子元素间移动不算
      if (!e.relatedTarget) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      // 先算命中，再收起靶盘（收起后 ref 就没了）
      const ok = onTarget(e);
      setDragging(false);
      if (e.defaultPrevented) return; // 页面内自己接管了
      e.preventDefault();
      if (!ok) {
        onToast?.('把文件拖到中间的圆形采集区再松手才会入库');
        return;
      }
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
  }, [run, onToast]);

  return (
    <>
      {dragging && (
        <div className="gi-drop" aria-hidden>
          <div className="gi-drop-box" ref={boxRef}>
            <b>拖到这里松手</b>
            <span>{UPLOAD_HINT}</span>
            <em>落到别处不会入库</em>
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
