import { IconClose } from './Icons';
import { displayBinding, useKeymap } from '../lib/keymap';
import i18n from '../i18n';

/** 快捷键帮助面板（按 ? 随时打开），只列真实现过的键，避免文档骗人。
 *  主窗口那几项跟随「设置 → 快捷键」里的自定义值实时变化。 */
export default function HotkeyHelp({ onClose }: { onClose: () => void }) {
  const { keymap } = useKeymap();
  const groups: { title: string; rows: [string, string][] }[] = [
    {
      title: i18n.t('k292a63a1'),
      rows: [
        [displayBinding(keymap.palette), i18n.t('k5075f772')],
        [displayBinding(keymap.filter), i18n.t('k0f01a411')],
        [i18n.t('k0c3ee9cf', { p0: displayBinding(keymap.search) }), i18n.t('kb0f61d34')],
        [displayBinding(keymap.quickPreview), i18n.t('k16fa4f11')],
        [displayBinding(keymap.selectAll), i18n.t('k59e4f3bf')],
        [displayBinding(keymap.delete), i18n.t('k6c58b289')],
        [displayBinding(keymap.undo), i18n.t('k20e7e920')],
        [displayBinding(keymap.help), i18n.t('k01422122')],
      ],
    },
    {
      title: i18n.t('k20e5c5b4'),
      rows: [
        ['← / →', i18n.t('k196b34c2')],
        [i18n.t('kfcbc6a64'), i18n.t('k2f5c71d3')],
        ['+ / - / 0', i18n.t('k19dd6cd1')],
        ['1 ~ 5', i18n.t('k56f0d705')],
        ['i', i18n.t('kd4aab14c')],
        ['Esc', i18n.t('k9bbb3188')],
      ],
    },
    {
      title: i18n.t('k3965a15e'),
      rows: [
        ['Ctrl / ⌘ + Z', i18n.t('k6f9f9020')],
        ['Ctrl / ⌘ + Shift + Z', i18n.t('kc3c873d3')],
        ['Delete', i18n.t('k8f4035fb')],
        ['Esc', i18n.t('k1772590f')],
      ],
    },
    {
      title: i18n.t('k0d98c747'),
      rows: [
        [i18n.t('kebfd5832'), i18n.t('k20a0c156')],
        ['Esc', i18n.t('k85d8f743')],
      ],
    },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card hk-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{i18n.t('k867ade50')}</b>
          <button className="icon-btn" onClick={onClose} title={i18n.t('kb15d9127')}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body hk-body">
          {groups.map((g) => (
            <div key={g.title} className="hk-group">
              <div className="hk-title">{g.title}</div>
              {g.rows.map(([k, d]) => (
                <div key={k} className="hk-row">
                  <kbd>{k}</kbd>
                  <span>{d}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <span className="exp-hint">{i18n.t('k5e0e0489')}</span>
          <button className="btn sm primary" onClick={onClose}>
            {i18n.t('kce26955a')}
          </button>
        </div>
      </div>
    </div>
  );
}
