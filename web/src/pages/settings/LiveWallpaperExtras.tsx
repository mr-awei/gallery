import { useRef } from 'react';
import { api, desktop, isDesktop } from '../../api';
import type {
  LiveWallpaperConfig,
  LiveWallpaperParams,
  ScreensaverConfig,
  Settings as SettingsType,
} from '../../types';
import Card from './Card';
import Select from '../../components/Select';
import { useDebouncedCommit } from '../../hooks/useDebouncedCommit';
import i18n from '../../i18n';

interface Props {
  live: LiveWallpaperConfig | null;
  settings: SettingsType;
  /** 拖滑块即时预览：直接推给桌面层窗口，不等设置落库 */
  onInstant: (p: Partial<LiveWallpaperParams>) => void;
  /** 松手后保存（外层已有 300ms 防抖） */
  onPatch: (p: Partial<LiveWallpaperConfig>) => void;
  patchSettings: (p: Partial<SettingsType>) => void;
  onToast: (m: string, kind?: 'info' | 'error') => void;
}

const DEFAULT_PARAMS: LiveWallpaperParams = { brightness: 100, speed: 50, intensity: 60, depth: 40 };
const SLIDERS: { key: keyof LiveWallpaperParams; label: string; hint: string; max: number }[] = [
  { key: 'brightness', label: i18n.t('kcfd060d8'), hint: i18n.t('kdc856a93'), max: 200 },
  { key: 'speed', label: i18n.t('k03f38597'), hint: i18n.t('k3f41d640'), max: 300 },
  { key: 'intensity', label: i18n.t('kffd5f33d'), hint: i18n.t('kc97575a7'), max: 300 },
  { key: 'depth', label: i18n.t('k725cff41'), hint: i18n.t('k7c9541ea'), max: 200 },
];
const DEFAULT_SAVER: ScreensaverConfig = {
  enabled: false,
  idleMinutes: 10,
  mode: 'slideshow',
  showClock: true,
};

