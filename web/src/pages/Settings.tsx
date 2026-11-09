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
import Select from '../components/Select';
import { useLang } from '../lib/i18n';
import ApiPlaygroundCard from './settings/ApiPlaygroundCard';
import AliasCard from './settings/AliasCard';
import ShortcutSection from './settings/ShortcutSection';
import WatchCard from './settings/WatchCard';
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
import ImportNameTemplateCard from './settings/ImportNameTemplateCard';
import PluginMarket from './settings/PluginMarket';

/** 分区标题双语内联：与 lib/i18n 同一套做法，不为 13 个标题另建词典 */
type SectionMeta = {
  key: SectionKey;
  label: string;
  labelEn: string;
  desc: string;
  descEn: string;
  icon: React.ReactNode;
};

/**
 * 侧栏按「使用顺序」分组，不再 14 项平铺：先搞清楚存哪里，再管素材，
 * 然后才是由采集衍生出来的智能、桌面、外部连接，最后是运行状态。
 */
const NAV_GROUPS: { label: string; labelEn: string; items: SectionMeta[] }[] = [
  {
    label: '开始使用',
    labelEn: 'Getting started',
    items: [
      {
        key: 'general',
        label: '通用',
        labelEn: 'General',
        desc: '图片保存位置、删除行为与编辑偏好',
        descEn: 'Where images are stored, delete behaviour and edit preferences',
        icon: <IconFolder />,
      },
      {
        key: 'guide',
        label: '教程',
        labelEn: 'Tutorials',
        desc: '分步导览、可搜索说明与常用入口',
        descEn: 'Guided tour, searchable docs and entry points',
        icon: <IconGrid />,
      },
    ],
  },
  {
    label: '素材与整理',
    labelEn: 'Media & organization',
    items: [
      {
        key: 'crawl',
        label: '采集',
        labelEn: 'Crawl',
        desc: '采集源、关键词与质量过滤',
        descEn: 'Sources, keywords and quality filters',
        icon: <IconSpider />,
      },
      {
        key: 'tags',
        label: '标签与别名',
        labelEn: 'Tags & aliases',
        desc: '同义词只影响搜索，不改图片标签',
        descEn: 'Synonyms affect search only, never the image tags',
        icon: <IconLayers />,
      },
      {
        key: 'data',
        label: '数据与维护',
        labelEn: 'Data & maintenance',
        desc: '本地导入、备份恢复与回收站',
        descEn: 'Local import, backup / restore and trash',
        icon: <IconImages />,
      },
    ],
  },
  {
    label: '智能与画质',
    labelEn: 'AI & image quality',
    items: [
      {
        key: 'ai',
        label: 'AI 接入',
        labelEn: 'AI providers',
        desc: '智能评分与知识库的大模型配置',
        descEn: 'Model settings for scoring and the knowledge base',
        icon: <IconBrain />,
      },
      {
        key: 'enhance',
        label: '画质增强',
        labelEn: 'Enhance',
        desc: '目标标准、增强模型与线上服务',
        descEn: 'Target presets, upscale models and cloud services',
        icon: <IconWand />,
      },
    ],
  },
  {
    label: '桌面与操作',
    labelEn: 'Desktop & controls',
    items: [
      {
        key: 'wallpaper',
        label: '壁纸',
        labelEn: 'Wallpaper',
        desc: '设壁纸的填充方式与定时自动切换',
        descEn: 'Fill mode and scheduled rotation',
        icon: <IconWallpaper />,
      },
      {
        key: 'shortcut',
        label: '快捷键',
        labelEn: 'Shortcuts',
        desc: '自定义主窗口的全局键位',
        descEn: 'Customise global hotkeys for the main window',
        icon: <IconGear />,
      },
    ],
  },
  {
    label: '连接与扩展',
    labelEn: 'Connections & extensions',
    items: [
      {
        key: 'network',
        label: '网络',
        labelEn: 'Network',
        desc: '代理设置，对采集、下载、AI 生效',
        descEn: 'Proxy used by crawling, downloads and AI',
        icon: <IconGlobe />,
      },
      {
        key: 'extension',
        label: '浏览器扩展',
        labelEn: 'Browser extension',
        desc: '在哪里、怎么装、怎么用',
        descEn: 'Where to install it and how to use it',
        icon: <IconLink />,
      },
      {
        key: 'plugins',
        label: '插件',
        labelEn: 'Plugins',
        desc: '脚本宿主与已安装插件',
        descEn: 'Script host and installed plugins',
        icon: <IconWand />,
      },
      {
        key: 'market',
        label: '插件市场',
        labelEn: 'Plugin market',
        desc: '浏览权限声明、一键安装与在线安装',
        descEn: 'Review permissions, one-click and online install',
        icon: <IconLink />,
      },
      {
        key: 'lan',
        label: '手机投送',
        labelEn: 'Send to phone',
        desc: '同一 Wi-Fi 扫码上传与只读分享',
        descEn: 'Same-Wi-Fi upload and read-only sharing',
        icon: <IconGlobe />,
      },
    ],
  },
  {
    label: '运行状态',
    labelEn: 'Runtime',
    items: [
      {
        key: 'tasks',
        label: '任务与撤销',
        labelEn: 'Tasks & undo',
        desc: '后台任务历史与操作回滚',
        descEn: 'Background job history and rollback',
        icon: <IconRotateCcw />,
      },
    ],
  },
];

