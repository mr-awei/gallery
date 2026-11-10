import { useEffect, useMemo, useRef, useState } from 'react';
import { api, desktop, quiet } from '../../api';
import { confirmDialog } from '../../components/Dialogs';
import type { SourceInfo } from '../../api';
import type {
  AiPreset,
  AiStatus,
  Keyword,
  NetworkConfig,
  Settings as SettingsType,
} from '../../types';
import { subscribeEvents } from '../../events';

/**
 * 设置页的状态与操作层（从 Settings.tsx 抽出）。
 *
 * Settings.tsx 之前近 960 行，一半是表单 state/加载/保存逻辑、一半是 JSX；
 * 现在渲染层只解构这里的返回值，各区块组件也用同一个 form 对象，
 * 不再靠二三十个 props 逐层透传。
 */
export type SectionKey =
  | 'general'
  | 'guide'
  | 'crawl'
  | 'ai'
  | 'wallpaper'
  | 'network'
  | 'extension'
  | 'data'
  | 'tags'
  | 'shortcut'
  | 'enhance'
  | 'plugins'
  | 'market'
  | 'lan'
  | 'tasks'
  | 'models'
  | 'about';

export type SettingsForm = ReturnType<typeof useSettingsForm>;

export function useSettingsForm({
  onToast,
  onLibraryChanged,
}: {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  onLibraryChanged: () => void;
}) {
  const [section, setSection] = useState<SectionKey>('general');
  const [settings, setSettings] = useState<SettingsType | null>(null);
  // 脏标记：改动只在「保存设置」时落盘，离开页面 / 关窗口前必须提醒，否则静默丢掉
  const [dirty, setDirty] = useState(false);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [newKw, setNewKw] = useState('');
  const [wbLogin, setWbLogin] = useState(false);
  // 采集源列表由后端下发（唯一事实来源）；这里只缓存展示用的名字与提示
  const [sourceList, setSourceList] = useState<SourceInfo[]>([]);
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
    api
      .crawlConfig()
      .then((c) => setSourceList(c.sources.filter((s) => s.kind === 'crawl')))
      .catch(quiet);
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

  // 有未保存改动时关窗口/刷页提醒一次。
  // 留在 hook 顶层：首次渲染 settings 为 null，若把 effect 放到渲染层的提前返回之后，
  // 数据到位后 hook 数量会变化，React 会整树报错卸载（白屏）。
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

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

  // 以下函数原先定义在「settings 为空就提前 return」之后；hook 里没有提前返回，
  // 因此凡是读 settings 的地方都改为函数式更新 / 显式守卫。
  const patch = (p: Partial<SettingsType>) => {
    setSettings((s) => (s ? { ...s, ...p } : s));
    setDirty(true);
  };

  /* 教程开关是「应用级偏好」，改完立刻落盘：用户点完这个按钮多半就直接关设置了，
     走统一保存的话很容易忘了按「保存设置」，下次启动又弹一遍反而更烦 */
  const setTourHint = async (done: boolean) => {
    try {
      const saved = await api.saveSettings({ tourDone: done });
      setSettings((s) => (s ? { ...s, ...saved } : s));
      onToast(done ? '已关闭自动提醒：可以在本页随时重新播放' : '已重置：下次启动时会自动弹出教程');
    } catch (err) {
      onToast(`保存失败：${(err as Error).message}`, 'error');
    }
  };

  const save = async () => {
    if (!settings) return;
    // Cookie / AI Key 都是凭据（服务端已脱敏不回显），只提交输入框里的新草稿；留空 = 保持不变
    const draft = wbCookieDraft.trim();
    const aiDraft = aiKeyDraft.trim();
    const payload: SettingsType = draft
      ? { ...settings, weiboCookie: draft }
      : ({ ...settings, weiboCookie: '' } as SettingsType);
    payload.ai = aiDraft ? { ...payload.ai, apiKey: aiDraft } : { ...payload.ai, apiKey: '' };
    const prevDir = settings.storageDir;
    try {
      const saved = await api.saveSettings(payload);
      setSettings(saved);
      setDirty(false);
      if (draft) setWbCookieDraft('');
      if (aiDraft) setAiKeyDraft('');
      // 换了素材文件夹会触发后台扫描，明确告知用户，避免以为「选了目录却没反应」
      const dirChanged = (saved.storageDir || '') !== (prevDir || '');
      if (dirChanged) onLibraryChanged(); // 立即刷新图库，不用手动点刷新
      onToast(dirChanged ? '设置已保存，正在扫描新素材文件夹…' : '设置已保存');
    } catch (err) {
      onToast(`保存失败：${(err as Error).message}`, 'error');
    }
  };

  /** 清除服务端已保存的微博 Cookie（显式指令，区别于「留空不改」） */
  const clearWeiboCookie = async () => {
    try {
      const saved = await api.saveSettings({ weiboCookieClear: true });
      setSettings(saved);
      setWbCookieDraft('');
      onToast('已清除微博 Cookie');
    } catch (err) {
      onToast((err as Error).message, 'error');
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
      onToast((err as Error).message, 'error');
    }
  };

  const toggleSource = (key: string) => {
    setSettings((s) => (s ? { ...s, sources: { ...s.sources, [key]: !s.sources[key] } } : s));
    setDirty(true);
  };

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
      onToast((err as Error).message, 'error');
    } finally {
      setWbLogin(false);
    }
  };

  const addKeyword = async () => {
    const text = newKw.trim();
    if (!text) return;
    try {
      const res = await api.addKeyword(text);
      setKeywords(res.keywords);
      setNewKw('');
    } catch (err) {
      onToast(`添加失败：${(err as Error).message}`, 'error');
    }
  };

  const toggleKeyword = async (k: Keyword) => {
    try {
      const res = await api.updateKeyword(k.id, { enabled: k.enabled ? 0 : 1 });
      setKeywords(res.keywords);
    } catch (err) {
      onToast(`更新失败：${(err as Error).message}`, 'error');
    }
  };

  const removeKeyword = async (id: number) => {
    try {
      const res = await api.deleteKeyword(id);
      setKeywords(res.keywords);
    } catch (err) {
      onToast(`删除失败：${(err as Error).message}`, 'error');
    }
  };

  const runImport = async () => {
    setImporting(true);
    importingRef.current = true;
    try {
      await api.importLocal();
      onToast('已开始导入本地素材，完成后图库会自动刷新');
      // 完成时机由 job 事件推送（见上方订阅）；这里留超时兜底，防止推送断连时按钮永久锁死
      window.setTimeout(() => {
        if (importingRef.current) {
          importingRef.current = false;
          setImporting(false);
        }
      }, 15 * 60 * 1000);
    } catch (err) {
      // 失败必须立刻解锁：旧代码没有 catch，按钮一直显示「导入中」，只能等 15 分钟兜底
      importingRef.current = false;
      setImporting(false);
      onToast(`导入失败：${(err as Error).message}`, 'error');
    }
  };

  const clearAll = async () => {
    if (!(await confirmDialog('确定清空整个图库？图片文件也会一并删除（收藏与标签将丢失）。'))) return;
    try {
      const res = await api.clearLibrary();
      onToast(`已清空 ${res.removed} 张图片`);
      onLibraryChanged();
    } catch (err) {
      onToast(`清空失败：${(err as Error).message}`, 'error');
    }
  };

  return {
    section, setSection, settings, setSettings, dirty, setDirty,
    keywords, setKeywords, newKw, setNewKw, wbLogin, setWbLogin,
    sourceList, setSourceList, wbCookieDraft, setWbCookieDraft,
    aiKeyDraft, setAiKeyDraft, importing, setImporting,
    presets, setPresets, models, setModels, aiStatus, setAiStatus,
    testing, setTesting, aiError, setAiError,
    customModel, setCustomModel, customVision, setCustomVision,
    net, setNet, netError, setNetError, testingNet, setTestingNet,
    provider, modelOptions, visionOptions, netModeLabel,
    applyPreset, testAi, fetchModels, patch, setTourHint, save,
    clearWeiboCookie, clearAiApiKey, toggleSource, weiboLogin,
    addKeyword, toggleKeyword, removeKeyword, runImport, clearAll,
  };
}
