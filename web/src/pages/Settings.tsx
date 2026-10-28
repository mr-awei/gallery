import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  desktop,
  isDesktop,
  openFolder,
  pickFolder,
  SOURCE_OPTIONS,
} from '../api';
import { subscribeEvents } from '../events';
import { quiet } from '../api';
import type {
  AiPreset,
  AiStatus,
  Keyword,
  NetworkConfig,
  Settings as SettingsType,
} from '../types';
import {
  IconBrain,
  IconDownload,
  IconFolder,
  IconGlobe,
  IconImages,
  IconSpider,
  IconTrash,
  IconWand,
  IconWallpaper,
} from '../components/Icons';
import Card from './settings/Card';
import EnhanceSection from './settings/EnhanceSection';
import WallpaperSection from './settings/WallpaperSection';
import RecycleBinCard from './settings/RecycleBinCard';

type SectionKey = 'general' | 'crawl' | 'ai' | 'wallpaper' | 'network' | 'data' | 'enhance';

const SECTIONS: { key: SectionKey; label: string; desc: string; icon: React.ReactNode }[] = [
  { key: 'general', label: '通用', desc: '图片保存位置与删除行为', icon: <IconFolder /> },
  { key: 'crawl', label: '采集', desc: '采集源、关键词与质量过滤', icon: <IconSpider /> },
  { key: 'ai', label: 'AI 接入', desc: '智能评分与知识库的大模型配置', icon: <IconBrain /> },
  { key: 'wallpaper', label: '壁纸', desc: '设壁纸的填充方式与定时自动切换', icon: <IconWallpaper /> },
  { key: 'enhance', label: '画质增强', desc: '目标标准、增强模型与线上服务', icon: <IconWand /> },
  { key: 'network', label: '网络', desc: '代理设置，对采集、下载、AI 生效', icon: <IconGlobe /> },
  { key: 'data', label: '数据与维护', desc: '本地导入与回收站', icon: <IconImages /> },
];

