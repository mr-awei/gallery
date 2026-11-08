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
      setError(`「${displayBinding(binding)}」已经被「${other?.label || clash}」占用，换一个吧`);
      return;
    }
    setKey(action, binding);
    setRecording(null);
    setError('');
  };

  return (
    <Card title="快捷键" desc="点「录制」后直接按下想要的组合键；Esc 取消。改完立即生效，无需重启。">
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
              {recording === a.id ? '按下组合键…' : displayBinding(keymap[a.id])}
            </kbd>
            <button
              className={`btn sm${recording === a.id ? ' primary' : ''}`}
              onClick={() => {
                setRecording(recording === a.id ? null : a.id);
                setError('');
              }}
              onKeyDown={(e) => recording === a.id && capture(e, a.id)}
              title={recording === a.id ? '按下要绑定的键（Esc 取消）' : '重新绑定'}
            >
              {recording === a.id ? '取消' : '录制'}
            </button>
            <button
              className="btn sm"
              title="恢复这个动作的默认键位"
              onClick={() => {
                setKey(a.id, DEFAULT_KEYMAP[a.id]);
                setError('');
              }}
            >
              默认
            </button>
          </div>
        ))}
      </div>

      {error && <div className="settings-desc" style={{ color: 'var(--err)', marginTop: 10 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={reset} title="把全部动作恢复成出厂键位">
          全部恢复默认
        </button>
      </div>
      <div className="settings-desc" style={{ marginTop: 8 }}>
        大图预览 / 标注 / 裁切台内部的按键是场景专用的，不在这里改。
      </div>
    </Card>
  );
}
