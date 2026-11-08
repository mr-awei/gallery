import { IconClose } from './Icons';
import { displayBinding, useKeymap } from '../lib/keymap';

/** 快捷键帮助面板（按 ? 随时打开），只列真实现过的键，避免文档骗人。
 *  主窗口那几项跟随「设置 → 快捷键」里的自定义值实时变化。 */
export default function HotkeyHelp({ onClose }: { onClose: () => void }) {
  const { keymap } = useKeymap();
  const groups: { title: string; rows: [string, string][] }[] = [
    {
      title: '主窗口（可在设置里改）',
      rows: [
        [displayBinding(keymap.palette), '打开 / 关闭命令面板'],
        [displayBinding(keymap.filter), '筛选器搜索：类型 / 星级 / 色系 / 文件夹'],
        [`${displayBinding(keymap.search)} 或 /`, '聚焦搜索框'],
        [displayBinding(keymap.quickPreview), '快速预览鼠标下的素材；预览中再按一次关闭'],
        [displayBinding(keymap.selectAll), '全选当前筛选下的全部素材（不只是已加载的一页）'],
        [displayBinding(keymap.delete), '删除选中的素材'],
        [displayBinding(keymap.undo), '撤销最近一次编辑（裁切/旋转/调色/增强的覆盖写回）'],
        [displayBinding(keymap.help), '打开 / 关闭这个面板'],
      ],
    },
    {
      title: '大图浏览',
      rows: [
        ['← / →', '上一张 / 下一张'],
        ['空格', '视频/音频播放暂停；静态图再按空格关闭预览'],
        ['+ / - / 0', '放大 / 缩小 / 还原'],
        ['1 ~ 5', '给当前素材打星（再按一次取消）'],
        ['i', '打开 / 关闭右侧信息面板'],
        ['Esc', '关闭预览（菜单/播放中会先收一层）'],
      ],
    },
    {
      title: '图上标注',
      rows: [
        ['Ctrl / ⌘ + Z', '撤销上一笔'],
        ['Ctrl / ⌘ + Shift + Z', '重做'],
        ['Delete', '删除选中的标注'],
        ['Esc', '取消选中 / 退出标注'],
      ],
    },
    {
      title: '其他',
      rows: [
        ['双击卡片', '打开大图'],
        ['Esc', '关闭弹窗，或取消多选'],
      ],
    },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card hk-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>键盘快捷键</b>
          <button className="icon-btn" onClick={onClose} title="关闭">
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
          <span className="exp-hint">大图打开时同样生效，输入框内不会触发</span>
          <button className="btn sm primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
