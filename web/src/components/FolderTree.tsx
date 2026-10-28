import { useMemo, useState } from 'react';
import type { FolderNode } from '../types';

/**
 * 侧栏文件夹树：后端返回扁平节点（parent_id），这里组装成树并按名称排序。
 * - 支持折叠子夹；点击文件夹进入对应视图（含后代聚合）
 * - 支持虚拟文件夹管理：根级新建、子夹新建、重命名、删除（hover 显示操作）
 */
interface Props {
  folders: FolderNode[];
  activeId: number | null;
  onOpen: (id: number) => void;
  onCreate: (parentId: number | null) => void;
  onRename: (id: number) => void;
  onDelete: (id: number) => void;
}

export default function FolderTree({ folders, activeId, onOpen, onCreate, onRename, onDelete }: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const tree = useMemo(() => {
    const byParent = new Map<number | null, FolderNode[]>();
    for (const f of folders) {
      const key = f.parent_id ?? null;
      const arr = byParent.get(key) || [];
      arr.push(f);
      byParent.set(key, arr);
    }
    for (const arr of byParent.values()) {
      arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    }
    return byParent;
  }, [folders]);

  const toggleCollapse = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderLevel = (parentId: number | null, depth: number) => {
    const children = tree.get(parentId) || [];
    return children.map((f) => {
      const kids = tree.get(f.id) || [];
      const isCollapsed = collapsed.has(f.id);
      return (
        <div key={f.id} className="folder-node">
          <div className="folder-row" style={{ paddingLeft: depth * 14 }}>
            <button
              type="button"
              className={`folder-item${f.id === activeId ? ' active' : ''}`}
              onClick={() => onOpen(f.id)}
              title={f.name}
            >
              {kids.length ? (
                <span
                  className="folder-chevron"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapse(f.id);
                  }}
                >
                  {isCollapsed ? '▸' : '▾'}
                </span>
              ) : (
                <span className="folder-chevron placeholder" />
              )}
              <span className="folder-name">{f.name}</span>
              {f.count > 0 && <span className="folder-count">{f.count}</span>}
            </button>
            <span className="folder-actions">
              <button title="新建子文件夹" onClick={() => onCreate(f.id)}>＋</button>
              <button title="重命名" onClick={() => onRename(f.id)}>✎</button>
              <button title="删除文件夹（不删图片）" onClick={() => onDelete(f.id)}>✕</button>
            </span>
          </div>
          {!isCollapsed && renderLevel(f.id, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="folder-tree">
      <div className="folder-tree-head">
        <span>文件夹</span>
        <button className="folder-add-btn" title="新建文件夹" onClick={() => onCreate(null)}>
          ＋
        </button>
      </div>
      {renderLevel(null, 0)}
    </div>
  );
}