const SECTIONS: SectionMeta[] = NAV_GROUPS.flatMap((g) => g.items);

export default function Settings({
  onToast,
  tourDone,
  onStartTour,
  onOpenTutorial,
  onLibraryChanged,
}: {
  /** 第二个参数用于区分失败提示（红色、停留更久） */
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  tourDone: boolean;
  onStartTour: () => void;
  /** 打开「使用教程」页（按功能搜索） */
  onOpenTutorial: () => void;
  onLibraryChanged: () => void;
}) {
  // 状态、加载与全部写操作都在 useSettingsForm 里；这里只解构渲染真正用到的字段。
  const form = useSettingsForm({ onToast, onLibraryChanged });
  const { lang, setLang } = useLang();
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

  const current = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0];
  // 双语取词：英文名缺失时回退中文，不显示空标签
  const L = (zh: string, en: string) => (lang === 'en' && en ? en : zh);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{L('设置', 'Settings')}</h1>
          <div className="page-sub">
            {L('按用途分组，左侧切换分类，改完点右上角保存', 'Grouped by purpose — pick a section on the left, then save at the top right')}
          </div>
          <div className="settings-scope">
            <span>
              <b>{L('按资源库独立', 'Per library')}</b>{' '}
              {L('采集源 / AI 评分 / 壁纸 / 删除策略 / 保存位置', 'sources · AI scoring · wallpaper · delete policy · storage location')}
            </span>
            <span>
              <b>{L('跨库共享', 'Shared across libraries')}</b> <span>{L('微博 Cookie / AI 接入 / 网络代理', 'Weibo cookie · AI providers · proxy')}</span>
            </span>
          </div>
        </div>
        <button
          className="btn primary"
          onClick={save}
          title={dirty ? '有未保存的改动' : '当前没有需要保存的改动'}
          style={dirty ? { boxShadow: '0 0 0 2px rgba(255,77,141,.35)' } : undefined}
        >
          {L('保存设置', 'Save')}
          {dirty ? ' ●' : ''}
        </button>
      </div>

      <div className="settings-shell">
        <nav className="settings-nav" aria-label={L('设置分类', 'Settings sections')}>
          <div className="nav-label">{L('设置分类', 'Sections')}</div>
          {NAV_GROUPS.map((g) => (
            <div className="nav-group" key={g.label}>
              <div className="nav-group-title">{L(g.label, g.labelEn)}</div>
              {g.items.map((s) => (
                <button
                  key={s.key}
                  className={section === s.key ? 'active' : ''}
                  onClick={() => setSection(s.key)}
                  title={L(s.desc, s.descEn)}
                >
                  {s.icon}
                  <span>{L(s.label, s.labelEn)}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="settings-panel">
          <div className="settings-panel-head">
            <span className="settings-panel-icon">{current.icon}</span>
            <div className="settings-panel-head-text">
              <h2>{L(current.label, current.labelEn)}</h2>
              <p>{L(current.desc, current.descEn)}</p>
            </div>
            {dirty && <span className="settings-badge">有未保存的改动</span>}
          </div>

          {/* ------------------------------ 通用 ------------------------------ */}
          {section === 'general' && (
            <Card title="通用" desc="决定素材落在哪里、删除时怎么处理，以及编辑与评分偏好。">
              <div className="settings-subhead">界面语言</div>
              <div className="field">
                <label>Language</label>
                <Select
                  className="select"
                  style={{ width: '100%' }}
                  value={lang}
                  onChange={(v) => setLang(v as 'zh' | 'en')}
                >
                  <option value="zh">简体中文</option>
                  <option value="en">English（部分覆盖）</option>
                </Select>
                <div className="hint" style={{ marginTop: 6 }}>
                  覆盖范围：侧栏与顶栏、设置页全部分区标题、人物页、常用按钮与空状态。对话框正文、教程与长文档仍是中文 ——
                  不做「假装已英文化」。
                </div>
              </div>
              <div className="settings-subhead">存储与删除</div>
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
              <div className="settings-subhead">评分与编辑</div>
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
              <div className="settings-subhead">快捷操作</div>
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
          {/* ------------------------------ 教程 ------------------------------ */}
          {section === 'guide' && (
            <>
              <Card
                title="教程"
                desc="分 7 步把重点功能串一遍：看什么、怎么找、怎么批量处理、怎么编辑。跟着点「下一步」即可，中途随时能跳过。"
                badge={
                  <span className="settings-badge">{tourDone ? '已看过 · 不会自动弹出' : '还没看过 · 启动时会自动弹出'}</span>
                }
              >
                <div className="field">
                  <label>分步导览</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn primary" onClick={onStartTour}>
                      开始 / 重看教程
                    </button>
                    <button className="btn" onClick={() => setTourHint(!tourDone)}>
                      {tourDone ? '下次启动时再自动提醒' : '关闭自动提醒'}
                    </button>
                  </div>
                  <div className="hint" style={{ marginTop: 6 }}>
                    提醒只影响「打开应用时会不会自动弹」，不影响随时从本页手动播放。
                  </div>
                </div>

                <div className="field">
                  <label>教程会讲到</label>
                  <ul className="hint" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
                    <li>侧栏与资源库：图库 / 收藏 / 清单 / 采集 / 待整理分别放什么</li>
                    <li>顶栏工具箱：裁切拼接、智能检索、画质增强、知识库</li>
                    <li>搜索与筛选：关键词、来源、评分、颜色、画幅，组合存成智能文件夹</li>
                    <li>多选与批量条：批量裁切、调色、水印 / 相框、移动、删除</li>
                    <li>大图里编辑：旋转、Camera Raw 调色、水印 / 相框、标注、版本回滚</li>
                    <li>设置：存储位置、备份导出、AI 接入、删除策略与快捷键</li>
                  </ul>
                </div>
              </Card>

              <Card
                title="使用教程（可搜索）"
                desc="每个功能一条完整说明：怎么用、边界在哪、对应快捷键。按关键词搜索比翻文档快。"
                badge={<span className="settings-badge">F1 随时打开</span>}
              >
                <div className="field">
                  <label>按功能查</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn primary" onClick={onOpenTutorial}>
                      打开使用教程
                    </button>
                  </div>
                  <div className="hint" style={{ marginTop: 6 }}>
                    覆盖浏览搜索、文件夹标签、堆叠笔记、查重整理、编辑导出、采集、壁纸、AI、数据备份等全部功能；
                    在教程页顶部输入「堆叠」「水印」「时间点」这类词即可定位。
                  </div>
                </div>
              </Card>

              <Card title="常用入口速查" desc="不想看导览时，这几个地方就是全部主流程。">
                <div className="hint" style={{ lineHeight: 1.9 }}>
                  <div>① 收集：顶部拖入文件 / 粘贴图片 / 侧栏「采集」按关键词抓图 / 浏览器扩展</div>
                  <div>② 整理：卡片悬停打星收藏、拖到左侧文件夹、多选后批量处理</div>
                  <div>③ 找图：顶部搜索框 + 筛选条件，或「智能检索」用一句话描述找</div>
                  <div>④ 编辑：双击开大图，「更多」里有裁切 / 调色 / 水印相框，写回前自动存版本</div>
                  <div>⑤ 备份：本页「数据与维护」里可导出、校验与恢复</div>
                  <div style={{ marginTop: 6 }}>键盘快捷键按 ? 查看；教程已跳过的，随时回来点「开始 / 重看教程」。</div>
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
          {section === 'extension' && (
            <>
              <ExtensionSection onToast={onToast} />
              <ApiPlaygroundCard onToast={onToast} />
            </>
          )}

          {/* ------------------------------ 插件 ------------------------------ */}
          {section === 'plugins' && <PluginSection onToast={onToast} onOpenMarket={() => setSection('market')} />}
          {section === 'market' && <PluginMarket onToast={onToast} />}
          {section === 'lan' && <LanSection onToast={onToast} />}

          {/* --------------------------- 数据与维护 --------------------------- */}
          {section === 'data' && (
            <>
              <div className="settings-subhead">导入与维护</div>
              <ImportNameTemplateCard
                value={settings.importNameTemplate || ''}
                applyToLocal={!!settings.importNameTemplateForLocal}
                onChange={(p) => patch(p)}
                onToast={onToast}
              />
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

              <MaintenanceCard onLibraryChanged={onLibraryChanged} onToast={onToast} />

              <div className="settings-subhead">备份与恢复</div>
              <DataTransferCard onLibraryChanged={onLibraryChanged} onToast={onToast} />
              <RecycleBinCard onLibraryChanged={onLibraryChanged} onToast={onToast} />
              <SyncCard onToast={onToast} onLibraryChanged={onLibraryChanged} />

              <div className="settings-subhead">扩展与监控</div>
              <WorkshopCard onToast={onToast} />
              <WatchCard onToast={onToast} />
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
