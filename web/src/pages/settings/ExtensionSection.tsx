/**
 * 浏览器扩展入口：告诉用户扩展在哪、怎么装。
 * 之前扩展只躺在仓库 extension/ 里，打包不带、界面不提，等于不存在。
 */
import { useEffect, useState } from 'react';
import { api, downloadFile } from '../../api';
import Card from './Card';
import i18n from '../../i18n';

type Info = { ok: boolean; dir: string; version: string; name: string; id: string; exists: boolean };

export default function ExtensionSection({ onToast }: { onToast: (msg: string, kind?: 'info' | 'error') => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api
      .extensionInfo()
      .then((r) => {
        if (alive) setInfo(r);
      })
      .catch(() => {
        /* 服务不可用时保持 null，界面给手动说明 */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const copyPath = async () => {
    if (!info?.dir) return;
    try {
      await navigator.clipboard.writeText(info.dir);
      onToast(i18n.t('k0e004612'));
    } catch {
      onToast(i18n.t('kf836c6a1'));
    }
  };

  const openDir = async () => {
    try {
      await api.openExtensionDir();
      onToast(i18n.t('k5a74c633'));
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };

  return (
    <>
      <Card
        title={i18n.t('ka2ff388a')}
        desc={i18n.t('ke661f6e5')}
        badge={
          info?.version ? (
            <span className="badge" style={{ marginLeft: 8 }}>
              v{info.version}
            </span>
          ) : undefined
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="hint" style={{ lineHeight: 1.9 }}>
            <b>{i18n.t('ka4ce7f98')}</b>
            <ol style={{ margin: '6px 0 0', paddingLeft: 20 }}>
              <li>
                {i18n.t('kd7098f50')} <code>chrome://extensions</code>{i18n.t('ke110a80b')} <code>edge://extensions</code>）
              </li>
              <li>{i18n.t('k82acf617')}</li>
              <li>
                点「加载已解压的扩展程序」，选中下面这个目录
                {info?.id ? i18n.t('k9f2b35b0', { p0: info.id }) : ''}
              </li>
              <li>{i18n.t('kf43c5a8d')}</li>
            </ol>
          </div>

          <div>
            <div className="nav-label" style={{ marginBottom: 6 }}>
              {i18n.t('kf4ba54bc')}
            </div>
            <code
              style={{
                display: 'block',
                padding: '9px 11px',
                borderRadius: 8,
                background: 'var(--panel-strong)',
                fontSize: 12.5,
                wordBreak: 'break-all',
                lineHeight: 1.6,
              }}
            >
              {loading ? i18n.t('k8b5015f0') : info?.dir || i18n.t('kea06ce9e')}
            </code>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn" onClick={openDir} disabled={!info?.dir}>
              {i18n.t('k81172701')}
            </button>
            <button className="btn" onClick={copyPath} disabled={!info?.dir}>
              {i18n.t('kf4130cae')}
            </button>
            <button className="btn" onClick={() => downloadFile('/api/extension/download')} disabled={!info?.dir}>
              {i18n.t('k796af85f')}
            </button>
          </div>

          <div className="hint" style={{ lineHeight: 1.85 }}>
            {i18n.t('kd800778e')}
            <br />{i18n.t('kec7aba4c')}
            <br />{i18n.t('kd4a17284')}
          </div>
        </div>
      </Card>
    </>
  );
}
