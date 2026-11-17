import { useEffect, useState } from 'react';
import { api, withToken } from '../../api';
import type { LanSelfCheck, LanShare, LanStatus } from '../../types';
import Card from './Card';
import i18n from '../../i18n';

interface Props {
  onToast: (m: string, kind?: 'info' | 'error') => void;
}

const copyText = (text: string, onToast: Props['onToast']) =>
  navigator.clipboard
    ?.writeText(text)
    .then(() => onToast(i18n.t('kd988ff0f')))
    .catch(() => onToast(i18n.t('k63e6737e'), 'error'));

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
      onToast(i18n.t('k47db8442', { p0: (err as Error).message }), 'error');
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
      onToast(i18n.t('kf97c1cd6', { p0: (err as Error).message }), 'error');
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
      onToast(i18n.t('k5b6a6f12', { p0: (err as Error).message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  // 二维码里编码的地址，与左图严格同源；不显示出来的话端口不一致时根本无从发现
  const qrText = status && ip ? `http://${ip}:${status.port}/?token=${encodeURIComponent(status.token)}` : '';

  return (
    <Card
      title={i18n.t('kf0573db3')}
      desc={i18n.t('kf15b3b01')}
      badge={
        <span style={{ color: status?.enabled ? 'var(--ok)' : 'var(--warn)', fontSize: 12, fontWeight: 400 }}>
          {status?.enabled ? i18n.t('k231749e8') : i18n.t('k69db19fc')}
        </span>
      }
    >
      <div className="switch-row">
        <span>{i18n.t('k29f028d1')}</span>
        <input
          type="checkbox"
          checked={!!status?.enabled}
          disabled={busy || !status}
          onChange={(e) => void act(() => api.setLanAccess(e.target.checked), e.target.checked ? i18n.t('k29f98d08') : i18n.t('kd35ebfd3'))}
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
              <div className="settings-subhead">{i18n.t('ka118a2b0')}</div>
              <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                {qrUrl && (
                  <img
                    key={qrUrl}
                    src={qrUrl}
                    alt={i18n.t('kb1786fcc')}
                    style={{ width: 168, height: 168, background: '#fff', borderRadius: 8, padding: 4 }}
                  />
                )}
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div className="field">
                    <label>{i18n.t('k15719cc8')}</label>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <input
                        className="input"
                        style={{ flex: 1, minWidth: 160 }}
                        readOnly
                        value={qrText}
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <button className="btn sm ghost" onClick={() => void copyText(qrText, onToast)}>
                        {i18n.t('k79d3abe9')}
                      </button>
                      <a
                        className="btn sm ghost"
                        href={qrText}
                        target="_blank"
                        rel="noreferrer"
                        style={{ textDecoration: 'none' }}
                      >
                        {i18n.t('kd280f640')}
                      </a>
                    </div>
                  </div>
                  {status.ips?.length > 1 && (
                    <div className="field">
                      <label>{i18n.t('k1c9860bd')}</label>
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
                        {i18n.t('ka23e5fec')}
                      </div>
                    </div>
                  )}
                  <div className="hint">
                    投送端口：{status.port}（优先固定 53317，被占用时才由系统分配）
                  </div>
                </div>
              </div>

              <div className="field" style={{ marginTop: 12 }}>
                <label>{i18n.t('kce5aaad9')}</label>
                {status.urls.map((u) => (
                  <div key={u} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                    <input className="input" readOnly value={u} onFocus={(e) => e.currentTarget.select()} />
                    <button className="btn sm ghost" onClick={() => void copyText(u, onToast)}>
                      {i18n.t('k79d3abe9')}
                    </button>
                  </div>
                ))}
              </div>

              <div className="settings-subhead">{i18n.t('k4b7b6967')}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn sm" disabled={busy} onClick={() => void runCheck()}>
                  {i18n.t('k2fcef81e')}
                </button>
                <button className="btn sm ghost" disabled={busy} onClick={() => void load(ip)}>
                  {i18n.t('kb2d9678c')}
                </button>
              </div>
              {check && (
                <div className="hint" style={{ marginTop: 8 }}>
                  {check.results.length
                    ? check.results.map((r) => (
                        <div key={r.ip}>
                          {r.ok ? '✓' : '✗'} {r.ip}:{check.port} {r.ok ? `HTTP ${r.status}` : r.error || i18n.t('k834f7cd8')}
                        </div>
                      ))
                    : i18n.t('k6fa26a77')}
                </div>
              )}
              <div className="hint" style={{ lineHeight: 1.9 }}>
                {i18n.t('k2ad591b0')}
                <br />{i18n.t('kc1027715')}
                <br />{i18n.t('k410d211a')}
                <br />③ 手机直接输入上面的地址，端口必须与这里显示的 {status.port} 一致 —— 不要扫之前收藏的旧二维码；
                <br />{i18n.t('kd6dfcddc')}
              </div>

              <div className="settings-subhead">{i18n.t('kcf4358f0')}</div>
              <div className="field">
                <label>{i18n.t('k4474501e')}</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="input" readOnly value={status.token} onFocus={(e) => e.currentTarget.select()} />
                  <button
                    className="btn sm ghost"
                    disabled={busy}
                    onClick={() => void act(() => api.rotateLanToken(), i18n.t('k463b71bd'))}
                  >
                    {i18n.t('ka7c23201')}
                  </button>
                </div>
              </div>
              <div className="field" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <label>{i18n.t('k052757a1')}</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    value={shareMinutes}
                    onChange={(e) => setShareMinutes(Number(e.target.value))}
                    style={{ padding: '6px 8px', borderRadius: 8 }}
                  >
                    <option value={30}>{i18n.t('ke856b618')}</option>
                    <option value={60}>{i18n.t('k7a3bc120')}</option>
                    <option value={180}>{i18n.t('k1ee83072')}</option>
                    <option value={1440}>{i18n.t('k78c2dcbe')}</option>
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
                          onToast(i18n.t('k90daa62e', { p0: r.minutes }));
                        } catch (err) {
                          onToast(i18n.t('k7f52ecb6', { p0: (err as Error).message }), 'error');
                        } finally {
                          setBusy(false);
                        }
                      })()
                    }
                  >
                    {i18n.t('k8b16b9cc')}
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
                            onToast(i18n.t('k8d5416a0', { p0: r.revoked }));
                          } catch (err) {
                            onToast(i18n.t('k5b0be54d', { p0: (err as Error).message }), 'error');
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
                  想分享「选中的素材 / 某个文件夹」，用图库顶栏的 <b>{i18n.t('ka14f1a96')}</b> {i18n.t('kf47fa007')}
                </div>
                {shares.map((s) => {
                  const url = s.urls[0] || '';
                  return (
                    <div key={s.token} style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                      <input className="input" style={{ flex: 1, minWidth: 180 }} readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
                      <span className="hint" style={{ whiteSpace: 'nowrap' }}>
                        {s.title || i18n.t('k7f0425a8')} · {s.scope === 'selection' ? i18n.t('k61f7feaa', { p0: s.ids?.length || 0 }) : s.scope === 'folder' ? i18n.t('kde88d21d') : i18n.t('kcff473ab')} ·{' '}
                        {new Date(s.expiresAt).toLocaleString()}
                      </span>
                      <button className="btn sm ghost" onClick={() => void copyText(url, onToast)}>
                        {i18n.t('k79d3abe9')}
                      </button>
                      <button
                        className="btn sm ghost"
                        onClick={() =>
                          void (async () => {
                            try {
                              await api.revokeLanShare(s.token);
                              await load(ip);
                              onToast(i18n.t('k2ca6e04c'));
                            } catch (err) {
                              onToast(i18n.t('k5b0be54d', { p0: (err as Error).message }), 'error');
                            }
                          })()
                        }
                      >
                        {i18n.t('kbd9fcf46')}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="hint" style={{ color: 'var(--warn)' }}>
              {i18n.t('k7ad32d5a')}
            </div>
          )}
        </>
      )}
      {!status?.enabled && <div className="hint">{status?.note || i18n.t('kbfbd7fe1')}</div>}
    </Card>
  );
}
