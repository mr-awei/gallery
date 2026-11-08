import React from 'react';
import { api, isDesktop, openFolder, pickFolder } from '../api';
import type { Settings as SettingsType } from '../types';
import CrawlSection from './settings/CrawlSection';
import {
  IconBrain,
  IconFolder,
  IconGear,
  IconGlobe,
  IconGrid,
  IconImages,
  IconLayers,
  IconLink,
  IconRotateCcw,
  IconSpider,
  IconTrash,
  IconWand,
  IconWallpaper,
} from '../components/Icons';
import Card from './settings/Card';
import AliasCard from './settings/AliasCard';
import ShortcutSection from './settings/ShortcutSection';
import WatchCard from './settings/WatchCard';
import Select from '../components/Select';
import EnhanceSection from './settings/EnhanceSection';
import WallpaperSection from './settings/WallpaperSection';
import RecycleBinCard from './settings/RecycleBinCard';
import MaintenanceCard from './settings/MaintenanceCard';
import DataTransferCard from './settings/DataTransferCard';
import JobsSection from './settings/JobsSection';
import ExtensionSection from './settings/ExtensionSection';
import PluginSection from './settings/PluginSection';
import LanSection from './settings/LanSection';
import NetworkSection from './settings/NetworkSection';
import DebouncedInput from './settings/DebouncedInput';
import WorkshopCard from './settings/WorkshopCard';
import SyncCard from './settings/SyncCard';
import AiSection from './settings/AiSection';
import { useSettingsForm, type SectionKey } from './settings/useSettingsForm';

const SECTIONS: { key: SectionKey; label: string; desc: string; icon: React.ReactNode }[] = [
  { key: 'general', label: '通用', desc: '图片保存位置与删除行为', icon: <IconFolder /> },
  { key: 'guide', label: '新手教程', desc: '分步了解重点功能，可随时重看', icon: <IconGrid /> },
  { key: 'crawl', label: '采集', desc: '采集源、关键词与质量过滤', icon: <IconSpider /> },
  { key: 'ai', label: 'AI 接入', desc: '智能评分与知识库的大模型配置', icon: <IconBrain /> },
  { key: 'wallpaper', label: '壁纸', desc: '设壁纸的填充方式与定时自动切换', icon: <IconWallpaper /> },
  { key: 'enhance', label: '画质增强', desc: '目标标准、增强模型与线上服务', icon: <IconWand /> },
  { key: 'network', label: '网络', desc: '代理设置，对采集、下载、AI 生效', icon: <IconGlobe /> },
  { key: 'extension', label: '浏览器扩展', desc: '在哪里、怎么装、怎么用', icon: <IconLink /> },
  { key: 'plugins', label: '插件', desc: '脚本宿主与已安装插件', icon: <IconWand /> },
  { key: 'lan', label: '手机投送', desc: '局域网扫码上传', icon: <IconGlobe /> },
  { key: 'data', label: '数据与维护', desc: '本地导入、备份恢复与回收站', icon: <IconImages /> },
  { key: 'tags', label: '标签与别名', desc: '同义词只影响搜索，不改图片标签', icon: <IconLayers /> },
  { key: 'shortcut', label: '快捷键', desc: '自定义主窗口的全局键位', icon: <IconGear /> },
  { key: 'tasks', label: '任务与撤销', desc: '后台任务历史与操作回滚', icon: <IconRotateCcw /> },
];

