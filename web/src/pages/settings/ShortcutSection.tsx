import { useState } from 'react';
import {
  DEFAULT_KEYMAP,
  KEY_ACTIONS,
  bindingOf,
  displayBinding,
  findConflict,
  useKeymap,
  type KeyAction,
} from '../../lib/keymap';
import Card from './Card';
import i18n from '../../i18n';

/**
 * 快捷键自定义。
 *
 * 只改「主窗口里的全局动作」；大图 / 标注 / 工作台的键位是场景内的，固定不让改，
 * 否则同一次按键在不同场景下含义会互相打架。
 */
export default function ShortcutSection() {
  const { keymap, setKey, reset } = useKeymap();
  const [recording, setRecording] = useState<KeyAction | null>(null);
  const [error, setError] = useState('');

  const capture = (e: React.KeyboardEvent, action: KeyAction) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecording(null);
      setError('');
      return;
    }
    // 只按下修饰键时先别收：用户还要接着按主键
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const binding = bindingOf(e.nativeEvent);
    const clash = findConflict(keymap, action, binding);
    if (clash) {
      const other = KEY_ACTIONS.find((x) => x.id === clash);
      setError(i18n.t('k87dd29f3', { p0: displayBinding(binding), p1: other?.label || clash }));
      return;
    }
    setKey(action, binding);
    setRecording(null);
    setError('');
  };

  return (
    <Card title={i18n.t('kf7d29966')} desc={i18n.t('kc26b4d65')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {KEY_ACTIONS.map((a) => (
          <div
            key={a.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '7px 10px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              borderColor: recording === a.id ? 'var(--accent)' : 'var(--border)',
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13.5 }}>{a.label}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{a.desc}</div>
            </div>
            <kbd style={{ minWidth: 72, textAlign: 'center' }}>
              {recording === a.id ? i18n.t('kb308eff6') : displayBinding(keymap[a.id])}
            </kbd>
            <button
              className={`btn sm${recording === a.id ? ' primary' : ''}`}
              onClick={() => {
                setRecording(recording === a.id ? null : a.id);
                setError('');
              }}
              onKeyDown={(e) => recording === a.id && capture(e, a.id)}
              title={recording === a.id ? i18n.t('kdb0be38b') : i18n.t('k2eb89a4a')}
            >
              {recording === a.id ? i18n.t('k625fb26b') : i18n.t('kedf74d55')}
            </button>
            <button
              className="btn sm"
              title={i18n.t('k71a2274c')}
              onClick={() => {
                setKey(a.id, DEFAULT_KEYMAP[a.id]);
                setError('');
              }}
            >
              {i18n.t('k18c63459')}
            </button>
          </div>
        ))}
      </div>

      {error && <div className="settings-desc" style={{ color: 'var(--err)', marginTop: 10 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={reset} title={i18n.t('k21bf7024')}>
          {i18n.t('ka09e58c6')}
        </button>
      </div>
      <div className="settings-desc" style={{ marginTop: 8 }}>
        {i18n.t('k162e57b0')}
      </div>
    </Card>
  );
}
