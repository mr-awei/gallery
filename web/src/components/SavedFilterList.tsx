/**
 * 保存的筛选器：把当前筛选栏（关键词 / 类型 / 星级 / 标签 / 文件夹…）整套存成一条，
 * 侧栏一键回到同一视图。和「智能文件夹」的区别：智能文件夹是规则型虚拟夹（会自动收图），
 * 这里只是把一次筛选的现场记下来，不产生新的素材归属。
 */
import type { SavedFilter } from '../types';

interface Props {
  filters: SavedFilter[];
  activeId: number | null;
  onOpen: (f: SavedFilter) => void;
  onSaveCurrent: () => void;
  onEdit: (f: SavedFilter) => void;
  /** 用当前筛选条件覆盖这一条（不用删了重存） */
  onOverwrite: (f: SavedFilter) => void;
  onDelete: (f: SavedFilter) => void;
}

export default function SavedFilterList({
  filters,
  activeId,
  onOpen,
  onSaveCurrent,
  onEdit,
  onOverwrite,
  onDelete,
}: Props) {
  return (
    <div className="saved-filters">
      <div className="side-section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>保存的筛选</span>
        <button
          className="folder-add-btn"
          style={{ marginLeft: 'auto' }}
          title="把当前筛选条件保存下来"
          onClick={onSaveCurrent}
        >
          ＋
        </button>
      </div>
      {filters.length === 0 && (
        <div className="saved-filter-empty">
          调好筛选后点上面的 ＋，下次一键回到这个视图（含当前文件夹）。
        </div>
      )}
      {filters.map((f) => (
        <div
          key={f.id}
          className={`saved-filter-row${f.id === activeId ? ' active' : ''}`}
          onClick={() => onOpen(f)}
          title={`${f.name}（右键可重命名 / 删除）`}
          onContextMenu={(e) => {
            e.preventDefault();
            onEdit(f);
          }}
        >
          <span className="sf-icon">{f.icon || '🔎'}</span>
          <span className="sf-name">{f.name}</span>
          <button
            className="sf-more"
            title="重命名"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(f);
            }}
          >
            ✎
          </button>
          <button
            className="sf-more"
            title="用当前筛选条件覆盖这一条"
            onClick={(e) => {
              e.stopPropagation();
              onOverwrite(f);
            }}
          >
            ↻
          </button>
          <button
            className="sf-more"
            title="删除这个筛选器（不删素材）"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(f);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
