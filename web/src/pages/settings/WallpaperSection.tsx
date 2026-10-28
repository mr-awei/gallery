import React, { useEffect, useState } from 'react';
import { api, desktop, formatDate, getAppInfo, isDesktop, prettyHotkey, quiet } from '../../api';
import type { AppInfo } from '../../api';
import type {
  AutoWallpaperConfig as AutoConfig,
  AutoWallpaperStatus,
  LiveWallpaperConfig,
  Playlist,
  Settings as SettingsType,
  WallpaperLogItem,
  WallpaperMonitors,
} from '../../types';
import Card from './Card';
import AppUpdateCard from './AppUpdateCard';

interface Props {
  settings: SettingsType;
  patch: (p: Partial<SettingsType>) => void;
  onToast: (m: string) => void;
}

const REASON_LABELS: Record<string, string> = {
  blur: '模糊 / 低清',
  lowres: '分辨率太低',
  noise: '噪点多 / 压缩痕迹重',
  lighting: '光线差 / 过曝欠曝',
  expression: '表情不好 / 闭眼',
  pose: '动作 / 姿态扭曲',
  composition: '构图不好',
  background: '背景杂乱',
  cropped: '截取不全 / 变形',
  overedited: '修图过度 / 不自然',
  watermark: '有水印或平台 Logo',
  notHer: '不是本人',
  color: '色调不喜欢',
  other: '其他',
};
const reasonLabel = (k: string) => REASON_LABELS[k] || k;

