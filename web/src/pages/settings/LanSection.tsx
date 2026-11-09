import { useEffect, useState } from 'react';
import { api, withToken } from '../../api';
import type { LanSelfCheck, LanShare, LanStatus } from '../../types';
import Card from './Card';

interface Props {
  onToast: (m: string, kind?: 'info' | 'error') => void;
}

const copyText = (text: string, onToast: Props['onToast']) =>
  navigator.clipboard
    ?.writeText(text)
    .then(() => onToast('地址已复制'))
    .catch(() => onToast('复制失败，请手动选中', 'error'));

/**
 * 二维码 URL 必须带端口 / 令牌 / 网卡指纹。
 * src 字符串不变时浏览器不会重新请求 SVG，端口一换就会一直显示旧端口的二维码
 * —— 手机扫到的是一个没人监听的端口，表现为「网站暂时无法打开」。
 */
async function qrSrc(status: LanStatus, ip: string) {
  const base = await withToken('/api/lan/qrcode.svg');
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}ip=${encodeURIComponent(ip)}&v=${encodeURIComponent(`${status.port}:${status.token}`)}`;
}

const ipOf = (url: string) => url.match(/^https?:\/\/([^:/]+)/)?.[1] || '';

/** 局域网 / 手机扫码投送：开关、二维码、地址、自检、令牌与只读分享 */
export default function LanSection({ onToast }: Props) {
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [qrUrl, setQrUrl] = useState('');
  const [ip, setIp] = useState('');
  const [busy, setBusy] = useState(false);
  const [shares, setShares] = useState<LanShare[]>([]);
  const [shareMinutes, setShareMinutes] = useState(60);
  const [check, setCheck] = useState<LanSelfCheck | null>(null);

  const load = async (preferredIp = '') => {
    try {
      const s = await api.lanStatus();
      setStatus(s);
      const ips = s.ips?.length ? s.ips : s.urls.map(ipOf).filter(Boolean);
      const nextIp = ips.includes(preferredIp) ? preferredIp : ips[0] || '';
      setIp(nextIp);
      setQrUrl(s.enabled && nextIp ? await qrSrc(s, nextIp) : '');
      setCheck(null);
      if (s.enabled) setShares((await api.lanShares()).shares || []);
      else setShares([]);
    } catch (err) {
      onToast(`读取投送状态失败：${(err as Error).message}`, 'error');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const selectIp = async (next: string) => {
    setIp(next);
    if (status?.enabled) setQrUrl(await qrSrc(status, next));
  };

  const act = async (fn: () => Promise<LanStatus>, okMsg: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await load(ip);
      onToast(okMsg);
    } catch (err) {
      onToast(`操作失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const runCheck = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setCheck(await api.lanSelfCheck());
    } catch (err) {
      onToast(`自检失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  // 二维码里编码的地址，与左图严格同源；不显示出来的话端口不一致时根本无从发现
  const qrText = status && ip ? `http://${ip}:${status.port}/?token=${encodeURIComponent(status.token)}` : '';

  return (
    <Card
      title="手机扫码投送"
      desc="同一 Wi-Fi 下用手机扫码，把照片 / 视频直接投送到电脑上的当前资源库。"
      badge={
        <span style={{ color: status?.enabled ? 'var(--ok)' : 'var(--warn)', fontSize: 12, fontWeight: 400 }}>
          {status?.enabled ? '● 已开启' : '○ 默认关闭'}
        </span>
      }
    >
      <div className="switch-row">
        <span>允许局域网访问</span>
        <input
          type="checkbox"
          checked={!!status?.enabled}
          disabled={busy || !status}
          onChange={(e) => void act(() => api.setLanAccess(e.target.checked), e.target.checked ? '已开启投送' : '已关闭投送')}
        />
      </div>
      <div className="hint" style={{ marginBottom: 12 }}>
        主服务始终只监听 127.0.0.1；开启时另起一个独立端口的小服务，只暴露「投送页 + 上传」两个入口，
        使用单独的投送令牌，普通接口 / 设置 / 凭据都摸不到。关闭后外部设备扫不到任何端口。
      </div>

      {status?.enabled && (
        <>
          {ip ? (
            <>
              <div className="settings-subhead">扫码连接</div>
              <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                {qrUrl && (
                  <img
                    key={qrUrl}
                    src={qrUrl}
                    alt="投送二维码"
                    style={{ width: 168, height: 168, background: '#fff', borderRadius: 8, padding: 4 }}
                  />
                )}
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div className="field">
                    <label>二维码内容（与左图完全一致，可直接复制）</label>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <input
                        className="input"
                        style={{ flex: 1, minWidth: 160 }}
                        readOnly
                        value={qrText}
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <button className="btn sm ghost" onClick={() => void copyText(qrText, onToast)}>
                        复制
                      </button>
                      <a
                        className="btn sm ghost"
                        href={qrText}
                        target="_blank"
                        rel="noreferrer"
                        style={{ textDecoration: 'none' }}
                      >
                        本机打开
                      </a>
                    </div>
                  </div>
                  {status.ips?.length > 1 && (
                    <div className="field">
                      <label>二维码使用的网卡地址</label>
                      <select
                        className="select"
                        style={{ width: '100%' }}
                        value={ip}
                        onChange={(e) => void selectIp(e.target.value)}
                      >
                        {status.ips.map((x) => (
                          <option key={x} value={x}>
                            {x} : {status.port}
                          </option>
                        ))}
                      </select>
                      <div className="hint">
                        检测到多个网卡（Wi-Fi / 网线 / 虚拟网卡），选手机实际能连通的那个再重新扫码。
                      </div>
                    </div>
                  )}
                  <div className="hint">
                    投送端口：{status.port}（优先固定 53317，被占用时才由系统分配）
                  </div>
                </div>
              </div>

              <div className="field" style={{ marginTop: 12 }}>
                <label>全部可用地址</label>
                {status.urls.map((u) => (
                  <div key={u} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                    <input className="input" readOnly value={u} onFocus={(e) => e.currentTarget.select()} />
                    <button className="btn sm ghost" onClick={() => void copyText(u, onToast)}>
                      复制
                    </button>
                  </div>
                ))}
              </div>

              <div className="settings-subhead">连不上时先自检</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn sm" disabled={busy} onClick={() => void runCheck()}>
                  本机连通性自检
                </button>
                <button className="btn sm ghost" disabled={busy} onClick={() => void load(ip)}>
                  刷新状态与二维码
                </button>
              </div>
              {check && (
                <div className="hint" style={{ marginTop: 8 }}>
                  {check.results.length
                    ? check.results.map((r) => (
                        <div key={r.ip}>
                          {r.ok ? '✓' : '✗'} {r.ip}:{check.port} {r.ok ? `HTTP ${r.status}` : r.error || '不可达'}
                        </div>
                      ))
                    : '没有检测到可用的局域网 IPv4 地址'}
                </div>
              )}
              <div className="hint" style={{ lineHeight: 1.9 }}>
                自检只验证「电脑自己能连上这个端口」。手机仍打不开时依次确认：
                <br />① 手机与电脑连同一个 Wi-Fi，没开访客 / AP 隔离，也没走蜂窝数据；
                <br />② Windows 防火墙允许图库程序接收入站连接，网络位置设为「专用网络」；
                <br />③ 手机直接输入上面的地址，端口必须与这里显示的 {status.port} 一致 —— 不要扫之前收藏的旧二维码；
                <br />④ 若显示「链接已失效或令牌无效」，说明令牌已轮换，重新扫当前二维码即可。
              </div>

              <div className="settings-subhead">令牌与只读分享</div>
              <div className="field">
                <label>投送令牌（换设备或怀疑泄露时轮换）</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="input" readOnly value={status.token} onFocus={(e) => e.currentTarget.select()} />
                  <button
                    className="btn sm ghost"
                    disabled={busy}
                    onClick={() => void act(() => api.rotateLanToken(), '已生成新令牌，旧二维码立即失效')}
                  >
                    重新生成
                  </button>
                </div>
              </div>
              <div className="field" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <label>只读分享链接（手机 / 另一台设备浏览当前库，不能上传、看不到设置）</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    value={shareMinutes}
                    onChange={(e) => setShareMinutes(Number(e.target.value))}
                    style={{ padding: '6px 8px', borderRadius: 8 }}
                  >
                    <option value={30}>30 分钟</option>
                    <option value={60}>1 小时</option>
                    <option value={180}>3 小时</option>
                    <option value={1440}>1 天</option>
                  </select>
                  <button
                    className="btn sm"
                    disabled={busy}
                    onClick={() =>
                      void (async () => {
                        setBusy(true);
                        try {
                          const r = await api.createLanShare({ minutes: shareMinutes });
                          await load(ip);
                          onToast(`已生成只读链接，${r.minutes} 分钟后失效`);
                        } catch (err) {
                          onToast(`生成失败：${(err as Error).message}`, 'error');
                        } finally {
                          setBusy(false);
                        }
                      })()
                    }
                  >
                    生成链接
                  </button>
                  {shares.length > 0 && (
                    <button
                      className="btn sm ghost"
                      disabled={busy}
                      onClick={() =>
                        void (async () => {
                          setBusy(true);
                          try {
                            const r = await api.revokeLanShares();
                            await load(ip);
                            onToast(`已撤销 ${r.revoked} 条只读链接`);
                          } catch (err) {
                            onToast(`撤销失败：${(err as Error).message}`, 'error');
                          } finally {
                            setBusy(false);
                          }
                        })()
                      }
                    >
                      全部撤销（{shares.length}）
                    </button>
                  )}
                </div>
                <div className="hint">
                  令牌只存在服务端内存里：重启应用或点「撤销」立即失效。链接里的人只能浏览、搜索，不能上传。
                  想分享「选中的素材 / 某个文件夹」，用图库顶栏的 <b>只读分享链接</b> 按钮，可生成二维码并按范围限制可见内容。
                </div>
                {shares.map((s) => {
                  const url = s.urls[0] || '';
                  return (
                    <div key={s.token} style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                      <input className="input" style={{ flex: 1, minWidth: 180 }} readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
                      <span className="hint" style={{ whiteSpace: 'nowrap' }}>
                        {s.title || '未命名'} · {s.scope === 'selection' ? `选区 ${s.ids?.length || 0} 张` : s.scope === 'folder' ? '指定文件夹' : '整个资源库'} ·{' '}
                        {new Date(s.expiresAt).toLocaleString()}
                      </span>
                      <button className="btn sm ghost" onClick={() => void copyText(url, onToast)}>
                        复制
                      </button>
                      <button
                        className="btn sm ghost"
                        onClick={() =>
                          void (async () => {
                            try {
                              await api.revokeLanShare(s.token);
                              await load(ip);
                              onToast('已撤销这条分享链接');
                            } catch (err) {
                              onToast(`撤销失败：${(err as Error).message}`, 'error');
                            }
                          })()
                        }
                      >
                        撤销
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="hint" style={{ color: 'var(--warn)' }}>
              没有检测到可用的局域网 IPv4 地址：请连上 Wi-Fi / 网线后关闭再开启投送。
            </div>
          )}
        </>
      )}
      {!status?.enabled && <div className="hint">{status?.note || '开启后会显示二维码与手机上传页地址。'}</div>}
    </Card>
  );
}