/** 动态壁纸的三类新渲染器 + 实时参数滑块 + 屏幕保护程序 */
export default function LiveWallpaperExtras({
  live,
  settings,
  onInstant,
  onPatch,
  patchSettings,
  onToast,
}: Props) {
  const lastPush = useRef(0);
  const params = { ...DEFAULT_PARAMS, ...(live?.params || {}) };
  const saver = { ...DEFAULT_SAVER, ...(settings.screensaver || {}) };

  const instant = (key: keyof LiveWallpaperParams, value: number) => {
    const now = performance.now();
    // rAF 级别的轻量节流：拖动时不要让每个 input 事件都打一次 IPC
    if (now - lastPush.current < 16) return;
    lastPush.current = now;
    onInstant({ [key]: value } as Partial<LiveWallpaperParams>);
  };
  const commit = (key: keyof LiveWallpaperParams, value: number) => {
    onPatch({ params: { ...params, [key]: value } });
  };

  const saveSaver = async (p: Partial<ScreensaverConfig>) => {
    const next: ScreensaverConfig = { ...saver, ...p };
    try {
      await api.saveSettings({ screensaver: next });
      patchSettings({ screensaver: next });
      onToast(i18n.t('k8da59766'));
    } catch (err) {
      onToast(i18n.t('kcc9c080e', { p0: (err as Error).message }), 'error');
    }
  };
  const saverDebounced = useDebouncedCommit<ScreensaverConfig>(saveSaver, 300);
  const pushSaver = (p: Partial<ScreensaverConfig>) => saverDebounced.push({ ...saver, ...p });

  return (
    <>
      <Card
        title={i18n.t('k238c1ebb')}
        desc={i18n.t('ke4f957f5')}
        badge={<span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>{i18n.t('kd505f8e7')}</span>}
      >
        {SLIDERS.map((s) => (
          <div className="field" key={s.key}>
            <label>
              {s.label} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· {s.hint} · 当前 {params[s.key]}</span>
            </label>
            <input
              type="range"
              min={0}
              max={s.max}
              step={5}
              value={params[s.key]}
              style={{ width: '100%', accentColor: 'var(--accent)' }}
              onInput={(e) => instant(s.key, Number(e.currentTarget.value))}
              onChange={(e) => commit(s.key, Number(e.currentTarget.value))}
            />
          </div>
        ))}
        <div className="hint">
          {i18n.t('k44c0b1a7')} <code>window.__live.setParams()</code>{i18n.t('kf6d6a95c')}
        </div>
      </Card>

      {(live?.mode === 'shader' || live?.mode === 'interactive' || live?.mode === 'audio') && (
        <Card
          title={i18n.t('k7d375855')}
          desc={
            live.mode === 'shader'
              ? i18n.t('kf428f3ba')
              : live.mode === 'interactive'
                ? i18n.t('kec9fd13e')
                : i18n.t('k5aecd19e')
          }
        >
          {live.mode === 'shader' && (
            <>
              <div className="field">
                <label>{i18n.t('k9c45bf00')}</label>
                <Select
                  className="select"
                  style={{ width: '100%' }}
                  value={live.shaderPreset || 'plasma'}
                  onChange={(v) => onPatch({ shaderPreset: v })}
                >
                  <option value="plasma">{i18n.t('k235f37c7')}</option>
                  <option value="waves">{i18n.t('k106e2e53')}</option>
                  <option value="aurora">{i18n.t('k9e4f9978')}</option>
                  <option value="stars">{i18n.t('k77f34a9f')}</option>
                </Select>
              </div>
              <div className="field">
                <label>{i18n.t('k416e6e56')}</label>
                <textarea
                  className="input"
                  rows={5}
                  spellCheck={false}
                  value={live.shaderSource || ''}
                  placeholder={'precision mediump float;\nuniform vec2 u_resolution; uniform vec2 u_mouse;\nuniform float u_time, u_brightness, u_speed, u_intensity, u_depth;\nvoid main(){ gl_FragColor = vec4(u_resolution.x > 0.0 ? 1.0 : 0.0, 0.0, 0.0, 1.0); }'}
                  onChange={(e) => onPatch({ shaderSource: e.target.value.slice(0, 12000) })}
                />
                <div className="hint">
                  可用 uniform：u_time / u_resolution / u_brightness / u_speed / u_intensity / u_depth / u_mouse。
                  GLSL 无法访问文件与网络；只在本机桌面层窗口编译。
                </div>
              </div>
            </>
          )}

          {live.mode === 'interactive' && (
            <>
              <div className="switch-row">
                <span>{i18n.t('kef3c8111')}</span>
                <input
                  type="checkbox"
                  checked={!!live.interactive}
                  onChange={(e) => onPatch({ interactive: e.target.checked })}
                />
              </div>
              <div className="hint">
                开启后桌面图标层仍可点击（窗口不再忽略鼠标事件）；按 Esc 立即恢复穿透。
                关闭时仍会渲染粒子动画，只是不接受指针输入。
                {!isDesktop && i18n.t('kcc7398ca')}
              </div>
            </>
          )}

          {live.mode === 'audio' && (
            <>
              <div className="field">
                <label>{i18n.t('kca7713b6')}</label>
                <Select
                  className="select"
                  style={{ width: '100%' }}
                  value={live.audioSource || 'file'}
                  onChange={(v) => onPatch({ audioSource: v as 'file' | 'mic' | 'system' })}
                >
                  <option value="file">{i18n.t('k945b9dc4')}</option>
                  <option value="mic">{i18n.t('kfc4335d4')}</option>
                  <option value="system">{i18n.t('k03fa5a0c')}</option>
                </Select>
              </div>
              {(live.audioSource || 'file') === 'file' && (
                <div className="field">
                  <label>{i18n.t('k01a98f2a')}</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      value={live.audioPath || ''}
                      placeholder="C:\\Users\\...\\music.mp3"
                      onChange={(e) => onPatch({ audioPath: e.target.value })}
                    />
                    <button
                      className="btn"
                      onClick={async () => {
                        try {
                          const p = await desktop?.pickFile?.([
                            { name: i18n.t('k726dd5df'), extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'webm'] },
                          ]);
                          if (p) onPatch({ audioPath: p });
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
              <div className="hint">
                静音用 WebAudio 的 gain 节点实现（不能设 audio.muted，否则 AnalyserNode 拿不到数据）。
                选「系统音频」会捕获 Windows 桌面声音（不含麦克风）；首次开启请重存一次配置以申请桌面音频权限。
                仅 Windows 可用，macOS / Linux 无桌面层挂载能力，该项不生效。
              </div>
            </>
          )}
        </Card>
      )}

      <Card
        title={i18n.t('k7f71e06c')}
        desc={i18n.t('k7643512a')}
        badge={
          <span style={{ color: saver.enabled ? 'var(--ok)' : 'var(--warn)', fontSize: 12, fontWeight: 400 }}>
            {saver.enabled ? i18n.t('k66e11add') : i18n.t('kd3d5685c')}
          </span>
        }
      >
        <div className="switch-row">
          <span>{i18n.t('k1b0fd2de')}</span>
          <input type="checkbox" checked={saver.enabled} onChange={(e) => pushSaver({ enabled: e.target.checked })} />
        </div>
        <div className="two-col">
          <div className="field">
            <label>{i18n.t('k18177046')}</label>
            <input
              className="input"
              type="number"
              min={1}
              max={180}
              value={saver.idleMinutes}
              onChange={(e) => pushSaver({ idleMinutes: Math.max(1, Math.min(180, Number(e.target.value) || 10)) })}
            />
          </div>
          <div className="field">
            <label>{i18n.t('k4649027f')}</label>
            <Select
              className="select"
              style={{ width: '100%' }}
              value={saver.mode}
              onChange={(v) => pushSaver({ mode: v as ScreensaverConfig['mode'] })}
            >
              <option value="slideshow">{i18n.t('kb1a21182')}</option>
              <option value="shader">{i18n.t('k8a19621d')}</option>
              <option value="interactive">{i18n.t('k2a7238e4')}</option>
              <option value="audio">{i18n.t('kf093fb24')}</option>
            </Select>
          </div>
        </div>
        <div className="switch-row">
          <span>{i18n.t('kd475b7e4')}</span>
          <input type="checkbox" checked={saver.showClock} onChange={(e) => pushSaver({ showClock: e.target.checked })} />
        </div>
        <div className="hint">
          屏保与动态壁纸共用同一套渲染页和参数滑块；有全屏应用/游戏时不触发，避免打断看视频或打游戏。
          {!isDesktop && ' 仅桌面端可用。'}
        </div>
      </Card>
    </>
  );
}
