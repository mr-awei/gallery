import React, { useEffect, useRef, useState } from 'react';
import { api, desktop, formatDate, getAppInfo, isDesktop, prettyHotkey, quiet } from '../../api';
import type { AppInfo } from '../../api';
import type {
  AutoWallpaperConfig as AutoConfig,
  AutoWallpaperStatus,
  LiveWallpaperConfig,
  LiveWallpaperParams,
  Playlist,
  Settings as SettingsType,
  WallpaperLogItem,
  WallpaperMonitors,
} from '../../types';
import Card from './Card';
import Select from '../../components/Select';
import LiveWallpaperExtras from './LiveWallpaperExtras';
import { useDebouncedCommit } from '../../hooks/useDebouncedCommit';
import i18n from '../../i18n';

interface Props {
  settings: SettingsType;
  patch: (p: Partial<SettingsType>) => void;
  onToast: (m: string, kind?: 'info' | 'error') => void;
}

const REASON_LABELS: Record<string, string> = {
  blur: i18n.t('kc3f69d7a'),
  lowres: i18n.t('kf20fd188'),
  noise: i18n.t('k1ea59300'),
  lighting: i18n.t('k75f61576'),
  expression: i18n.t('kf36a543a'),
  pose: i18n.t('ke5ffa98d'),
  composition: i18n.t('k1c6b93b2'),
  background: i18n.t('k2f6bf4f0'),
  cropped: i18n.t('kb2263008'),
  overedited: i18n.t('k78773bcc'),
  watermark: i18n.t('kd60f1419'),
  notHer: i18n.t('k802a84fb'),
  color: i18n.t('k309dd351'),
  other: i18n.t('k0d98c747'),
};
const reasonLabel = (k: string) => REASON_LABELS[k] || k;

