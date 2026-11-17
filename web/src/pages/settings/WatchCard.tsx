import { useEffect, useState } from 'react';
import { api } from '../../api';
import Card from './Card';
import i18n from '../../i18n';

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
      onToast(next ? i18n.t('kd64c4135') : i18n.t('k66ddd911'));
    } catch (err) {
      setEnabled(!next);
      onToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={i18n.t('k3e93f4b7')}
      desc={i18n.t('ka054c844')}
    >
      <div className="switch-row">
        <span>
          {i18n.t('kaa3ca655')}
          <span className="hint">　{i18n.t('k12901b47')}</span>
        </span>
        <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
      </div>
      <div className="settings-desc" style={{ marginTop: 10 }}>
        {i18n.t('k401ad153')}<code>{dir || i18n.t('kc9be43d3')}</code>
      </div>
      <div className="settings-desc" style={{ marginBottom: 0 }}>
        {i18n.t('kb8371f20')}
      </div>
    </Card>
  );
}