export default function Settings({
  onToast,
  tourDone,
  onStartTour,
  onLibraryChanged,
}: {
  /** 第二个参数用于区分失败提示（红色、停留更久） */
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  tourDone: boolean;
  onStartTour: () => void;
  onLibraryChanged: () => void;
}) {
  // 状态、加载与全部写操作都在 useSettingsForm 里；这里只解构渲染真正用到的字段。
  const form = useSettingsForm({ onToast, onLibraryChanged });
  const {
    section, setSection, settings, dirty, save, patch, setDirty,
    keywords, newKw, setNewKw, wbLogin, sourceList,
    wbCookieDraft, setWbCookieDraft, importing,
    setTourHint, clearWeiboCookie, toggleSource, weiboLogin,
    addKeyword, toggleKeyword, removeKeyword, runImport, clearAll,
  } = form;

  if (!settings) {
    return (
      <div className="empty">
        <span className="spinner" />
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <div className="page-sub">保存位置 · 采集 · AI · 壁纸 · 网络 · 数据维护</div>
          <div className="hint" style={{ marginTop: 6 }}>
            <b>按资源库独立保存</b>：采集源与关键词、AI 评分开关、壁纸、删除策略、保存位置——每个库一套，切换资源库自动套用。
            <br />
            <b>跨库共享</b>：微博 Cookie、AI 接入（密钥与模型）、网络代理——一处配置，所有库通用
          </div>
        </div>
        <button
          className="btn primary"
          onClick={save}
          title={dirty ? '有未保存的改动' : '当前没有需要保存的改动'}
          style={dirty ? { boxShadow: '0 0 0 2px rgba(255,77,141,.35)' } : undefined}
        >
          保存设置{dirty ? ' ●' : ''}
        </button>
      </div>

      <div className="settings-shell">
        <nav className="settings-nav">
          <div className="nav-label">设置分类</div>
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              className={section === s.key ? 'active' : ''}
              onClick={() => setSection(s.key)}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-panel">
          {/* ------------------------------ 通用 ------------------------------ */}
          {section === 'general' && (
            <Card title="通用" desc="采集到的图片保存到哪里、删除图片时的行为。">
              <div className="field">
                <label>图片保存文件夹</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    value={settings.storageDir}
                    onChange={(e) => patch({ storageDir: e.target.value })}
                  />
                  <button
                    className="btn"
                    disabled={!isDesktop}
                    title={isDesktop ? '选择文件夹' : '仅桌面端支持选择文件夹'}
                    onClick={async () => {
                      const dir = await pickFolder();
                      if (dir) {
                        patch({ storageDir: dir });
                        await api.saveSettings({ storageDir: dir });
                        onToast(`保存文件夹已设置为 ${dir}，正在扫描…`);
                        onLibraryChanged(); // 立即刷新图库，不用手动点刷新
                      }
                    }}
                  >
                    选择…
                  </button>
                </div>
                <div className="hint">
                  文件名格式：关键词_来源_宽x高_时间.jpg；可直接用资源管理器浏览、设为壁纸
                </div>
              </div>
              <div className="field">
                <label>在软件里删除图片时</label>
                <Select
                  className="select"
                  style={{ width: '100%' }}
                  value={settings.deletePolicy}
                  onChange={(v) => patch({ deletePolicy: v as SettingsType['deletePolicy'] })}
                >
                  <option value="trash">移到回收站（可恢复）</option>
                  <option value="permanent">彻底删除</option>
                  <option value="unlink">只从图库移除，保留文件</option>
                </Select>
              </div>
              <div className="field">
                <label>智能评分阈值（低于该分采集时自动丢弃）</label>
                <DebouncedInput
                  type="number"
                  min={0}
                  max={100}
                  value={settings.scoreThreshold}
                  onCommit={(v) => patch({ scoreThreshold: Number(v) || 0 })}
                />
              </div>
              <div className="field" style={{ maxWidth: 260 }}>
                <label>调色历史保留步数</label>
                <DebouncedInput
                  type="number"
                  min={1}
                  max={500}
                  value={settings.historySteps ?? 100}
                  onCommit={(v) => patch({ historySteps: Math.min(500, Math.max(1, Number(v) || 100)) })}
                />
                <div className="hint">
                  调色台左侧「历史记录」最多留多少步，默认 100（1~500）。一次拖动只算一步，调完色还能点到之前某一步
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => openFolder(settings.storageDir)}>
                  <IconFolder /> 打开文件夹
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    const res = await api.scanFolder();
                    onToast(res.ok ? `扫描完成：新增 ${res.saved ?? 0} 张` : res.message || '扫描失败');
                    onLibraryChanged();
                  }}
                >
                  重新扫描文件夹
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    const res = await api.purgeMissing();
                    onToast(`已清理 ${res.removed} 条失效记录`);
                    onLibraryChanged();
                  }}
                >
                  清理失效记录
                </button>
              </div>
              <div className="hint" style={{ marginTop: 12 }}>
                修改保存位置或删除策略后，点右上角「保存设置」生效
              </div>
            </Card>
          )}

          {/* ------------------------------ 采集 ------------------------------ */}
          {section === 'crawl' && (
            <CrawlSection
              settings={settings}
              patch={patch}
              isDesktop={isDesktop}
              sources={sourceList}
              toggleSource={toggleSource}
              wbLogin={wbLogin}
              weiboLogin={weiboLogin}
              wbCookieDraft={wbCookieDraft}
              setWbCookieDraft={(v: string) => {
                setWbCookieDraft(v);
                setDirty(true);
              }}
              clearWeiboCookie={clearWeiboCookie}
              keywords={keywords}
              toggleKeyword={toggleKeyword}
              removeKeyword={removeKeyword}
              newKw={newKw}
              setNewKw={setNewKw}
              addKeyword={addKeyword}
            />
          )}

          {/* ---------------------------- AI 接入（已拆分至 settings/AiSection.tsx） ---------------------------- */}
          {section === 'ai' && <AiSection form={form} />}

          {/* ------------------------------ 画质增强（已拆分至 settings/EnhanceSection.tsx） ------------------------------ */}
          {section === 'enhance' && <EnhanceSection settings={settings} patch={patch} onToast={onToast} />}

          {/* ---------------------- 任务与撤销（已拆分至 settings/JobsSection.tsx） ---------------------- */}
          {/* ------------------------------ 新手教程 ------------------------------ */}
          {section === 'guide' && (
            <>
              <Card
                title="新手教程"
                desc="分 7 步把重点功能串一遍：看什么、怎么找、怎么批量处理、怎么编辑。跟着点「下一步」即可，中途随时能跳过。"
                badge={
                  <span className="settings-badge">{tourDone ? '已看过 · 不会自动弹出' : '还没看过 · 启动时会自动弹出'}</span>
                }
              >
                <div className="field">
                  <label>分步导览</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn primary" onClick={onStartTour}>
                      开始 / 重看新手教程
                    </button>
                    <button className="btn" onClick={() => setTourHint(!tourDone)}>
                      {tourDone ? '下次启动时再自动提醒' : '关闭自动提醒'}
                    </button>
                  </div>
                  <div className="fs-hint" style={{ marginTop: 6 }}>
                    提醒只影响「打开应用时会不会自动弹」，不影响随时从本页手动播放。
                  </div>
                </div>

                <div className="field">
                  <label>教程会讲到</label>
                  <ul className="fs-hint" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
                    <li>侧栏与资源库：图库 / 收藏 / 清单 / 采集 / 待整理分别放什么</li>
                    <li>顶栏工具箱：裁切拼接、智能检索、画质增强、知识库</li>
                    <li>搜索与筛选：关键词、来源、评分、颜色、画幅，组合存成智能文件夹</li>
                    <li>多选与批量条：批量裁切、调色、水印 / 相框、移动、删除</li>
                    <li>大图里编辑：旋转、Camera Raw 调色、水印 / 相框、标注、版本回滚</li>
                    <li>设置：存储位置、备份导出、AI 接入、删除策略与快捷键</li>
                  </ul>
                </div>
              </Card>

              <Card title="常用入口速查" desc="不想看导览时，这几个地方就是全部主流程。">
                <div className="fs-hint" style={{ lineHeight: 1.9 }}>
                  <div>① 收集：顶部拖入文件 / 粘贴图片 / 侧栏「采集」按关键词抓图 / 浏览器扩展</div>
                  <div>② 整理：卡片悬停打星收藏、拖到左侧文件夹、多选后批量处理</div>
                  <div>③ 找图：顶部搜索框 + 筛选条件，或「智能检索」用一句话描述找</div>
                  <div>④ 编辑：双击开大图，「更多」里有裁切 / 调色 / 水印相框，写回前自动存版本</div>
                  <div>⑤ 备份：本页「数据与维护」里可导出、校验与恢复</div>
                  <div style={{ marginTop: 6 }}>键盘快捷键按 ? 查看；教程已跳过的，随时回来点「开始 / 重看新手教程」。</div>
                </div>
              </Card>
            </>
          )}

          {section === 'tasks' && <JobsSection onToast={onToast} />}

          {/* ------------------------------ 壁纸（已拆分至 settings/WallpaperSection.tsx） ------------------------------ */}
          {section === 'wallpaper' && <WallpaperSection settings={settings} patch={patch} onToast={onToast} />}

          {/* ------------------------------ 网络（已拆分至 settings/NetworkSection.tsx） ------------------------------ */}
          {section === 'network' && <NetworkSection form={form} onToast={onToast} />}

          {/* --------------------------- 浏览器扩展 --------------------------- */}
          {section === 'extension' && <ExtensionSection onToast={onToast} />}

          {/* ------------------------------ 插件 ------------------------------ */}
          {section === 'plugins' && <PluginSection onToast={onToast} />}
          {section === 'lan' && <LanSection onToast={onToast} />}

          {/* --------------------------- 数据与维护 --------------------------- */}
          {section === 'data' && (
            <>
              <Card title="图库维护" desc="本地素材导入与初始化。">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <button className="btn" onClick={runImport} disabled={importing}>
                    {importing ? '导入中…' : '导入工作区本地素材'}
                  </button>
                  {/* 「下载初始素材」已移除：SEED_URLS 是空数组，按钮点下去只会显示"已尝试下载" */}
                  <button className="btn danger" onClick={clearAll}>
                    <IconTrash /> 清空图库
                  </button>
                </div>
                <div className="field" style={{ marginTop: 14, maxWidth: 260 }}>
                  <label>导入深度（层）</label>
                  <DebouncedInput
                    type="number"
                    min={1}
                    max={16}
                    value={settings.importMaxDepth ?? 4}
                    onCommit={(v) => patch({ importMaxDepth: Math.min(16, Math.max(1, Number(v) || 4)) })}
                  />
                  <div className="hint">
                    扫描子文件夹的层数上限，默认 4。放得更深的素材需要调大，否则导入结束会提示有目录被跳过
                  </div>
                </div>
                <div className="hint" style={{ marginTop: 14, lineHeight: 1.9 }}>
                  · 采集到的图片直接写入「通用」里设置的本地文件夹，可用资源管理器直接访问
                  <br />· 本地已有素材按原路径登记并生成缩略图，不复制原文件
                  <br />· 大图预览中可一键「设为桌面壁纸」「在文件夹中显示」
                </div>
              </Card>

              <DataTransferCard onLibraryChanged={onLibraryChanged} onToast={onToast} />

              <WorkshopCard onToast={onToast} />
              <SyncCard onToast={onToast} onLibraryChanged={onLibraryChanged} />

              <MaintenanceCard onLibraryChanged={onLibraryChanged} onToast={onToast} />

              <WatchCard onToast={onToast} />
              <RecycleBinCard onLibraryChanged={onLibraryChanged} onToast={onToast} />
            </>
          )}

          {/* --------------------------- 标签与别名 --------------------------- */}
          {section === 'tags' && <AliasCard onToast={onToast} />}

          {/* --------------------------- 快捷键 --------------------------- */}
          {section === 'shortcut' && <ShortcutSection />}
        </div>
      </div>
    </div>
  );
}
