import { IconSearch, IconPencil, IconRotateCw } from './Icons';
/**
 * 保存的筛选器：把当前筛选栏（关键词 / 类型 / 星级 / 标签 / 文件夹…）整套存成一条，
 * 侧栏一键回到同一视图。和「智能文件夹」的区别：智能文件夹是规则型虚拟夹（会自动收图），
 * 这里只是把一次筛选的现场记下来，不产生新的素材归属。
 */
import type { SavedFilter } from '../types';
import i18n from '../i18n';

interface Props {
  filters: SavedFilter[];
  activeId: number | null;
  onOpen: (f: SavedFilter) => void;
  onSaveCurrent: () => void;
  onEdit: (f: SavedFilter) => void;
  /** 用当前筛选条件覆盖这一条（不用删了重存） */
  onOverwrite: (f: SavedFilter) => void;
  onDelete: (f: SavedFilter) => void;
  /** 侧栏已用可折叠分区包住本组件时，隐藏自带标题（＋ 由分区标题栏提供） */
  hideHeader?: boolean;
}

export default function SavedFilterList({
  filters,
  activeId,
  onOpen,
  onSaveCurrent,
  onEdit,
  onOverwrite,
  onDelete,
  hideHeader = false,
}: Props) {
  return (
    <div className="saved-filters">
      {!hideHeader && (
        <div className="side-section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>{i18n.t('k7cdd7d9a')}</span>
          <button
            className="folder-add-btn"
            style={{ marginLeft: 'auto' }}
            title={i18n.t('kf251081d')}
            onClick={onSaveCurrent}
          >
            ＋
          </button>
        </div>
      )}
      {filters.length === 0 && (
        <div className="saved-filter-empty">
          {i18n.t('k3615f81d')}
        </div>
      )}
      {filters.map((f) => (
        <div
          key={f.id}
          className={`saved-filter-row${f.id === activeId ? ' active' : ''}`}
          onClick={() => onOpen(f)}
          title={i18n.t('k61989061', { p0: f.name })}
          onContextMenu={(e) => {
            e.preventDefault();
            onEdit(f);
          }}
        >
          <span className="sf-icon">{f.icon || <IconSearch size={13} />}</span>
          <span className="sf-name">{f.name}</span>
          <button
            className="sf-more"
            title={i18n.t('kc8ce4b36')}
            onClick={(e) => {
              e.stopPropagation();
              onEdit(f);
            }}
          >
            <IconPencil size={13} />
          </button>
          <button
            className="sf-more"
            title={i18n.t('k4d79c7f5')}
            onClick={(e) => {
              e.stopPropagation();
              onOverwrite(f);
            }}
          >
            <IconRotateCw size={13} />
          </button>
          <button
            className="sf-more"
            title={i18n.t('k1f2420ed')}
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
