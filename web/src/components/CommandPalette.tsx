import { useEffect, useMemo, useRef, useState } from 'react';
import type { Filters, FolderNode } from '../types';

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  hint?: string;
  run: () => void | Promise<void>;
}

interface Props {
  open: boolean;
  /** command = Ctrl+K 全部命令；filter = Alt+F 筛选器搜索 */
  mode: 'command' | 'filter';
  onClose: () => void;
  commands: PaletteCommand[];
  filters: Filters;
  onFilter: (patch: Partial<Filters>) => void;
  folders?: FolderNode[];
  onOpenFolder?: (id: number) => void;
}

interface Row {
  id: string;
  label: string;
  group: string;
  hint?: string;
  run: () => void | Promise<void>;
}

/**
 * 命令面板（Ctrl+K）与筛选器搜索（Alt+F）共用一套键盘操作：
 * ↑↓ 选择、Enter 执行、Esc 关闭。筛选项直接改当前筛选条件，不再翻侧栏。
 */
export default function CommandPalette({
  open,
  mode,
  onClose,
  commands,
  filters,
  onFilter,
  folders,
  onOpenFolder,
}: Props) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setIdx(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open, mode]);

  const filterRows = useMemo<Row[]>(() => {
    const set = (patch: Partial<Filters>, label: string): Row => ({
      id: `f:${label}`,
      label,
      group: '筛选',
      run: () => {
        onFilter(patch);
        onClose();
      },
    });
    const rows: Row[] = [];
    const kinds: [string, string][] = [
      ['image', '图片'],
      ['video', '视频'],
      ['gif', 'GIF'],
      ['pdf', 'PDF'],
      ['office', 'Office 文档'],
      ['audio', '音频'],
      ['font', '字体'],
      ['model', '3D 模型'],
      ['design', '设计稿'],
      ['bookmark', '书签'],
    ];
    rows.push(set({ kind: 'all' }, '类型：全部'));
    for (const [k, label] of kinds) rows.push(set({ kind: k }, `类型：${label}`));
    rows.push(set({ favorite: 'yes' }, '收藏：仅收藏'));
    rows.push(set({ favorite: 'no' }, '收藏：未收藏'));
    rows.push(set({ seen: 'unseen' }, '查看：未看过'));
    rows.push(set({ seen: 'seen' }, '查看：已看过'));
    rows.push(set({ orientation: 'landscape' }, '方向：横图'));
    rows.push(set({ orientation: 'portrait' }, '方向：竖图'));
    rows.push(set({ orientation: 'square' }, '方向：方图'));
    for (const n of [1, 2, 3, 4, 5]) rows.push(set({ minRating: n }, `星级：${n} 星及以上`));
    rows.push(set({ minRating: 0 }, '星级：不限'));
    const hues: [string, string][] = [
      ['0', '红'],
      ['1', '橙'],
      ['2', '黄'],
      ['3', '黄绿'],
      ['4', '绿'],
      ['5', '青绿'],
      ['6', '青'],
      ['7', '蓝'],
      ['8', '蓝紫'],
      ['9', '紫'],
      ['10', '品红'],
      ['11', '粉红'],
      ['gray', '黑白灰'],
    ];
    for (const [h, label] of hues) rows.push(set({ hue: h, colorHex: '' }, `色系：${label}`));
    rows.push(set({ pending: 'noFolder' }, '待整理：未分类'));
    rows.push(set({ pending: 'noTags' }, '待整理：无标签'));
    rows.push(set({ pending: 'noRating' }, '待整理：未评分'));
    rows.push(set({ sort: 'new' }, '排序：最新入库'));
    rows.push(set({ sort: 'old' }, '排序：最早入库'));
    rows.push(set({ sort: 'size' }, '排序：文件最大'));
    rows.push(set({ sort: 'name' }, '排序：按名称'));
    if (filters.q) rows.push(set({ q: '' }, `清除关键词「${filters.q}」`));
    for (const f of folders || []) {
      rows.push({
        id: `folder:${f.id}`,
        label: f.name,
        group: '文件夹',
        hint: `${f.count ?? 0} 张`,
        run: () => {
          onOpenFolder?.(f.id);
          onClose();
        },
      });
    }
    return rows;
  }, [filters.q, folders, onClose, onFilter, onOpenFolder]);

  const source = mode === 'filter' ? filterRows : commands;
  const rows = useMemo(() => {
    const key = q.trim().toLowerCase();
    const list = source.filter((r) => !key || `${r.group} ${r.label} ${r.hint || ''}`.toLowerCase().includes(key));
    return list.slice(0, 80);
  }, [source, q]);

  useEffect(() => setIdx(0), [q, mode]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${idx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  if (!open) return null;

  const exec = (row?: Row) => {
    if (!row) return;
    onClose();
    void row.run();
  };

  return (
    <div className="modal-backdrop cmd-backdrop" onClick={onClose}>
      <div className="modal-card cmd-card" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmd-input"
          placeholder={mode === 'filter' ? '搜筛选条件：类型 / 星级 / 色系 / 文件夹…' : '输入命令：导出 / 拼接 / 对比 / 工具箱 / 设置…'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIdx((i) => Math.min(rows.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              exec(rows[idx]);
            }
          }}
        />
        <div className="cmd-list" ref={listRef}>
          {rows.length === 0 && <div className="cmd-empty">没有匹配的{mode === 'filter' ? '筛选条件' : '命令'}</div>}
          {rows.map((r, i) => {
            const prev = rows[i - 1];
            return (
              <div key={r.id}>
                {(!prev || prev.group !== r.group) && <div className="cmd-group">{r.group}</div>}
                <button
                  data-i={i}
                  className={`cmd-item${i === idx ? ' on' : ''}`}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => exec(r)}
                >
                  <span>{r.label}</span>
                  {r.hint && <small>{r.hint}</small>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