export default function WallpaperSection({ settings, patch, onToast }: Props) {
  const [autoStatus, setAutoStatus] = useState<AutoWallpaperStatus | null>(null);
  const [wallpaperHistory, setWallpaperHistory] = useState<WallpaperLogItem[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [monitors, setMonitors] = useState<WallpaperMonitors | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [live, setLive] = useState<LiveWallpaperConfig | null>(null);
  const [platformCaps, setPlatformCaps] = useState<{ summary: string; liveWallpaper: boolean; gpuMeter: boolean } | null>(null);

  // 能力探测失败以前是裸 catch：整块「本机能力」说明会无声消失，用户只会觉得缺了点什么
  const [capsError, setCapsError] = useState('');
  useEffect(() => {
    api.platform()
      .then((r) => setPlatformCaps({ summary: r.summary, liveWallpaper: r.liveWallpaper, gpuMeter: r.gpuMeter }))
      .catch((err) => setCapsError(i18n.t('k68c66461', { p0: (err as Error).message })));
  }, []);

  // 初始加载（原样迁自父组件）
  useEffect(() => {
    api.playlists().then(setPlaylists).catch(quiet);
    loadAuto();
  }, []);

  // 主进程重注册快捷键后会广播实际生效的键位：直接更新提示，
  // 不用等用户重开设置页（以前改了开关，页面上的键位说明还是旧的）
  useEffect(() => {
    const off = desktop?.onHotkeysChanged?.((p) => {
      setAppInfo((prev) => (prev ? { ...prev, hotkeys: p.hotkeys, failedHotkeys: p.failed } : prev));
    });
    return () => off?.();
  }, []);

  const loadAuto = () => {
    api.autoWallpaper().then(setAutoStatus).catch(quiet);
    api.wallpaperHistory().then(setWallpaperHistory).catch(quiet);
    api.wallpaperMonitors().then(setMonitors).catch(quiet);
    api.liveWallpaper().then(setLive).catch(quiet);
    getAppInfo().then(setAppInfo).catch(quiet);
  };

  /** 保存并应用动态壁纸配置（桌面端会据此创建/销毁桌面层窗口） */
  const applyLive = async (patch: Partial<LiveWallpaperConfig>) => {
    try {
      const saved = await api.saveLiveWallpaper(patch);
      setLive(saved);
      if (isDesktop && desktop?.controlLiveWallpaper) {
        await desktop.controlLiveWallpaper(patch);
        onToast(i18n.t('k7c4e2ccb'));
      } else {
        onToast(i18n.t('ke96dd179'));
      }
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };

  const saveAuto = async (patch: Partial<AutoConfig>) => {
    // 以前没有 catch：接口失败时开关看着没动、也没有任何提示，用户只会觉得「点了没生效」
    try {
      const status = await api.saveAutoWallpaper(patch);
      setAutoStatus(status);
      onToast(i18n.t('kf8dfedcd'));
    } catch (err) {
      onToast(i18n.t('k837dd027', { p0: (err as Error).message }), 'error');
    }
  };

  // 文本/数字/开关的 onChange 以前每次都直接打接口（打字时一个字一个请求）。
  // 合并成 300ms 一次提交；串行化保证旧响应不会覆盖新输入。
  const saveAutoDebounced = useDebouncedCommit<AutoConfig>(saveAuto, 300);
  const applyLiveDebounced = useDebouncedCommit<LiveWallpaperConfig>(applyLive, 300);

  /**
   * 拖参数滑块：只推桌面层窗口，不落库、不重载窗口（松手由 onPatch 防抖保存）。
   * 推送失败以前是裸 catch —— 表现是「拖了没反应」，最难排查。这里只提示一次，
   * 拖拽时每帧弹 toast 反而更烦。
   */
  const previewBroken = useRef(false);
  const previewParams = (p: Partial<LiveWallpaperParams>) => {
    if (!isDesktop || !desktop?.setLiveParams) return;
    void desktop.setLiveParams(p).catch((err) => {
      if (previewBroken.current) return;
      previewBroken.current = true;
      onToast(i18n.t('kec1eed74', { p0: (err as Error).message }), 'error');
    });
  };

  const switchNow = async () => {
    try {
      const res = await api.switchWallpaperNow();
      onToast(i18n.t('k6b6ebd70', { p0: res.title || i18n.t('k20def794') }));
      loadAuto();
      setWallpaperHistory(await api.wallpaperHistory());
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };

  return (
            <>
              <Card title={i18n.t('kb91e3e16')} desc={i18n.t('k9a18f4d4')}>
                <div className="field">
                  <label>{i18n.t('kd9d2c511')}</label>
                  <Select
                    className="select"
                    style={{ width: '100%' }}
                    value={settings.wallpaperFill || 'blur'}
                    onChange={(v) => patch({ wallpaperFill: v as SettingsType['wallpaperFill'] })}
                  >
                    <option value="blur">{i18n.t('kc3f00955')}</option>
                    <option value="solid">{i18n.t('k54f136fc')}</option>
                    <option value="black">{i18n.t('kc011bc57')}</option>
                  </Select>
                  <div className="hint">
                    {i18n.t('kb3101306')}<b>{i18n.t('k9679759c')}</b>{i18n.t('kdb46111f')}<b>{i18n.t('k1befd0c2')}</b>，
                    四周用上面的方式填充 —— 不裁切、不变形、不缩放只显示一部分，始终完整展示
                  </div>
                  </div>
                  </Card>

                  <Card
                  title={i18n.t('k37b1c85f')}
                  desc={i18n.t('k702690e4')}
                  badge={
                    <span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>
                      检测到 {monitors?.count ?? '…'} 个屏幕
                    </span>
                  }
                  >
                  <div className="field">
                    <label>{i18n.t('k9d8afed3')}</label>
                    <Select
                      className="select"
                      style={{ width: '100%' }}
                      value={settings.wallpaperMode || 'single'}
                      onChange={(v) => patch({ wallpaperMode: v as SettingsType['wallpaperMode'] })}
                    >
                      <option value="single">{i18n.t('kaa95627c')}</option>
                      <option value="span">{i18n.t('k87c562f1')}</option>
                      <option value="per-monitor">{i18n.t('k28fcdb74')}</option>
                    </Select>
                  </div>

                  {!!monitors?.monitors?.length && (
                    <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.9 }}>
                      {monitors.monitors.map((m, i) => (
                        <div key={m.id}>
                          屏幕 {i + 1}：{m.width}×{m.height}
                          {m.x || m.y ? i18n.t('k94103a34', { p0: m.x, p1: m.y }) : ''}
                        </div>
                      ))}
                    </div>
                  )}
                  {(settings.wallpaperMode || 'single') !== 'single' && (monitors?.count ?? 0) <= 1 && (
                    <div className="hint" style={{ color: 'var(--warn)' }}>
                      {i18n.t('k64ca0050')}
                    </div>
                  )}

                  <div className="switch-row" style={{ marginTop: 10 }}>
                    <span>{i18n.t('k2c42fd60')}</span>
                    <input
                      type="checkbox"
                      checked={autoStatus?.config?.perMonitorDifferent !== false}
                      onChange={(e) => saveAutoDebounced.push({ perMonitorDifferent: e.target.checked })}
                    />
                  </div>
                  </Card>

                  <Card title={i18n.t('ke5ac2e78')} desc={i18n.t('kbfb80408')}>
                  <div className="switch-row">
                    <span>{i18n.t('k776f0309')}</span>
                    <input
                      type="checkbox"
                      checked={settings.globalShortcuts !== false}
                      onChange={(e) => patch({ globalShortcuts: e.target.checked })}
                    />
                  </div>
                  <div className="switch-row">
                    <span>{i18n.t('kde81ca26')}</span>
                    <input
                      type="checkbox"
                      checked={settings.closeToTray !== false}
                      onChange={(e) => patch({ closeToTray: e.target.checked })}
                    />
                  </div>
                  <div className="hint" style={{ lineHeight: 1.9 }}>
                    {i18n.t('k39664897')}<b>{prettyHotkey(appInfo?.hotkeys?.next) || i18n.t('k996aab1c')}</b>
                    {appInfo?.hotkeys?.next && appInfo.hotkeys.next !== 'CommandOrControl+Alt+W' && (
                      <span style={{ color: 'var(--warn)' }}>{i18n.t('k768bd285')}</span>
                    )}
                    {appInfo?.failedHotkeys?.next && (
                      <span style={{ color: 'var(--warn)' }}>
                        （注册失败：{appInfo.failedHotkeys.next} 都被其它程序占用）
                      </span>
                    )}
                    ，任何窗口下都生效
                    <br />{i18n.t('k57b1a643')}<b>{prettyHotkey(appInfo?.hotkeys?.favorite) || i18n.t('k996aab1c')}</b>
                    {appInfo?.failedHotkeys?.favorite && (
                      <span style={{ color: 'var(--warn)' }}>
                        （注册失败：{appInfo.failedHotkeys.favorite} 都被其它程序占用）
                      </span>
                    )}
                    <br />{i18n.t('k4c8e9692')}<b>{prettyHotkey(appInfo?.hotkeys?.window) || i18n.t('k996aab1c')}</b>
                    {appInfo?.failedHotkeys?.window && (
                      <span style={{ color: 'var(--warn)' }}>
                        （注册失败：{appInfo.failedHotkeys.window} 都被其它程序占用）
                      </span>
                    )}
                    <br />{i18n.t('k6e8b2ef8')}
                    <br />· 「不喜欢」会自动归因（暗了 / 糊了 / 有噪点 / 闭眼了 / 动作变形…），只针对该原因学习，不会连坐整个来源或关键词
                    {isDesktop && !appInfo?.shortcutEnabled && (
                      <>
                        <br />
                        <span style={{ color: 'var(--warn)' }}>{i18n.t('kfefd9f49')}</span>
                      </>
                    )}
                    {!isDesktop && (
                      <>
                        <br />
                        <span style={{ color: 'var(--muted)' }}>{i18n.t('k8f8f44db')}</span>
                      </>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <button
                      className="btn primary"
                      onClick={async () => {
                        try {
                          const r = await api.favoriteCurrentWallpaper();
                          onToast(i18n.t('k99f596b4', { p0: r.title || r.imageId }));
                        } catch (err) {
                          onToast((err as Error).message, 'error');
                        }
                      }}
                    >
                      {i18n.t('k4a24ed78')}
                    </button>
                    <button
                      className="btn"
                      onClick={async () => {
                        try {
                          const r = await api.dislikeCurrentWallpaper();
                          const why = (r.learned || []).length ? i18n.t('kaf56f3e9', { p0: (r.learned || []).map(reasonLabel).join('、') }) : '';
                          onToast(i18n.t('k2729b803', { p0: why }));
                          loadAuto();
                        } catch (err) {
                          onToast((err as Error).message, 'error');
                        }
                      }}
                    >
                      {i18n.t('k1d7b54ab')}
                    </button>
                  </div>
                  </Card>

                  <Card
                    title={i18n.t('k3bfbb815')}
                    desc={i18n.t('k2ca3db04')}
                    badge={
                      !isDesktop ? (
                        <span style={{ color: 'var(--warn)', fontSize: 12, fontWeight: 400 }}>{i18n.t('k3b5bd0ff')}</span>
                      ) : (
                        <span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>
                          {live?.enabled ? i18n.t('k9db7a84f') : i18n.t('kea4a363d')}
                        </span>
                      )
                    }
                  >
                    {platformCaps && (
                      <div className="hint" style={{ marginBottom: 10, lineHeight: 1.8 }}>
                        {platformCaps.summary}
                        {!platformCaps.liveWallpaper && i18n.t('k97370f6a')}
                        {!platformCaps.gpuMeter && i18n.t('k2ce779b3')}
                      </div>
                    )}
                    {capsError && (
                      <div className="hint" style={{ color: 'var(--warn)', marginBottom: 10 }}>
                        {capsError}
                      </div>
                    )}
                    {!isDesktop && (
                      <div className="hint" style={{ color: 'var(--warn)', marginBottom: 10 }}>
                        {i18n.t('kc6ca877f')}
                      </div>
                    )}
                    <div className="switch-row">
                      <span>{i18n.t('ka0782e66')}</span>
                      <input
                        type="checkbox"
                        checked={!!live?.enabled}
                        onChange={(e) => applyLiveDebounced.push({ enabled: e.target.checked })}
                      />
                    </div>

                    <div className="field">
                      <label>{i18n.t('k99df458b')}</label>
                      <Select
                        className="select"
                        style={{ width: '100%' }}
                        value={live?.mode || 'slideshow'}
                        onChange={(v) => applyLiveDebounced.push({ mode: v as LiveWallpaperConfig['mode'] })}
                      >
                        <option value="slideshow">{i18n.t('k57898e64')}</option>
                        <option value="video">{i18n.t('k9ec3623e')}</option>
                        <option value="web">{i18n.t('k8c07ad40')}</option>
                        <option value="shader">{i18n.t('ke474751a')}</option>
                        <option value="interactive">{i18n.t('k11b825c0')}</option>
                        <option value="audio">{i18n.t('kc196fa0c')}</option>
                      </Select>
                    </div>

                    {live?.mode === 'slideshow' && (
                      <>
                        <div className="field">
                          <label>{i18n.t('k3e10f06b')}</label>
                          <Select
                            className="select"
                            style={{ width: '100%' }}
                            value={live?.scope || 'favorites'}
                            onChange={(v) => applyLiveDebounced.push({ scope: v as LiveWallpaperConfig['scope'] })}
                          >
                            <option value="favorites">{i18n.t('k9dd8a82d')}</option>
                            <option value="all">{i18n.t('kd5190d5f')}</option>
                            {!!playlists?.length && <option value="playlist">{i18n.t('k091fcd6e')}</option>}
                          </Select>
                        </div>
                        {live?.scope === 'playlist' && (
                          <div className="field">
                            <label>{i18n.t('kaa7bfddf')}</label>
                            <Select
                              className="select"
                              style={{ width: '100%' }}
                              value={live?.playlistId ?? ''}
                              onChange={(v) => applyLiveDebounced.push({ playlistId: v ? Number(v) : null })}
                            >
                              <option value="">{i18n.t('k77a5a046')}</option>
                              {playlists?.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </Select>
                          </div>
                        )}
                        <div className="two-col">
                          <div className="field">
                            <label>{i18n.t('kf3549654')}</label>
                            <input
                              className="input"
                              type="number"
                              min={5}
                              max={600}
                              value={live?.intervalSec ?? 15}
                              onChange={(e) =>
                                applyLiveDebounced.push({ intervalSec: Math.max(5, Math.min(600, Number(e.target.value) || 15)) })
                              }
                            />
                          </div>
                          <div className="field">
                            <label>{i18n.t('k505f52e4')}</label>
                            <input
                              className="input"
                              type="number"
                              min={0}
                              max={100}
                              value={live?.minScore ?? 0}
                              onChange={(e) =>
                                applyLiveDebounced.push({ minScore: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })
                              }
                            />
                          </div>
                        </div>
                        <div className="switch-row">
                          <span>{i18n.t('k81c00d27')}</span>
                          <input
                            type="checkbox"
                            checked={live?.kenBurns !== false}
                            onChange={(e) => applyLiveDebounced.push({ kenBurns: e.target.checked })}
                          />
                        </div>
                      </>
                    )}

                    {live?.mode === 'video' && (
                      <div className="field">
                        <label>{i18n.t('kd961f1e5')}</label>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input
                            className="input"
                            style={{ flex: 1 }}
                            value={live?.videoPath || ''}
                            placeholder="C:\\Users\\...\\tuku.mp4"
                            onChange={(e) => applyLiveDebounced.push({ videoPath: e.target.value })}
                          />
                          <button
                            className="btn"
                            onClick={async () => {
                              try {
                                const p = await desktop?.pickFile?.([
                                  { name: i18n.t('k7fcf42ed'), extensions: ['mp4', 'webm', 'mov'] },
                                ]);
                                if (p) applyLiveDebounced.push({ videoPath: p });
                              } catch (err) {
                                onToast((err as Error).message, 'error');
                              }
                            }}
                          >
                            {i18n.t('kfd7e0c99')}
                          </button>
                        </div>
                      </div>
                    )}

                    {live?.mode === 'web' && (
                      <div className="field">
                        <label>{i18n.t('k66b98588')}</label>
                        <input
                          className="input"
                          value={live?.webUrl || ''}
                          placeholder="https://..."
                          onChange={(e) => applyLiveDebounced.push({ webUrl: e.target.value })}
                        />
                        <div className="hint">{i18n.t('kb61e50b9')}</div>
                      </div>
                    )}
                    {live?.mode === 'web' && (
                      <div className="field">
                        <label>{i18n.t('k2ed7e7ed')}</label>
                        <div className="switch-row">
                          <span>{i18n.t('k44e984d4')}</span>
                          <input
                            type="checkbox"
                            checked={!!live?.allowLocalUrl}
                            onChange={(e) => applyLiveDebounced.push({ allowLocalUrl: e.target.checked })}
                          />
                        </div>
                        {live?.allowLocalUrl && (
                          <input
                            className="input"
                            style={{ marginTop: 6 }}
                            value={live?.trustedDir || ''}
                            placeholder={i18n.t('kbae514dc')}
                            onChange={(e) => applyLiveDebounced.push({ trustedDir: e.target.value })}
                          />
                        )}
                        <div className="switch-row">
                          <span>{i18n.t('kffa05df8')}</span>
                          <input
                            type="checkbox"
                            checked={live?.clickThrough === false}
                            onChange={(e) => applyLiveDebounced.push({ clickThrough: !e.target.checked })}
                          />
                        </div>
                        <div className="hint">
                          {i18n.t('k66aa5f51')} <code>file://</code> 页面，
                          窗口不挂预加载桥；关闭穿透后网页会遮住桌面图标，按 Esc 立即恢复穿透。
                        </div>
                      </div>
                    )}

                    <div className="field" style={{ marginTop: 6 }}>
                      <label>{i18n.t('ke3e4e5bb')}</label>
                      <div className="switch-row">
                        <span>{i18n.t('kf3f4bd09')}</span>
                        <input
                          type="checkbox"
                          checked={live?.pauseOnFullscreen !== false}
                          onChange={(e) => applyLiveDebounced.push({ pauseOnFullscreen: e.target.checked })}
                        />
                      </div>
                      <div className="switch-row">
                        <span>{i18n.t('kb7ecffa8')}</span>
                        <input
                          type="checkbox"
                          checked={!!live?.pauseOnBattery}
                          onChange={(e) => applyLiveDebounced.push({ pauseOnBattery: e.target.checked })}
                        />
                      </div>
                      <div className="switch-row">
                        <span>{i18n.t('k187801c9')}</span>
                        <input
                          type="checkbox"
                          checked={!!live?.pauseOnGpu}
                          onChange={(e) => applyLiveDebounced.push({ pauseOnGpu: e.target.checked })}
                        />
                      </div>
                      {live?.pauseOnGpu && (
                        <div className="switch-row">
                          <span>{i18n.t('kbaa0770e')}</span>
                          <input
                            className="input"
                            style={{ width: 90 }}
                            type="number"
                            min={1}
                            max={100}
                            value={live?.gpuThreshold ?? 85}
                            onChange={(e) =>
                              applyLiveDebounced.push({
                                gpuThreshold: Math.max(1, Math.min(100, Number(e.target.value) || 85)),
                              })
                            }
                          />
                        </div>
                      )}
                      <div className="field" style={{ marginTop: 8 }}>
                        <label>{i18n.t('k42a61af5')}</label>
                        <input
                          className="input"
                          value={live?.pauseApps?.join(', ') || ''}
                          placeholder="photoshop.exe, premiere*, msedge.exe"
                          onChange={(e) =>
                            applyLiveDebounced.push({
                              pauseApps: e.target.value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean),
                            })
                          }
                        />
                        <div className="hint">{i18n.t('k583b0808')} <code>*</code> {i18n.t('k4840822a')}</div>
                      </div>
                    </div>
                  </Card>

                  <LiveWallpaperExtras
                    live={live}
                    settings={settings}
                    onInstant={previewParams}
                    onPatch={(p) => applyLiveDebounced.push(p)}
                    patchSettings={patch}
                    onToast={onToast}
                  />

              <Card
                title={i18n.t('k81268ba3')}
                desc={i18n.t('k1eaed5bc')}
                badge={
                  autoStatus?.config?.enabled ? (
                    <span style={{ color: 'var(--ok)', fontWeight: 400, fontSize: 12 }}>{i18n.t('k66e11add')}</span>
                  ) : (
                    <span style={{ color: 'var(--warn)', fontWeight: 400, fontSize: 12 }}>{i18n.t('kd3d5685c')}</span>
                  )
                }
              >
                <div className="switch-row">
                  <span>{i18n.t('k96f07f78')}</span>
                  <input
                    type="checkbox"
                    checked={!!autoStatus?.config?.enabled}
                    onChange={(e) => saveAutoDebounced.push({ enabled: e.target.checked })}
                  />
                </div>

                <div className="field">
                  <label>{i18n.t('k0de86db4')}</label>
                  <Select
                    className="select"
                    style={{ width: '100%' }}
                    value={autoStatus?.config?.mode || 'day'}
                    onChange={(v) => saveAutoDebounced.push({ mode: v as AutoConfig['mode'] })}
                  >
                    <option value="day">{i18n.t('k78623eae')}</option>
                    <option value="week">{i18n.t('k09b03b6d')}</option>
                    <option value="month">{i18n.t('kaa3d57c0')}</option>
                    <option value="custom">{i18n.t('k158e7e77')}</option>
                  </Select>
                </div>

                {autoStatus?.config?.mode === 'custom' ? (
                  <div className="field">
                    <label>{i18n.t('kc05d4718')}</label>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      value={autoStatus?.config?.minutes ?? 60}
                      onChange={(e) => saveAutoDebounced.push({ minutes: Math.max(1, Number(e.target.value) || 60) })}
                    />
                  </div>
                ) : (
                  <>
                    <div className="field">
                      <label>{i18n.t('kb10475fc')}</label>
                      <input
                        className="input"
                        type="time"
                        value={autoStatus?.config?.atTime || '09:00'}
                        onChange={(e) => saveAutoDebounced.push({ atTime: e.target.value })}
                      />
                    </div>
                    {autoStatus?.config?.mode === 'week' && (
                      <div className="field">
                        <label>{i18n.t('k1981794a')}</label>
                        <Select
                          className="select"
                          style={{ width: '100%' }}
                          value={autoStatus?.config?.weekday ?? 1}
                          onChange={(v) => saveAutoDebounced.push({ weekday: Number(v) })}
                        >
                          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                            <option key={d} value={d}>
                              星期{i18n.t('k2aa32e11')[d % 7]}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                    {autoStatus?.config?.mode === 'month' && (
                      <div className="field">
                        <label>{i18n.t('k31840956')}</label>
                        <input
                          className="input"
                          type="number"
                          min={1}
                          max={28}
                          value={autoStatus?.config?.dayOfMonth ?? 1}
                          onChange={(e) =>
                            saveAutoDebounced.push({ dayOfMonth: Math.max(1, Math.min(28, Number(e.target.value) || 1)) })
                          }
                        />
                      </div>
                    )}
                  </>
                )}

                <div className="field">
                  <label>{i18n.t('kb5c83efc')}</label>
                  <Select
                    className="select"
                    style={{ width: '100%' }}
                    value={autoStatus?.config?.scope || 'favorites'}
                    onChange={(v) => saveAutoDebounced.push({ scope: v as AutoConfig['scope'] })}
                  >
                    <option value="all">{i18n.t('kd5190d5f')}</option>
                    <option value="favorites">{i18n.t('kb40bf1e2')}</option>
                    <option value="playlist">{i18n.t('k091fcd6e')}</option>
                  </Select>
                </div>

                {autoStatus?.config?.scope === 'playlist' && (
                  <div className="field">
                    <label>{i18n.t('kaa7bfddf')}</label>
                    <Select
                      className="select"
                      style={{ width: '100%' }}
                      value={autoStatus?.config?.playlistId ?? ''}
                      onChange={(v) => saveAutoDebounced.push({ playlistId: Number(v) || null })}
                    >
                      <option value="">{i18n.t('ke8f38b02')}</option>
                      {(playlists || []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}（{p.count}）
                        </option>
                      ))}
                    </Select>
                  </div>
                )}

                <div className="field">
                  <label>{i18n.t('k18d22a93')}</label>
                  <Select
                    className="select"
                    style={{ width: '100%' }}
                    value={autoStatus?.config?.order || 'smart'}
                    onChange={(v) => saveAutoDebounced.push({ order: v as AutoConfig['order'] })}
                  >
                    <option value="ai">{i18n.t('kee7252d3')}</option>
                    <option value="smart">{i18n.t('kceed89f6')}</option>
                    <option value="random">{i18n.t('k4bed1616')}</option>
                    <option value="sequential">{i18n.t('k9c2a3d10')}</option>
                  </Select>
                  <div className="hint">
                    {i18n.t('ka4ec48bb')}
                    <br />
                    {i18n.t('k61110b0f')}<strong>{i18n.t('k7bcb9a80')}</strong>{i18n.t('k36912d86')}
                    <strong>{i18n.t('kc7995270')}</strong>；配了视觉模型才会额外让模型看一眼构图（没配就走本地算法）。
                    另按时间挑：白天偏明亮、夜间偏暗色
                    <br />
                    {i18n.t('k5aa49a64')}<b>{autoStatus?.pick?.label || '—'}</b>
                    {autoStatus?.pick && !autoStatus.pick.prefTrained && (
                      <span>{i18n.t('k785c6a20')}</span>
                    )}
                  </div>
                </div>

                <div className="field">
                  <label>{i18n.t('k4ce8824e')}</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={100}
                    value={autoStatus?.config?.minScore ?? 0}
                    onChange={(e) => saveAutoDebounced.push({ minScore: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                  />
                </div>

                {/* AI 壁纸闭环开关 */}
                <div className="settings-subtitle" style={{ marginTop: 14 }}>
                  {i18n.t('kb4d37169')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label className="switch-row">
                    <span>
                      {i18n.t('kdd5840d5')}
                      <span className="hint">　{i18n.t('k45774e38')}</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={autoStatus?.config?.useAiFit !== false}
                      onChange={(e) => saveAutoDebounced.push({ useAiFit: e.target.checked })}
                    />
                  </label>
                  <label className="switch-row">
                    <span>
                      {i18n.t('ke509c81b')}
                      <span className="hint">
                        　{i18n.t('kc71b7740')}
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={autoStatus?.config?.feedbackToKb !== false}
                      onChange={(e) => saveAutoDebounced.push({ feedbackToKb: e.target.checked })}
                    />
                  </label>
                  <label className="switch-row">
                    <span>
                      {i18n.t('k4c83b0ba')}
                    </span>
                    <input
                      type="checkbox"
                      checked={autoStatus?.config?.useTimeAware !== false}
                      onChange={(e) => saveAutoDebounced.push({ useTimeAware: e.target.checked })}
                    />
                  </label>
                  <label className="switch-row">
                    <span>
                      {i18n.t('kbfacad7f')}
                      <span className="hint">　{i18n.t('kf8238af7')}</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={autoStatus?.config?.autoEnhance === true}
                      onChange={(e) => saveAutoDebounced.push({ autoEnhance: e.target.checked })}
                    />
                  </label>
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                  <button className="btn primary" onClick={switchNow}>
                    {i18n.t('kb8d49329')}
                  </button>
                  <button className="btn" onClick={() => loadAuto()}>
                    {i18n.t('k4f8d48ef')}
                  </button>
                  <button
                    className="btn"
                    onClick={async () => {
                      try {
                        const r = await api.scanWallpaperFit(120, true);
                        onToast(i18n.t('k4622b88f', { p0: r.done, p1: r.remain }));
                      } catch (err) {
                        onToast((err as Error).message, 'error');
                      }
                    }}
                    title={i18n.t('k59049e27')}
                  >
                    {i18n.t('k2ac1d320')}
                  </button>
                </div>

                <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
                  · 范围内可用图片：{autoStatus?.scopeCount ?? 0} 张
                  <br />· 下次切换：
                  {autoStatus?.nextRunAt ? formatDate(autoStatus.nextRunAt) : i18n.t('kf3c18aa5')}
                  <br />· 上次切换：
                  {autoStatus?.lastLog ? `${autoStatus.lastLog.title || i18n.t('k20def794')}（${formatDate(autoStatus.lastLog.appliedAt)}）` : i18n.t('kf61f4cf6')}
                </div>

                {wallpaperHistory.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{i18n.t('kfdd47f39')}</div>
                    {wallpaperHistory.slice(0, 5).map((h) => (
                      <div key={h.id} style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.8 }}>
                        {formatDate(h.appliedAt)} · {h.title || i18n.t('kaea8b780', { p0: h.imageId })} ·{' '}
                        {h.scope === 'favorites' ? i18n.t('kae336cd0') : h.scope === 'playlist' ? i18n.t('k8d9a495b') : i18n.t('kd5190d5f')}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </>
  );
}
