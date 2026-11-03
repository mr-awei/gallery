/**
 * 浏览器扩展入口：告诉用户扩展在哪、怎么装。
 * 之前扩展只躺在仓库 extension/ 里，打包不带、界面不提，等于不存在。
 */
import { useEffect, useState } from 'react';
import { api, downloadFile } from '../../api';
import Card from './Card';

type Info = { ok: boolean; dir: string; version: string; name: string; id: string; exists: boolean };

export default function ExtensionSection({ onToast }: { onToast: (msg: string) => void }) {
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
      onToast('扩展目录已复制');
    } catch {
      onToast('复制失败：请手动选中下面的路径');
    }
  };

  const openDir = async () => {
    try {
      await api.openExtensionDir();
      onToast('已在资源管理器打开扩展目录');
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  return (
    <>
      <Card
        title="浏览器扩展（右键采集网页图片）"
        desc="在 Chrome / Edge 里右键任意图片即可存入图库，也能批量抓当前页、截取可见区域。"
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
            <b>安装（只需一次）</b>
            <ol style={{ margin: '6px 0 0', paddingLeft: 20 }}>
              <li>
                打开 <code>chrome://extensions</code>（Edge 是 <code>edge://extensions</code>）
              </li>
              <li>右上角打开「开发者模式」</li>
              <li>
                点「加载已解压的扩展程序」，选中下面这个目录
                {info?.id ? `（装好后 ID 应为 ${info.id}）` : ''}
              </li>
              <li>把工具栏上的「图库采集助手」图标固定出来，之后右键图片就能看到「存入图库」</li>
            </ol>
          </div>

          <div>
            <div className="nav-label" style={{ marginBottom: 6 }}>
              扩展目录
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
              {loading ? '读取中…' : info?.dir || '未找到（请从源码运行时使用仓库里的 extension/ 目录）'}
            </code>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn" onClick={openDir} disabled={!info?.dir}>
              在资源管理器中打开
            </button>
            <button className="btn" onClick={copyPath} disabled={!info?.dir}>
              复制路径
            </button>
            <button className="btn" onClick={() => downloadFile('/api/extension/download')} disabled={!info?.dir}>
              下载扩展 ZIP
            </button>
          </div>

          <div className="hint" style={{ lineHeight: 1.85 }}>
            · 扩展会自动探测本地服务端口（3001–3012），图库没启动时右键会提示「本地图库未启动」。
            <br />· 批量抓取与截图在扩展弹窗里操作，可顺手填关键词和标签。
            <br />· 换电脑或重装浏览器时，把 ZIP 拷过去解压再「加载已解压的扩展程序」即可。
          </div>
        </div>
      </Card>
    </>
  );
}
