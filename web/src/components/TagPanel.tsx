import { useEffect, useState, type DragEvent } from 'react';
import { api } from '../api';
import { confirmDialog, promptDialog } from './Dialogs';
import type { TagNode } from '../types';

interface Props {
  /** 全量标签（用来算同级顺序与所属分组） */
  tags: TagNode[];
  /** [分组名, 一级标签] */
  groups: [string, TagNode[]][];
  /** 父标签 → 子标签 */
  childrenOf: Map<string, TagNode[]>;
  activeTag: string;
  onOpenTag: (tag: string) => void;
  onEditTag: (t: TagNode) => void;
  onChanged: (r: { tags: TagNode[]; groups: string[] }) => void;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
}

type DropPos = 'before' | 'after' | 'child';

const COLLAPSE_KEY = 'tuku.tagCollapsed';

const readCollapsed = (): string[] => {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * 侧栏标签面板（Eagle 4 的标签树）：
 * - 分组可折叠，右键可改名 / 删除
 * - 拖动标签到另一标签中部 → 变成它的子标签；拖到上/下边缘 → 同级排序
 * - 拖到分组标题 → 换分组（并回到顶层）
 */
export default function TagPanel({
  tags,
  groups,
  childrenOf,
  activeTag,
  onOpenTag,
  onEditTag,
  onChanged,
  onToast,
}: Props) {
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);
  const [drag, setDrag] = useState('');
  const [hint, setHint] = useState<{ tag: string; pos: DropPos } | null>(null);
  const [groupHint, setGroupHint] = useState('');
  const [menu, setMenu] = useState<{ group: string; x: number; y: number } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
    } catch {
      /* 隐私模式写不进去就只在本次会话生效 */
    }
  }, [collapsed]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [menu]);

  const toggle = (group: string) =>
    setCollapsed((prev) => (prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group]));

  /** 判断 candidate 是不是 ancestor 的子孙，避免把父标签拖进自己的子树 */
  const isDescendant = (candidate: string, ancestor: string): boolean => {
    const stack = [...(childrenOf.get(ancestor) || [])];
    while (stack.length) {
      const node = stack.pop() as TagNode;
      if (node.tag === candidate) return true;
      stack.push(...(childrenOf.get(node.tag) || []));
    }
    return false;
  };

  const siblingsOf = (t: TagNode) =>
    tags
      .filter((x) => (x.group || '') === (t.group || '') && (x.parent || '') === (t.parent || ''))
      .sort(
        (a, b) =>
          (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN')
      );

  const applyDrop = async (target: TagNode) => {
    const pos = hint?.pos;
    setHint(null);
    setGroupHint('');
    const dragged = drag;
    setDrag('');
    if (!dragged || dragged === target.tag || !pos) return;
    try {
      if (pos === 'child') {
        if (isDescendant(target.tag, dragged)) {
          onToast?.('不能把标签拖到自己的子标签下');
          return;
        }
        const r = await api.moveTag(dragged, target.tag);
        onChanged({ tags: r.tags, groups: r.groups });
        onToast?.(`「${dragged}」已归到「${target.tag}」下`);
        return;
      }
      /* 同级排序：先对齐目标的分组/父级，再按新顺序批量写 sort_order */
      const parentOfTarget = target.parent || '';
      if (parentOfTarget && (parentOfTarget === dragged || isDescendant(parentOfTarget, dragged))) {
        onToast?.('不能把标签移动到自己的子标签里');
        return;
      }
      await api.tagMeta({ tag: dragged, group: target.group || '', parent: parentOfTarget });
      const list = siblingsOf(target).filter((x) => x.tag !== dragged);
      const idx = list.findIndex((x) => x.tag === target.tag);
      const order = [...list];
      order.splice(pos === 'before' ? idx : idx + 1, 0, { ...target, tag: dragged });
      const r = await api.reorderTags(order.map((x) => x.tag));
      onChanged({ tags: r.tags, groups: r.groups });
    } catch (err) {
      onToast?.(`移动标签失败：${(err as Error).message}`);
    }
  };

  const moveToGroup = async (group: string) => {
    const dragged = drag;
    setDrag('');
    setGroupHint('');
    if (!dragged) return;
    try {
      const r = await api.tagMeta({ tag: dragged, group: group === '未分组' ? '' : group, parent: '' });
      onChanged({ tags: r.tags, groups: r.groups });
      onToast?.(`「${dragged}」已移到分组「${group}」`);
    } catch (err) {
      onToast?.(`移动失败：${(err as Error).message}`);
    }
  };

  const renameGroup = async (group: string) => {
    setMenu(null);
    const next = await promptDialog(`重命名分组「${group}」为：`, group);
    if (next === null) return;
    const name = next.trim();
    if (!name || name === group) return;
    try {
      const r = await api.renameTagGroup(group, name);
      onChanged({ tags: r.tags, groups: r.groups });
      onToast?.(`分组已改名为「${name}」`);
      setCollapsed((prev) => prev.map((g) => (g === group ? name : g)));
    } catch (err) {
      onToast?.(`改名失败：${(err as Error).message}`);
    }
  };

  const deleteGroup = async (group: string) => {
    setMenu(null);
    if (!(await confirmDialog(`删除分组「${group}」？组内标签会退回「未分组」，标签和图片都不受影响。`))) return;
    try {
      const r = await api.deleteTagGroup(group);
      onChanged({ tags: r.tags, groups: r.groups });
      onToast?.(`分组「${group}」已删除，标签已退回未分组`);
    } catch (err) {
      onToast?.(`删除失败：${(err as Error).message}`);
    }
  };

  const rowDragOver = (e: DragEvent<HTMLButtonElement>, t: TagNode, allowChild: boolean) => {
    if (!drag || drag === t.tag) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / Math.max(1, rect.height);
    const pos: DropPos = allowChild && ratio > 0.3 && ratio < 0.7 ? 'child' : ratio <= 0.5 ? 'before' : 'after';
    setHint({ tag: t.tag, pos });
  };

  const hintClass = (t: TagNode) =>
    hint?.tag === t.tag ? ` drop-${hint.pos}` : '';

  return (
    <div className="tag-panel" onDragEnd={() => { setDrag(''); setHint(null); setGroupHint(''); }}>
      {groups.map(([group, list]) => {
        const isCollapsed = collapsed.includes(group);
        return (
          <div className="tag-group" key={group}>
            <div
              className={`tag-group-name${groupHint === group ? ' drop-target' : ''}`}
              onClick={() => toggle(group)}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                setGroupHint(group);
              }}
              onDragLeave={() => setGroupHint((g) => (g === group ? '' : g))}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void moveToGroup(group);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (group === '未分组') return;
                setMenu({ group, x: e.clientX, y: e.clientY });
              }}
              title={
                group === '未分组'
                  ? '点击折叠 / 展开'
                  : '点击折叠 / 展开 · 把标签拖到这里换组 · 右键改名或删除分组'
              }
            >
              <span className="tag-caret">{isCollapsed ? '▸' : '▾'}</span>
              <span className="tag-group-title">{group}</span>
              <span className="tag-group-count">{list.length}</span>
            </div>

            {!isCollapsed &&
              list.map((t) => (
                <div key={t.tag} className="tag-node">
                  <button
                    className={`tag-row${activeTag === t.tag ? ' active' : ''}${hintClass(t)}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', t.tag);
                      setDrag(t.tag);
                    }}
                    onDragOver={(e) => rowDragOver(e, t, true)}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void applyDrop(t);
                    }}
                    onClick={() => onOpenTag(t.tag)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onEditTag(t);
                    }}
                    title={`${t.tag}（${t.count}）· 右键编辑分组 / 颜色 / 层级 · 拖动可改层级与顺序`}
                  >
                    <span className="tag-dot" style={t.color ? { background: t.color } : undefined} />
                    <span className="tag-name">{t.tag}</span>
                    <span className="tag-count">{t.count}</span>
                  </button>
                  {(childrenOf.get(t.tag) || []).map((c) => (
                    <button
                      key={c.tag}
                      className={`tag-row child${activeTag === c.tag ? ' active' : ''}${hintClass(c)}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', c.tag);
                        setDrag(c.tag);
                      }}
                      onDragOver={(e) => rowDragOver(e, c, false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void applyDrop(c);
                      }}
                      onClick={() => onOpenTag(c.tag)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        onEditTag(c);
                      }}
                      title={`${c.tag}（${c.count}）· 子标签 · 右键编辑元数据`}
                    >
                      <span className="tag-dot" style={c.color ? { background: c.color } : undefined} />
                      <span className="tag-name">{c.tag}</span>
                      <span className="tag-count">{c.count}</span>
                    </button>
                  ))}
                </div>
              ))}
          </div>
        );
      })}
      {!tags.length && <div className="tag-empty">还没有标签，给图片打上标签后会出现在这里</div>}

      {menu && (
        <div
          className="tag-group-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => void renameGroup(menu.group)}>✏ 重命名分组</button>
          <button className="danger" onClick={() => void deleteGroup(menu.group)}>
            🗑 删除分组
          </button>
          <div className="tag-group-menu-note">删除只解散分组，标签与图片都会保留</div>
        </div>
      )}
    </div>
  );
}
