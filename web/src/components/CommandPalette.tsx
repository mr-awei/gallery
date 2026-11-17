import { useEffect, useMemo, useRef, useState } from 'react';
import type { Filters, FolderNode } from '../types';
import i18n from '../i18n';

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
      group: i18n.t('kc2fe6253'),
      run: () => {
        onFilter(patch);
        onClose();
      },
    });
    const rows: Row[] = [];
    const kinds: [string, string][] = [
      ['image', i18n.t('k20def794')],
      ['video', i18n.t('k7fcf42ed')],
      ['gif', 'GIF'],
      ['pdf', 'PDF'],
      ['office', i18n.t('k3739eae5')],
      ['audio', i18n.t('k726dd5df')],
      ['font', i18n.t('k8456bc40')],
      ['model', i18n.t('kd9b444f7')],
      ['design', i18n.t('kfdb21fa1')],
      ['bookmark', i18n.t('k46779389')],
    ];
    rows.push(set({ kind: 'all' }, i18n.t('k97809a52')));
    for (const [k, label] of kinds) rows.push(set({ kind: k }, i18n.t('k71388c2a', { p0: label })));
    rows.push(set({ favorite: 'yes' }, i18n.t('k4af19084')));
    rows.push(set({ favorite: 'no' }, i18n.t('k2ec83e1d')));
    rows.push(set({ seen: 'unseen' }, i18n.t('k73c15dd2')));
    rows.push(set({ seen: 'seen' }, i18n.t('k400ef62a')));
    rows.push(set({ orientation: 'landscape' }, i18n.t('k69f44e15')));
    rows.push(set({ orientation: 'portrait' }, i18n.t('kfcaf3870')));
    rows.push(set({ orientation: 'square' }, i18n.t('kb245b8da')));
    for (const n of [1, 2, 3, 4, 5]) rows.push(set({ minRating: n }, i18n.t('k933366aa', { p0: n })));
    rows.push(set({ minRating: 0 }, i18n.t('k0c96438c')));
    const hues: [string, string][] = [
      ['0', i18n.t('kd088e652')],
      ['1', i18n.t('kb990b42b')],
      ['2', i18n.t('k12401e34')],
      ['3', i18n.t('k84a6ec5a')],
      ['4', i18n.t('k806c4388')],
      ['5', i18n.t('k795167fa')],
      ['6', i18n.t('k1ca69c4b')],
      ['7', i18n.t('k2fc8da52')],
      ['8', i18n.t('kcb2aab0f')],
      ['9', i18n.t('k34e66c72')],
      ['10', i18n.t('ka2f8c821')],
      ['11', i18n.t('k28a3700b')],
      ['gray', i18n.t('k4b90efb3')],
    ];
    for (const [h, label] of hues) rows.push(set({ hue: h, colorHex: '' }, i18n.t('k36bf323a', { p0: label })));
    rows.push(set({ pending: 'noFolder' }, i18n.t('k6df3f102')));
    rows.push(set({ pending: 'noTags' }, i18n.t('kad893a18')));
    rows.push(set({ pending: 'noRating' }, i18n.t('k6c63a137')));
    rows.push(set({ sort: 'new' }, i18n.t('k82d37452')));
    rows.push(set({ sort: 'old' }, i18n.t('k637746c1')));
    rows.push(set({ sort: 'size' }, i18n.t('k8b4d4693')));
    rows.push(set({ sort: 'name' }, i18n.t('kf2316f58')));
    if (filters.q) rows.push(set({ q: '' }, i18n.t('k3962e25d', { p0: filters.q })));
    for (const f of folders || []) {
      rows.push({
        id: `folder:${f.id}`,
        label: f.name,
        group: i18n.t('k1f4c1042'),
        hint: i18n.t('k1bff293f', { p0: f.count ?? 0 }),
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
          placeholder={mode === 'filter' ? i18n.t('kdac1f6ff') : i18n.t('ka9dbf199')}
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
          {rows.length === 0 && <div className="cmd-empty">没有匹配的{mode === 'filter' ? i18n.t('k5148fcc0') : i18n.t('kddf7d2a5')}</div>}
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
