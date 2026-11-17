import i18n from '../i18n';
/**
 * 主内容区上方的「有数据没能加载出来」错误条。
 * 明确说没加载出来，而不是让界面装作「没有数据」。
 */

export default function LoadErrorBar({
  error,
  onRetry,
  onClose,
}: {
  error: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        margin: '10px 16px 0',
        padding: '8px 12px',
        borderRadius: 8,
        background: 'rgba(255, 107, 107, 0.12)',
        border: '1px solid rgba(255, 107, 107, 0.35)',
        color: '#ffb4b4',
        fontSize: 12.5,
      }}
    >
      <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
        {i18n.t('k0dda54a3')}{error}
      </span>
      <button className="btn sm" onClick={onRetry}>
        {i18n.t('k132c5cdc')}
      </button>
      <button className="icon-btn" title={i18n.t('kb15d9127')} onClick={onClose}>
        ×
      </button>
    </div>
  );
}
