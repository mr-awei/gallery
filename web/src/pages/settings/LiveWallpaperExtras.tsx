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
  { key: 'brightness', label: '亮度', hint: '整体明暗（100 = 原样）', max: 200 },
  { key: 'speed', label: '速度', hint: '动画 / 轮播 / 播放速率', max: 300 },
  { key: 'intensity', label: '强度', hint: '色彩与响应幅度', max: 300 },
  { key: 'depth', label: '景深', hint: '模糊与拖尾长度', max: 200 },
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
      onToast('屏保设置已保存');
    } catch (err) {
      onToast(`保存屏保设置失败：${(err as Error).message}`, 'error');
    }
  };
  const saverDebounced = useDebouncedCommit<ScreensaverConfig>(saveSaver, 300);
  const pushSaver = (p: Partial<ScreensaverConfig>) => saverDebounced.push({ ...saver, ...p });

  return (
    <>
      <Card
        title="壁纸实时交互参数"
        desc="拖动滑块即时生效，不重启桌面层窗口；松手后自动保存。"
        badge={<span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>亮度 / 速度 / 强度 / 景深</span>}
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
          桌面端通过 IPC 直推已挂载的渲染窗口，参数走 <code>window.__live.setParams()</code>；
          浏览器模式只保存配置，预览需重开设置页。
        </div>
      </Card>

      {(live?.mode === 'shader' || live?.mode === 'interactive' || live?.mode === 'audio') && (
        <Card
          title="动态壁纸内容"
          desc={
            live.mode === 'shader'
              ? 'WebGL 片元着色器：内置预设或自己写 GLSL，编译失败会在桌面上如实提示。'
              : live.mode === 'interactive'
                ? '交互式壁纸：桌面层接收鼠标，粒子会跟着指针走；Esc 退出交互。'
                : '音频可视化：用素材音频或麦克风驱动实时频谱。'
          }
        >
          {live.mode === 'shader' && (
            <>
              <div className="field">
                <label>内置预设</label>
                <Select
                  className="select"
                  style={{ width: '100%' }}
                  value={live.shaderPreset || 'plasma'}
                  onChange={(v) => onPatch({ shaderPreset: v })}
                >
                  <option value="plasma">等离子（彩色流动）</option>
                  <option value="waves">水波（层叠条纹）</option>
                  <option value="aurora">极光（柔和光幕）</option>
                  <option value="stars">星场（缓慢漂移）</option>
                </Select>
              </div>
              <div className="field">
                <label>自定义 GLSL 片元源码（留空则用上面的预设）</label>
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
                <span>允许鼠标与桌面交互</span>
                <input
                  type="checkbox"
                  checked={!!live.interactive}
                  onChange={(e) => onPatch({ interactive: e.target.checked })}
                />
              </div>
              <div className="hint">
                开启后桌面图标层仍可点击（窗口不再忽略鼠标事件）；按 Esc 立即恢复穿透。
                关闭时仍会渲染粒子动画，只是不接受指针输入。
                {!isDesktop && ' 网页模式没有桌面层，交互不可用。'}
              </div>
            </>
          )}

          {live.mode === 'audio' && (
            <>
              <div className="field">
                <label>音频来源</label>
                <Select
                  className="select"
                  style={{ width: '100%' }}
                  value={live.audioSource || 'file'}
                  onChange={(v) => onPatch({ audioSource: v as 'file' | 'mic' | 'system' })}
                >
                  <option value="file">本地音频文件</option>
                  <option value="mic">麦克风输入</option>
                  <option value="system">系统音频（Windows 桌面声音回环）</option>
                </Select>
              </div>
              {(live.audioSource || 'file') === 'file' && (
                <div className="field">
                  <label>音频文件</label>
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
                            { name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'webm'] },
                          ]);
                          if (p) onPatch({ audioPath: p });
                        } catch (err) {
                          onToast((err as Error).message, 'error');
                        }
                      }}
                    >
                      选择文件
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
        title="屏幕保护程序模式"
        desc="系统空闲到设定时长后，用动态壁纸全屏覆盖；一动键鼠就立即退出。"
        badge={
          <span style={{ color: saver.enabled ? 'var(--ok)' : 'var(--warn)', fontSize: 12, fontWeight: 400 }}>
            {saver.enabled ? '● 已启用' : '○ 未启用'}
          </span>
        }
      >
        <div className="switch-row">
          <span>启用屏保</span>
          <input type="checkbox" checked={saver.enabled} onChange={(e) => pushSaver({ enabled: e.target.checked })} />
        </div>
        <div className="two-col">
          <div className="field">
            <label>空闲多久触发（分钟）</label>
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
            <label>屏保画面</label>
            <Select
              className="select"
              style={{ width: '100%' }}
              value={saver.mode}
              onChange={(v) => pushSaver({ mode: v as ScreensaverConfig['mode'] })}
            >
              <option value="slideshow">相册轮播</option>
              <option value="shader">GLSL 着色器</option>
              <option value="interactive">交互粒子</option>
              <option value="audio">音频频谱</option>
            </Select>
          </div>
        </div>
        <div className="switch-row">
          <span>显示时钟</span>
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
