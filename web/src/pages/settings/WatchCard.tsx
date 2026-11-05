import { useEffect, useState } from 'react';
import { api } from '../../api';
import Card from './Card';

/**
 * 文件夹监控自动导入。
 *
 * 机制：服务端对「素材文件夹」做递归 fs.watch，2 秒防抖后把新增/改动的文件登记进库
 * （改名同步元数据、新文件自动入库、删文件进回收站）。这里只负责开关与说明，
 * 真正的监听在 server/importer.js，不随窗口开关而停。
 */
export default function WatchCard({ onToast }: { onToast: (msg: string, kind?: 'info' | 'error') => void }) {
  const [enabled, setEnabled] = useState(true);
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .settings()
      .then((s) => {
        setEnabled(s.watchEnabled !== false);
        setDir(s.storageDir || '');
      })
      .catch(() => {
        /* 读不到就按默认开显示；开关本身出错时会有 toast */
      });
  }, []);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setEnabled(next); // 先反馈，失败再回滚
    try {
      const s = await api.saveSettings({ watchEnabled: next });
      setEnabled(s.watchEnabled !== false);
      setDir(s.storageDir || '');
      onToast(next ? '已开启文件夹监控：丢进素材文件夹即自动入库' : '已暂停文件夹监控');
    } catch (err) {
      setEnabled(!next);
      onToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="文件夹监控（自动导入）"
      desc="往素材文件夹里拖文件、截图工具直接存进去、外部程序改名——不用回软件点导入，几秒后列表自己更新。"
    >
      <div className="switch-row">
        <span>
          自动导入新文件
          <span className="hint">　递归监听整个素材文件夹；回收站/缩略图/.tuku/.library 已排除</span>
        </span>
        <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
      </div>
      <div className="settings-desc" style={{ marginTop: 10 }}>
        当前监控目录：<code>{dir || '未设置（先在「数据与维护」里选择素材文件夹）'}</code>
      </div>
      <div className="settings-desc" style={{ marginBottom: 0 }}>
        停用后不会再自动登记，但已经入库的素材不受影响；重新开启不需要重启。
      </div>
    </Card>
  );
}