export default function WallpaperSection({ settings, patch, onToast }: Props) {
  const [autoStatus, setAutoStatus] = useState<AutoWallpaperStatus | null>(null);
  const [wallpaperHistory, setWallpaperHistory] = useState<WallpaperLogItem[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [monitors, setMonitors] = useState<WallpaperMonitors | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [live, setLive] = useState<LiveWallpaperConfig | null>(null);

  // 初始加载（原样迁自父组件）
  useEffect(() => {
    api.playlists().then(setPlaylists).catch(quiet);
    loadAuto();
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
        onToast('动态壁纸已更新');
      } else {
        onToast('已保存（桌面端中打开才会真正显示）');
      }
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const saveAuto = async (patch: Partial<AutoConfig>) => {
    const status = await api.saveAutoWallpaper(patch);
    setAutoStatus(status);
    onToast('已保存');
  };

  const switchNow = async () => {
    try {
      const res = await api.switchWallpaperNow();
      onToast(`已切换到：${res.title || '图片'}（图片会完整居中展示，不裁切）`);
      loadAuto();
      setWallpaperHistory(await api.wallpaperHistory());
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  return (
            <>
              <Card title="设为壁纸" desc="图片比例与屏幕不同（如竖图做横屏壁纸）时，四周留白的处理方式。">
                <div className="field">
                  <label>留白填充方式</label>
                  <select
                    className="select"
                    style={{ width: '100%' }}
                    value={settings.wallpaperFill || 'blur'}
                    onChange={(e) => patch({ wallpaperFill: e.target.value as SettingsType['wallpaperFill'] })}
                  >
                    <option value="blur">模糊同图铺底（推荐，同 iOS / macOS 做法）</option>
                    <option value="solid">纯色铺底（取图片主色）</option>
                    <option value="black">纯黑铺底</option>
                  </select>
                  <div className="hint">
                    任意比例的图片都会先合成一张<b>屏幕分辨率的壁纸</b>：原图按原始比例<b>完整居中显示</b>，
                    四周用上面的方式填充 —— 不裁切、不变形、不缩放只显示一部分，始终完整展示
                  </div>
                  </div>
                  </Card>

                  <Card
                  title="多显示器"
                  desc="检测到的显示器，以及多屏时的摆放方式（需要系统支持 IDesktopWallpaper）。"
                  badge={
                    <span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>
                      检测到 {monitors?.count ?? '…'} 个屏幕
                    </span>
                  }
                  >
                  <div className="field">
                    <label>多屏模式</label>
                    <select
                      className="select"
                      style={{ width: '100%' }}
                      value={settings.wallpaperMode || 'single'}
                      onChange={(e) => patch({ wallpaperMode: e.target.value as SettingsType['wallpaperMode'] })}
                    >
                      <option value="single">主屏一张（默认）</option>
                      <option value="span">跨屏合成一张（多屏无缝衔接同一张图）</option>
                      <option value="per-monitor">每个屏幕不同图片（各自按屏幕比例合成）</option>
                    </select>
                  </div>

                  {!!monitors?.monitors?.length && (
                    <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.9 }}>
                      {monitors.monitors.map((m, i) => (
                        <div key={m.id}>
                          屏幕 {i + 1}：{m.width}×{m.height}
                          {m.x || m.y ? `（位置 ${m.x},${m.y}）` : ''}
                        </div>
                      ))}
                    </div>
                  )}
                  {(settings.wallpaperMode || 'single') !== 'single' && (monitors?.count ?? 0) <= 1 && (
                    <div className="hint" style={{ color: 'var(--warn)' }}>
                      当前只检测到 1 个显示器，多屏模式会自动回退为「主屏一张」
                    </div>
                  )}

                  <div className="switch-row" style={{ marginTop: 10 }}>
                    <span>多屏时每个屏幕放不同的图</span>
                    <input
                      type="checkbox"
                      checked={autoStatus?.config?.perMonitorDifferent !== false}
                      onChange={(e) => saveAuto({ perMonitorDifferent: e.target.checked })}
                    />
                  </div>
                  </Card>

                  <AppUpdateCard appInfo={appInfo} patch={patch} onToast={onToast} />
                  <Card title="托盘与快捷键" desc="不打开主窗口也能换壁纸。">
                  <div className="switch-row">
                    <span>启用全局快捷键</span>
                    <input
                      type="checkbox"
                      checked={settings.globalShortcuts !== false}
                      onChange={(e) => patch({ globalShortcuts: e.target.checked })}
                    />
                  </div>
                  <div className="hint" style={{ lineHeight: 1.9 }}>
                    · 换一张壁纸：<b>{prettyHotkey(appInfo?.hotkeys?.next) || '未生效'}</b>
                    {appInfo?.hotkeys?.next && appInfo.hotkeys.next !== 'CommandOrControl+Alt+W' && (
                      <span style={{ color: 'var(--warn)' }}>（默认键被其它软件占用，已自动换备用键）</span>
                    )}
                    ，任何窗口下都生效
                    <br />· 收藏当前壁纸：<b>{prettyHotkey(appInfo?.hotkeys?.favorite) || '未生效'}</b>
                    <br />· 唤出主窗口：<b>{prettyHotkey(appInfo?.hotkeys?.window) || '未生效'}</b>
                    <br />· 托盘图标：左键打开窗口，右键可换壁纸 / 收藏 / 不喜欢（排除该图并换下一张）/ 暂停定时切换
                    <br />· 「不喜欢」会自动归因（暗了 / 糊了 / 有噪点 / 闭眼了 / 动作变形…），只针对该原因学习，不会连坐整个来源或关键词
                    {isDesktop && !appInfo?.shortcutEnabled && (
                      <>
                        <br />
                        <span style={{ color: 'var(--warn)' }}>当前已在设置里关闭全局快捷键</span>
                      </>
                    )}
                    {!isDesktop && (
                      <>
                        <br />
                        <span style={{ color: 'var(--muted)' }}>网页模式下没有托盘与全局快捷键（仅桌面端可用）</span>
                      </>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <button
                      className="btn primary"
                      onClick={async () => {
                        try {
                          const r = await api.favoriteCurrentWallpaper();
                          onToast(`已收藏当前壁纸：${r.title || r.imageId}`);
                        } catch (err) {
                          onToast((err as Error).message);
                        }
                      }}
                    >
                      收藏当前壁纸
                    </button>
                    <button
                      className="btn"
                      onClick={async () => {
                        try {
                          const r = await api.dislikeCurrentWallpaper();
                          const why = (r.learned || []).length ? `（已记录原因：${(r.learned || []).map(reasonLabel).join('、')}）` : '';
                          onToast(`已排除并换了一张${why}`);
                          loadAuto();
                        } catch (err) {
                          onToast((err as Error).message);
                        }
                      }}
                    >
                      不喜欢，换一张
                    </button>
                  </div>
                  </Card>

                  <Card
                    title="动态壁纸"
                    desc="把一扇隐藏窗口挂到桌面图标层后面，做成真正的动态桌面（视频 / 网页 / 相册轮播）。"
                    badge={
                      !isDesktop ? (
                        <span style={{ color: 'var(--warn)', fontSize: 12, fontWeight: 400 }}>仅桌面端可用</span>
                      ) : (
                        <span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>
                          {live?.enabled ? '已开启' : '未开启'}
                        </span>
                      )
                    }
                  >
                    {!isDesktop && (
                      <div className="hint" style={{ color: 'var(--warn)', marginBottom: 10 }}>
                        网页模式下无法把窗口挂到桌面层，请在桌面应用（npm run desktop / npm run dev）中使用此功能。
                      </div>
                    )}
                    <div className="switch-row">
                      <span>开启动态壁纸</span>
                      <input
                        type="checkbox"
                        checked={!!live?.enabled}
                        onChange={(e) => applyLive({ enabled: e.target.checked })}
                      />
                    </div>

                    <div className="field">
                      <label>壁纸类型</label>
                      <select
                        className="select"
                        style={{ width: '100%' }}
                        value={live?.mode || 'slideshow'}
                        onChange={(e) => applyLive({ mode: e.target.value as LiveWallpaperConfig['mode'] })}
                      >
                        <option value="slideshow">相册轮播（从收藏/全库自动播放，带缓慢缩放）</option>
                        <option value="video">本地视频循环（mp4 / webm）</option>
                        <option value="web">网页（任意网址，如网页动画 / 在线壁纸）</option>
                      </select>
                    </div>

                    {live?.mode === 'slideshow' && (
                      <>
                        <div className="field">
                          <label>轮播范围</label>
                          <select
                            className="select"
                            style={{ width: '100%' }}
                            value={live?.scope || 'favorites'}
                            onChange={(e) => applyLive({ scope: e.target.value as LiveWallpaperConfig['scope'] })}
                          >
                            <option value="favorites">仅收藏</option>
                            <option value="all">全库</option>
                            {!!playlists?.length && <option value="playlist">指定清单</option>}
                          </select>
                        </div>
                        {live?.scope === 'playlist' && (
                          <div className="field">
                            <label>选择清单</label>
                            <select
                              className="select"
                              style={{ width: '100%' }}
                              value={live?.playlistId ?? ''}
                              onChange={(e) =>
                                applyLive({ playlistId: e.target.value ? Number(e.target.value) : null })
                              }
                            >
                              <option value="">— 请选择 —</option>
                              {playlists?.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        <div className="two-col">
                          <div className="field">
                            <label>切换间隔（秒）</label>
                            <input
                              className="input"
                              type="number"
                              min={5}
                              max={600}
                              value={live?.intervalSec ?? 15}
                              onChange={(e) =>
                                applyLive({ intervalSec: Math.max(5, Math.min(600, Number(e.target.value) || 15)) })
                              }
                            />
                          </div>
                          <div className="field">
                            <label>最低评分（0 = 不限）</label>
                            <input
                              className="input"
                              type="number"
                              min={0}
                              max={100}
                              value={live?.minScore ?? 0}
                              onChange={(e) =>
                                applyLive({ minScore: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })
                              }
                            />
                          </div>
                        </div>
                        <div className="switch-row">
                          <span>缓慢缩放（Ken Burns）</span>
                          <input
                            type="checkbox"
                            checked={live?.kenBurns !== false}
                            onChange={(e) => applyLive({ kenBurns: e.target.checked })}
                          />
                        </div>
                      </>
                    )}

                    {live?.mode === 'video' && (
                      <div className="field">
                        <label>视频文件（本地 mp4 / webm）</label>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input
                            className="input"
                            style={{ flex: 1 }}
                            value={live?.videoPath || ''}
                            placeholder="C:\\Users\\...\\gem.mp4"
                            onChange={(e) => applyLive({ videoPath: e.target.value })}
                          />
                          <button
                            className="btn"
                            onClick={async () => {
                              try {
                                const p = await desktop?.pickFile?.([
                                  { name: '视频', extensions: ['mp4', 'webm', 'mov'] },
                                ]);
                                if (p) applyLive({ videoPath: p });
                              } catch (err) {
                                onToast((err as Error).message);
                              }
                            }}
                          >
                            选择文件
                          </button>
                        </div>
                      </div>
                    )}

                    {live?.mode === 'web' && (
                      <div className="field">
                        <label>网页地址</label>
                        <input
                          className="input"
                          value={live?.webUrl || ''}
                          placeholder="https://..."
                          onChange={(e) => applyLive({ webUrl: e.target.value })}
                        />
                        <div className="hint">注意：很多站点禁止被内嵌（X-Frame-Options），这类网页做不了壁纸</div>
                      </div>
                    )}

                    <div className="field" style={{ marginTop: 6 }}>
                      <label>性能规则（避免抢资源）</label>
                      <div className="switch-row">
                        <span>有全屏应用 / 游戏时暂停</span>
                        <input
                          type="checkbox"
                          checked={live?.pauseOnFullscreen !== false}
                          onChange={(e) => applyLive({ pauseOnFullscreen: e.target.checked })}
                        />
                      </div>
                      <div className="switch-row">
                        <span>笔记本用电池时暂停</span>
                        <input
                          type="checkbox"
                          checked={!!live?.pauseOnBattery}
                          onChange={(e) => applyLive({ pauseOnBattery: e.target.checked })}
                        />
                      </div>
                    </div>
                  </Card>

              <Card
                title="定时自动切换"
                desc="按设定周期，从指定范围内自动更换桌面壁纸。"
                badge={
                  autoStatus?.config?.enabled ? (
                    <span style={{ color: 'var(--ok)', fontWeight: 400, fontSize: 12 }}>● 已启用</span>
                  ) : (
                    <span style={{ color: 'var(--warn)', fontWeight: 400, fontSize: 12 }}>○ 未启用</span>
                  )
                }
              >
                <div className="switch-row">
                  <span>启用自动换壁纸</span>
                  <input
                    type="checkbox"
                    checked={!!autoStatus?.config?.enabled}
                    onChange={(e) => saveAuto({ enabled: e.target.checked })}
                  />
                </div>

                <div className="field">
                  <label>切换频率</label>
                  <select
                    className="select"
                    style={{ width: '100%' }}
                    value={autoStatus?.config?.mode || 'day'}
                    onChange={(e) => saveAuto({ mode: e.target.value as AutoConfig['mode'] })}
                  >
                    <option value="day">每天</option>
                    <option value="week">每周</option>
                    <option value="month">每月</option>
                    <option value="custom">自定义间隔（分钟）</option>
                  </select>
                </div>

                {autoStatus?.config?.mode === 'custom' ? (
                  <div className="field">
                    <label>间隔分钟数</label>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      value={autoStatus?.config?.minutes ?? 60}
                      onChange={(e) => saveAuto({ minutes: Math.max(1, Number(e.target.value) || 60) })}
                    />
                  </div>
                ) : (
                  <>
                    <div className="field">
                      <label>执行时刻</label>
                      <input
                        className="input"
                        type="time"
                        value={autoStatus?.config?.atTime || '09:00'}
                        onChange={(e) => saveAuto({ atTime: e.target.value })}
                      />
                    </div>
                    {autoStatus?.config?.mode === 'week' && (
                      <div className="field">
                        <label>星期几</label>
                        <select
                          className="select"
                          style={{ width: '100%' }}
                          value={autoStatus?.config?.weekday ?? 1}
                          onChange={(e) => saveAuto({ weekday: Number(e.target.value) })}
                        >
                          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                            <option key={d} value={d}>
                              星期{'日一二三四五六'[d % 7]}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {autoStatus?.config?.mode === 'month' && (
                      <div className="field">
                        <label>每月几号</label>
                        <input
                          className="input"
                          type="number"
                          min={1}
                          max={28}
                          value={autoStatus?.config?.dayOfMonth ?? 1}
                          onChange={(e) =>
                            saveAuto({ dayOfMonth: Math.max(1, Math.min(28, Number(e.target.value) || 1)) })
                          }
                        />
                      </div>
                    )}
                  </>
                )}

                <div className="field">
                  <label>切换范围</label>
                  <select
                    className="select"
                    style={{ width: '100%' }}
                    value={autoStatus?.config?.scope || 'favorites'}
                    onChange={(e) => saveAuto({ scope: e.target.value as AutoConfig['scope'] })}
                  >
                    <option value="all">全库</option>
                    <option value="favorites">收藏 / 喜欢</option>
                    <option value="playlist">指定清单</option>
                  </select>
                </div>

                {autoStatus?.config?.scope === 'playlist' && (
                  <div className="field">
                    <label>选择清单</label>
                    <select
                      className="select"
                      style={{ width: '100%' }}
                      value={autoStatus?.config?.playlistId ?? ''}
                      onChange={(e) => saveAuto({ playlistId: Number(e.target.value) || null })}
                    >
                      <option value="">（请选择）</option>
                      {(playlists || []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}（{p.count}）
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="field">
                  <label>切换顺序</label>
                  <select
                    className="select"
                    style={{ width: '100%' }}
                    value={autoStatus?.config?.order || 'smart'}
                    onChange={(e) => saveAuto({ order: e.target.value as AutoConfig['order'] })}
                  >
                    <option value="ai">AI 智能适配（推荐）：知识库评分 + 壁纸适配度 + 时间偏好</option>
                    <option value="smart">智能：高分图片更常出现（用 AI 评分加权）</option>
                    <option value="random">随机（每张等概率）</option>
                    <option value="sequential">按顺序轮流</option>
                  </select>
                  <div className="hint">
                    评分来自知识库（采集时的 AI 打分 + 你的删除反馈），分数越高越容易被抽中，但低分图仍会偶尔出现
                    <br />
                    「AI 智能适配」会额外评估这张图<strong>适不适合做壁纸</strong>（留白、亮度、对比、复杂度，配了视觉模型还会让 AI 看一眼），
                    并按时间挑：白天偏明亮、夜间偏暗色
                  </div>
                </div>

                <div className="field">
                  <label>最低评分（低于该分数不做壁纸，0 = 不限）</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={100}
                    value={autoStatus?.config?.minScore ?? 0}
                    onChange={(e) => saveAuto({ minScore: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                  />
                </div>

                {/* AI 壁纸闭环开关 */}
                <div className="settings-subtitle" style={{ marginTop: 14 }}>
                  AI 闭环
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label className="switch-row">
                    <span>
                      评估「适不适合做壁纸」（留白 / 亮度 / 构图）
                      <span className="hint">　配了视觉模型时会让 AI 看一眼构图与主体位置</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={autoStatus?.config?.useAiFit !== false}
                      onChange={(e) => saveAuto({ useAiFit: e.target.checked })}
                    />
                  </label>
                  <label className="switch-row">
                    <span>
                      「不喜欢这张」自动归因并回流知识库
                      <span className="hint">
                        　先推断这张为什么不合适（噪点/光线/闭眼/动作…），只按该原因建规则；不会给整个来源或关键词降分
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={autoStatus?.config?.feedbackToKb !== false}
                      onChange={(e) => saveAuto({ feedbackToKb: e.target.checked })}
                    />
                  </label>
                  <label className="switch-row">
                    <span>
                      按时间挑图（白天偏亮 / 夜间偏暗）
                    </span>
                    <input
                      type="checkbox"
                      checked={autoStatus?.config?.useTimeAware !== false}
                      onChange={(e) => saveAuto({ useTimeAware: e.target.checked })}
                    />
                  </label>
                  <label className="switch-row">
                    <span>
                      抽到低清图时先自动增强再设为壁纸
                      <span className="hint">　会慢一些，但桌面不会出现糊图</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={autoStatus?.config?.autoEnhance === true}
                      onChange={(e) => saveAuto({ autoEnhance: e.target.checked })}
                    />
                  </label>
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                  <button className="btn primary" onClick={switchNow}>
                    立即切换一张
                  </button>
                  <button className="btn" onClick={() => loadAuto()}>
                    刷新状态
                  </button>
                  <button
                    className="btn"
                    onClick={async () => {
                      try {
                        const r = await api.scanWallpaperFit(120, true);
                        onToast(`已补算 ${r.done} 张壁纸适配度，剩余 ${r.remain} 张`);
                      } catch (err) {
                        onToast((err as Error).message);
                      }
                    }}
                    title="提前算好候选图的适配度，切换时更快"
                  >
                    补算适配度（120 张）
                  </button>
                </div>

                <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
                  · 范围内可用图片：{autoStatus?.scopeCount ?? 0} 张
                  <br />· 下次切换：
                  {autoStatus?.nextRunAt ? formatDate(autoStatus.nextRunAt) : '未安排'}
                  <br />· 上次切换：
                  {autoStatus?.lastLog ? `${autoStatus.lastLog.title || '图片'}（${formatDate(autoStatus.lastLog.appliedAt)}）` : '暂无'}
                </div>

                {wallpaperHistory.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>最近切换记录</div>
                    {wallpaperHistory.slice(0, 5).map((h) => (
                      <div key={h.id} style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.8 }}>
                        {formatDate(h.appliedAt)} · {h.title || `图片 ${h.imageId}`} ·{' '}
                        {h.scope === 'favorites' ? '收藏' : h.scope === 'playlist' ? '清单' : '全库'}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </>
  );
}