export default function Settings({
  onToast,
  onLibraryChanged,
}: {
  onToast: (msg: string) => void;
  onLibraryChanged: () => void;
}) {
  const [section, setSection] = useState<SectionKey>('general');
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [newKw, setNewKw] = useState('');
  const [wbLogin, setWbLogin] = useState(false);
  // 微博 Cookie 输入草稿：已保存的凭据不会回显（服务端脱敏），留空保存 = 保持不变
  const [wbCookieDraft, setWbCookieDraft] = useState('');
  // AI API Key 同理：password 输入框只当「填写新 Key」用，留空保存 = 保持不变
  const [aiKeyDraft, setAiKeyDraft] = useState('');
  const [importing, setImporting] = useState(false);
  const [presets, setPresets] = useState<Record<string, AiPreset>>({});
  const [models, setModels] = useState<string[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [aiError, setAiError] = useState('');
  const [customModel, setCustomModel] = useState(false);
  const [customVision, setCustomVision] = useState(false);
  const [net, setNet] = useState<NetworkConfig | null>(null);
  const [netError, setNetError] = useState('');
  const [testingNet, setTestingNet] = useState(false);

  const provider = settings?.ai?.provider || '';
  const modelOptions = useMemo(
    () => Array.from(new Set([...(presets[provider]?.models || []), ...models])),
    [presets, models, provider]
  );
  const visionOptions = useMemo(
    () => Array.from(new Set([...(presets[provider]?.visionModels || []), ...models])),
    [presets, models, provider]
  );

  useEffect(() => {
    api.settings().then(setSettings);
    api.keywords().then(setKeywords);
    api.aiPresets().then(setPresets).catch(quiet);
    api.aiStatus().then(setAiStatus).catch(quiet);
    api.network().then(setNet).catch(quiet);
  }, []);

  // 任务进度推送（本地导入）→ 订阅 job 事件（原 1.2~1.5s 轮询；sr/aiUp 订阅已迁至 settings/EnhanceSection.tsx）
  const importingRef = useRef(false);
  importingRef.current = importing;

  useEffect(() => {
    const off = subscribeEvents('job', (d) => {
      try {
        if (d?.import) {
          const st = d.import;
          setImporting(!!st.running);
          if (importingRef.current && !st.running) {
            onToast(`导入完成：${st.message || ''}`);
            onLibraryChanged();
          }
          importingRef.current = !!st.running;
        }
      } catch {
        /* ignore */
      }
    });
    return () => {
      off();
    };
  }, [onToast, onLibraryChanged]);

  const netModeLabel = (mode?: string) =>
    ({ off: '直连', system: '系统代理', http: 'HTTP 代理', https: 'HTTPS 代理', socks5: 'SOCKS5 代理', socks4: 'SOCKS4 代理' }[
      mode || 'off'
    ] || '直连');

  const applyPreset = (key: string) => {
    const preset = presets[key];
    if (!preset || !settings) return;
    setCustomModel(false);
    setCustomVision(false);
    setSettings({
      ...settings,
      ai: {
        ...settings.ai,
        provider: key,
        baseUrl: preset.baseUrl,
        model: preset.models[0] || settings.ai.model,
        visionModel: preset.visionModels[0] || '',
      },
    });
    setModels(preset.models);
  };

  const testAi = async () => {
    setTesting(true);
    setAiError('');
    try {
      const res = await api.aiTest();
      onToast(`连接成功：${res.reply || res.model}`);
      setAiStatus(await api.aiStatus());
      if (res.models?.length) setModels(res.models);
    } catch (err) {
      setAiError((err as Error).message);
      onToast('连接失败，详情见下方提示');
    } finally {
      setTesting(false);
    }
  };

  const fetchModels = async () => {
    setAiError('');
    try {
      const res = await api.aiModels();
      setModels(res.models);
      setCustomModel(false);
      onToast(`拉取到 ${res.models.length} 个模型`);
    } catch (err) {
      setAiError((err as Error).message);
      onToast('拉取失败，详情见下方提示');
    }
  };

  if (!settings) {
    return (
      <div className="empty">
        <span className="spinner" />
      </div>
    );
  }

  const patch = (p: Partial<SettingsType>) => setSettings({ ...settings, ...p });

  const save = async () => {
    // Cookie / AI Key 都是凭据（服务端已脱敏不回显），只提交输入框里的新草稿；留空 = 保持不变
    const draft = wbCookieDraft.trim();
    const aiDraft = aiKeyDraft.trim();
    const payload: SettingsType = draft
      ? { ...settings, weiboCookie: draft }
      : ({ ...settings, weiboCookie: '' } as SettingsType);
    payload.ai = aiDraft ? { ...payload.ai, apiKey: aiDraft } : { ...payload.ai, apiKey: '' };
    const prevDir = settings.storageDir;
    const saved = await api.saveSettings(payload);
    setSettings(saved);
    if (draft) setWbCookieDraft('');
    if (aiDraft) setAiKeyDraft('');
    // 换了素材文件夹会触发后台扫描，明确告知用户，避免以为「选了目录却没反应」
    const dirChanged = (saved.storageDir || '') !== (prevDir || '');
    if (dirChanged) onLibraryChanged(); // 立即刷新图库，不用手动点刷新
    onToast(dirChanged ? '设置已保存，正在扫描新素材文件夹…' : '设置已保存');
  };

  /** 清除服务端已保存的微博 Cookie（显式指令，区别于「留空不改」） */
  const clearWeiboCookie = async () => {
    try {
      const saved = await api.saveSettings({ weiboCookieClear: true });
      setSettings(saved);
      setWbCookieDraft('');
      onToast('已清除微博 Cookie');
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  /** 清除服务端已保存的 AI API Key */
  const clearAiApiKey = async () => {
    try {
      const saved = await api.saveSettings({ aiApiKeyClear: true });
      setSettings(saved);
      setAiKeyDraft('');
      onToast('已清除 AI API Key');
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const toggleSource = (key: string) =>
    setSettings({ ...settings, sources: { ...settings.sources, [key]: !settings.sources[key] } });

  /** 内置浏览器登录微博，自动抓取 Cookie 并保存（桌面端专属） */
  const weiboLogin = async () => {
    setWbLogin(true);
    try {
      const res = await desktop?.weiboLogin?.();
      if (res?.ok && res.cookie) {
        const saved = await api.saveSettings({
          weiboCookie: res.cookie,
          weiboUserAgent: res.ua || '',
        });
        setSettings(saved);
        setWbCookieDraft('');
        onToast('已自动获取微博 Cookie 并保存');
      } else if (res?.msg) {
        onToast(res.msg);
      }
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setWbLogin(false);
    }
  };

  const addKeyword = async () => {
    const text = newKw.trim();
    if (!text) return;
    const res = await api.addKeyword(text);
    setKeywords(res.keywords);
    setNewKw('');
  };

  const toggleKeyword = async (k: Keyword) => {
    const res = await api.updateKeyword(k.id, { enabled: k.enabled ? 0 : 1 });
    setKeywords(res.keywords);
  };

  const removeKeyword = async (id: number) => {
    const res = await api.deleteKeyword(id);
    setKeywords(res.keywords);
  };

  const runImport = async () => {
    setImporting(true);
    importingRef.current = true;
    await api.importLocal();
    onToast('已开始导入本地素材，完成后图库会自动刷新');
    // 完成时机由 job 事件推送（见上方订阅）；这里留超时兜底，防止推送断连时按钮永久锁死
    window.setTimeout(() => {
      if (importingRef.current) {
        importingRef.current = false;
        setImporting(false);
      }
    }, 15 * 60 * 1000);
  };

  const runSeed = async () => {
    await api.seed();
    onToast('初始素材已尝试下载');
    onLibraryChanged();
  };

  const clearAll = async () => {
    if (!window.confirm('确定清空整个图库？图片文件也会一并删除（收藏与标签将丢失）。')) return;
    const res = await api.clearLibrary();
    onToast(`已清空 ${res.removed} 张图片`);
    onLibraryChanged();
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <div className="page-sub">保存位置 · 采集 · AI · 壁纸 · 网络 · 数据维护</div>
        </div>
        <button className="btn primary" onClick={save}>
          保存设置
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
                <select
                  className="select"
                  style={{ width: '100%' }}
                  value={settings.deletePolicy}
                  onChange={(e) => patch({ deletePolicy: e.target.value as SettingsType['deletePolicy'] })}
                >
                  <option value="trash">移到回收站（可恢复）</option>
                  <option value="permanent">彻底删除</option>
                  <option value="unlink">只从图库移除，保留文件</option>
                </select>
              </div>
              <div className="field">
                <label>智能评分阈值（低于该分采集时自动丢弃）</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  value={settings.scoreThreshold}
                  onChange={(e) => patch({ scoreThreshold: Number(e.target.value) || 0 })}
                />
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
            <>
              <Card title="采集源" desc="开关参与采集的图片来源，可多选。">
                {SOURCE_OPTIONS.map((s) => (
                  <div className="switch-row" key={s.key} title={s.hint}>
                    <span>
                      {s.label}
                      {s.hint && <span className="src-hint">需配置</span>}
                    </span>
                    <input type="checkbox" checked={!!settings.sources[s.key]} onChange={() => toggleSource(s.key)} />
                  </div>
                ))}
                <div className="field" style={{ marginTop: 14 }}>
                  <label>微博 Cookie（可选，填了才能用「微博图片」源）</label>
                  {isDesktop && (
                    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                      <button className="btn sm" onClick={weiboLogin} disabled={wbLogin}>
                        {wbLogin ? '等待登录…' : '打开内置浏览器登录，自动获取'}
                      </button>
                    </div>
                  )}
                  <textarea
                    className="input"
                    rows={2}
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                    value={wbCookieDraft}
                    placeholder={settings.hasWeiboCookie ? '已保存登录凭据（不回显）。粘贴新 Cookie 可覆盖' : 'SUB=xxx; SUBP=xxx; SSOLoginState=xxx; …（整段粘贴）'}
                    onChange={(e) => setWbCookieDraft(e.target.value)}
                  />
                  <div className="hint">
                    推荐用上面的「打开内置浏览器登录」：登录成功后自动抓取并保存，无需手动复制。
                    也可以手动获取：浏览器登录 weibo.com → 按 F12 → Network 面板随便点一个请求 →
                    复制请求头里的 Cookie 整段粘到这里。Cookie 只存在本机且加密保存，
                    不再回显到界面（此框留空保存 = 保持不变），仅用于让微博源以你的账号身份请求图片。
                  </div>
                  {settings.hasWeiboCookie && (
                    <div style={{ marginTop: 6 }}>
                      <button className="btn sm" onClick={clearWeiboCookie}>
                        清除已保存的 Cookie
                      </button>
                    </div>
                  )}
                </div>
              </Card>

              <Card title="关键词" desc="采集时按这些关键词逐个抓图，可临时停用某个词。">
                <div className="kw-list">
                  {keywords.map((k) => (
                    <div className="kw-row" key={k.id}>
                      <input type="checkbox" checked={!!k.enabled} onChange={() => toggleKeyword(k)} />
                      <span style={{ opacity: k.enabled ? 1 : 0.45 }}>{k.text}</span>
                      <button className="del" onClick={() => removeKeyword(k.id)}>
                        <IconTrash />
                      </button>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    placeholder="新增关键词…"
                    value={newKw}
                    onChange={(e) => setNewKw(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addKeyword()}
                  />
                  <button className="btn" onClick={addKeyword}>
                    添加
                  </button>
                </div>
              </Card>

              <Card title="抓取与质量过滤" desc="控制抓取量与入库门槛，过滤低质与重复图片。">
                <div className="field">
                  <label>每个关键词默认页数</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={20}
                    value={settings.pagesPerKeyword}
                    onChange={(e) => patch({ pagesPerKeyword: Number(e.target.value) || 1 })}
                  />
                </div>
                <div className="field">
                  <label>并发下载数</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={12}
                    value={settings.concurrency}
                    onChange={(e) => patch({ concurrency: Number(e.target.value) || 1 })}
                  />
                </div>
                <div className="field">
                  <label>Wallhaven API Key（可选）</label>
                  <input
                    className="input"
                    value={settings.wallhavenApiKey}
                    placeholder="留空亦可搜索 SFW 内容"
                    onChange={(e) => patch({ wallhavenApiKey: e.target.value })}
                  />
                </div>
                <div className="settings-subtitle">质量过滤与去重</div>
                <div className="field">
                  <label>长边最小像素</label>
                  <input
                    className="input"
                    type="number"
                    value={settings.minResolution}
                    onChange={(e) => patch({ minResolution: Number(e.target.value) || 0 })}
                  />
                  <div className="hint">低于该分辨率的图片会被丢弃（默认 800px）</div>
                </div>
                <div className="field">
                  <label>最小文件大小（KB）</label>
                  <input
                    className="input"
                    type="number"
                    value={settings.minFileSize}
                    onChange={(e) => patch({ minFileSize: Number(e.target.value) || 0 })}
                  />
                  <div className="hint">过滤图标、缩略图等小文件（默认 30KB）</div>
                </div>
                <div className="field">
                  <label>pHash 汉明距离阈值</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={32}
                    value={settings.phashThreshold}
                    onChange={(e) => patch({ phashThreshold: Number(e.target.value) || 0 })}
                  />
                  <div className="hint">≤ 该值判定为重复图片并丢弃（默认 8，越小越宽松）</div>
                </div>
                <div className="field">
                  <label>单张最大体积（MB）</label>
                  <input
                    className="input"
                    type="number"
                    value={settings.maxFileSize}
                    onChange={(e) => patch({ maxFileSize: Number(e.target.value) || 1 })}
                  />
                </div>
              </Card>
            </>
          )}

          {/* ---------------------------- AI 接入 ---------------------------- */}
          {section === 'ai' && (
            <Card
              title="AI 接入"
              desc="用于图片智能评分、看图分析、删除原因学习与知识库。不配置也能正常使用。"
              badge={
                aiStatus?.ready ? (
                  <span style={{ color: 'var(--ok)', fontWeight: 400, fontSize: 12 }}>● 已就绪</span>
                ) : (
                  <span style={{ color: 'var(--warn)', fontWeight: 400, fontSize: 12 }}>○ 未配置</span>
                )
              }
            >
              <div className="field">
                <label>厂家预设（均为 OpenAI 兼容接口）</label>
                <select
                  className="select"
                  style={{ width: '100%' }}
                  value={settings.ai?.provider || 'custom'}
                  onChange={(e) => applyPreset(e.target.value)}
                >
                  {Object.entries(presets).map(([key, p]) => (
                    <option key={key} value={key}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Base URL</label>
                <input
                  className="input"
                  value={settings.ai?.baseUrl || ''}
                  placeholder="https://api.deepseek.com/v1"
                  onChange={(e) => patch({ ai: { ...settings.ai, baseUrl: e.target.value } })}
                />
              </div>
              <div className="field">
                <label>API Key</label>
                <input
                  className="input"
                  type="password"
                  value={aiKeyDraft}
                  placeholder={settings.hasAiApiKey ? '已保存（不回显），粘贴新 Key 可覆盖' : 'sk-...'}
                  onChange={(e) => setAiKeyDraft(e.target.value)}
                />
                {settings.hasAiApiKey && (
                  <div style={{ marginTop: 6 }}>
                    <button className="btn sm" onClick={clearAiApiKey}>
                      清除已保存的 Key
                    </button>
                  </div>
                )}
                <div className="hint">
                  {presets[settings.ai?.provider || '']?.keyHint || '按接口方要求填写'}
                  {presets[settings.ai?.provider || '']?.docs && (
                    <>
                      {' · '}
                      <a
                        href={presets[settings.ai?.provider || ''].docs}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: 'var(--accent)' }}
                      >
                        去获取密钥
                      </a>
                    </>
                  )}
                </div>
              </div>
              <div className="field">
                <label>文本模型（归纳规则 / 生成建议）</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {customModel || !modelOptions.length ? (
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      value={settings.ai?.model || ''}
                      placeholder="如 glm-4-flash / gpt-4o-mini / deepseek-chat"
                      onChange={(e) => patch({ ai: { ...settings.ai, model: e.target.value } })}
                    />
                  ) : (
                    <select
                      className="select"
                      style={{ flex: 1 }}
                      value={settings.ai?.model || ''}
                      onChange={(e) =>
                        e.target.value === '__custom__'
                          ? setCustomModel(true)
                          : patch({ ai: { ...settings.ai, model: e.target.value } })
                      }
                    >
                      {settings.ai?.model && !modelOptions.includes(settings.ai.model) && (
                        <option value={settings.ai.model}>{settings.ai.model}（当前）</option>
                      )}
                      {modelOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      <option value="__custom__">自定义 / 手动输入…</option>
                    </select>
                  )}
                  <button className="btn" onClick={fetchModels} title="从接口拉取模型列表">
                    拉取
                  </button>
                  <button
                    className="btn"
                    onClick={() => setCustomModel((v) => !v)}
                    title="在下拉与手动输入之间切换"
                  >
                    {customModel ? '下拉' : '手填'}
                  </button>
                </div>
                {modelOptions.length > 0 && !customModel && (
                  <div className="hint">共 {modelOptions.length} 个可选模型</div>
                )}
              </div>
              <div className="field">
                <label>视觉模型（看图分析，可留空复用文本模型）</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {customVision || !visionOptions.length ? (
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      value={settings.ai?.visionModel || ''}
                      placeholder="如 glm-4v-flash / qwen-vl-max-latest / gpt-4o-mini"
                      onChange={(e) => patch({ ai: { ...settings.ai, visionModel: e.target.value } })}
                    />
                  ) : (
                    <select
                      className="select"
                      style={{ flex: 1 }}
                      value={settings.ai?.visionModel || ''}
                      onChange={(e) =>
                        e.target.value === '__custom__'
                          ? setCustomVision(true)
                          : patch({ ai: { ...settings.ai, visionModel: e.target.value } })
                      }
                    >
                      {settings.ai?.visionModel && !visionOptions.includes(settings.ai.visionModel) && (
                        <option value={settings.ai.visionModel}>{settings.ai.visionModel}（当前）</option>
                      )}
                      {visionOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      <option value="__custom__">自定义 / 手动输入…</option>
                    </select>
                  )}
                  <button
                    className="btn"
                    onClick={() => setCustomVision((v) => !v)}
                    title="在下拉与手动输入之间切换"
                  >
                    {customVision ? '下拉' : '手填'}
                  </button>
                </div>
              </div>
              <div className="switch-row">
                <span>启用 AI</span>
                <input
                  type="checkbox"
                  checked={!!settings.ai?.enabled}
                  onChange={(e) => patch({ ai: { ...settings.ai, enabled: e.target.checked } })}
                />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn" onClick={testAi} disabled={testing}>
                  {testing ? '测试中…' : '测试连接'}
                </button>
              </div>
              {aiError && <div className="ai-result" style={{ borderColor: 'rgba(248,113,113,0.4)' }}>{aiError}</div>}
              <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
                · 密钥只保存在本机数据库，不外传
                <br />· 不配置也能用：删除原因会直接转成规则
                <br />· 401：密钥错误/过期/带空格；403：无该模型权限；404：Base URL 填错；429：限流或余额不足
                <br />· 部分厂家不开放 /models 接口，拉取失败可直接手填模型名后点「测试连接」
                <br />· 修改后点右上角「保存设置」生效
              </div>
            </Card>
          )}

          {/* ------------------------------ 画质增强（已拆分至 settings/EnhanceSection.tsx） ------------------------------ */}
          {section === 'enhance' && <EnhanceSection settings={settings} patch={patch} onToast={onToast} />}

          {/* ------------------------------ 壁纸（已拆分至 settings/WallpaperSection.tsx） ------------------------------ */}
          {section === 'wallpaper' && <WallpaperSection settings={settings} patch={patch} onToast={onToast} />}

          {/* ------------------------------ 网络 ------------------------------ */}
          {section === 'network' && (
            <Card
              title="网络 / 代理"
              desc="采集 Wallhaven 等外网源、AI 接口访问不畅时，配置代理即可。"
              badge={
                <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
                  {netModeLabel(net?.mode)}
                </span>
              }
            >
              <div className="field">
                <label>代理模式</label>
                <select
                  className="select"
                  style={{ width: '100%' }}
                  value={net?.mode || 'off'}
                  onChange={(e) => setNet((prev) => (prev ? { ...prev, mode: e.target.value } : prev))}
                >
                  {(net?.modes || []).map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              {net && !['off', 'system'].includes(net.mode) && (
                <>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div className="field" style={{ flex: 2 }}>
                      <label>主机</label>
                      <input
                        className="input"
                        value={net.host}
                        onChange={(e) => setNet({ ...net, host: e.target.value })}
                      />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>端口</label>
                      <input
                        className="input"
                        type="number"
                        value={net.port}
                        onChange={(e) => setNet({ ...net, port: Number(e.target.value) || 0 })}
                      />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div className="field" style={{ flex: 1 }}>
                      <label>用户名（可选）</label>
                      <input
                        className="input"
                        value={net.username}
                        onChange={(e) => setNet({ ...net, username: e.target.value })}
                      />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>密码（可选）</label>
                      <input
                        className="input"
                        type="password"
                        value={net.password}
                        onChange={(e) => setNet({ ...net, password: e.target.value })}
                      />
                    </div>
                  </div>
                </>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="btn"
                  disabled={testingNet}
                  onClick={async () => {
                    if (!net) return;
                    setTestingNet(true);
                    try {
                      await api.saveNetwork(net);
                      const res = await api.testNetwork();
                      if (res.ok) onToast(`网络正常（${res.proxy}，${res.elapsed}ms）`);
                      else onToast(`网络不通（${res.proxy}），详见下方提示`);
                      setNetError(JSON.stringify(res.results, null, 2));
                    } catch (err) {
                      setNetError((err as Error).message);
                    } finally {
                      setTestingNet(false);
                    }
                  }}
                >
                  {testingNet ? '测试中…' : '测试连接'}
                </button>
                <button
                  className="btn primary"
                  onClick={async () => {
                    if (!net) return;
                    const saved = await api.saveNetwork(net);
                    setNet(saved);
                    onToast(saved.applied ? '网络设置已生效' : '已保存（网页模式下代理不生效，请用桌面端）');
                  }}
                >
                  保存并应用
                </button>
              </div>
              {netError && <div className="ai-result">{netError}</div>}
              <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
                · 常见本地端口：Clash 7890（HTTP/SOCKS5）、v2rayN 10808（SOCKS5）/ 10809（HTTP）
                <br />· 建议同时勾选 Wallhaven 等外网来源后再开代理采集
                <br />· 系统代理（自动）会跟随 Windows 的代理设置
              </div>
            </Card>
          )}

          {/* --------------------------- 数据与维护 --------------------------- */}
          {section === 'data' && (
            <>
              <Card title="图库维护" desc="本地素材导入与初始化。">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <button className="btn" onClick={runImport} disabled={importing}>
                    {importing ? '导入中…' : '导入工作区本地素材'}
                  </button>
                  <button className="btn" onClick={runSeed}>
                    <IconDownload /> 下载初始素材（6 张 4K）
                  </button>
                  <button className="btn danger" onClick={clearAll}>
                    <IconTrash /> 清空图库
                  </button>
                </div>
                <div className="hint" style={{ marginTop: 14, lineHeight: 1.9 }}>
                  · 采集到的图片直接写入「通用」里设置的本地文件夹，可用资源管理器直接访问
                  <br />· 本地已有素材按原路径登记并生成缩略图，不复制原文件
                  <br />· 大图预览中可一键「设为桌面壁纸」「在文件夹中显示」
                </div>
              </Card>

              <RecycleBinCard onLibraryChanged={onLibraryChanged} onToast={onToast} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
