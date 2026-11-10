import React, { useEffect, useState } from 'react';
import { desktop, getAppInfo, quiet } from '../../api';
import type { AppInfo, UpdateState } from '../../api';
import type { Settings as SettingsType } from '../../types';
import Card from './Card';

interface Props {
  settings: SettingsType;
  patch: (p: Partial<SettingsType>) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  /** 打开站内「使用教程」页（F1 那个） */
  onOpenTutorial: () => void;
}

const EMPTY_STATE: UpdateState = {
  status: 'idle',
  percent: 0,
  version: '',
  notes: '',
  error: '',
  supported: false,
};

/** 官方仓库兜底：app-info 没拿到时（浏览器预览）也要能拼出发布页地址 */
const FALLBACK_REPO = 'mr-awei/gallery';

/** 展示名固定写这里：app.getName() 在开发态返回 package.json 的 name（tuku-gallery），不能直接给用户看 */
const APP_NAME = 'TuKu 图库';

const PLATFORM_LABEL: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

/**
 * 第三方组件：只列「自己写不出来、缺了功能就没了」的那些。
 * 不列传递依赖 —— 长列表没人看，也更容易写错许可。
 */
const COMPONENTS: { name: string; use: string; license: string }[] = [
  { name: 'Electron / Chromium', use: '桌面外壳与渲染引擎', license: 'MIT / BSD-3-Clause' },
  { name: 'React 18', use: '界面框架', license: 'MIT' },
  { name: 'Express 5', use: '本地 API 服务（只监听 127.0.0.1）', license: 'MIT' },
  { name: 'SQLite（node:sqlite）', use: '素材索引、标签、设置', license: 'Public Domain' },
  { name: 'sharp / libvips', use: '缩略图、格式转换、色彩处理', license: 'Apache-2.0 / LGPL-3.0+' },
  { name: 'libheif-js', use: 'HEIC / AVIF 解码', license: 'LGPL-3.0' },
  { name: '@huggingface/transformers', use: '中文 CLIP 语义检索（本机推理）', license: 'Apache-2.0' },
  { name: 'ONNX Runtime（WASM）', use: '人脸检测与相似度（本机推理）', license: 'MIT' },
  { name: 'three.js', use: '3D 模型查看', license: 'MIT' },
  { name: 'JSZip / SheetJS / mammoth / @webtoon/psd', use: '插件包、表格导入、Word 导入、PSD 预览', license: 'MIT / Apache-2.0 / BSD-2-Clause' },
  { name: 'electron-updater', use: '应用内自动更新', license: 'MIT' },
  { name: 'Vite 7', use: '前端构建（开发期）', license: 'MIT' },
];

/** 一行「标签 — 值」，长路径自动换行不撑破面板 */
function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="about-row">
      <span className="about-row-label">{label}</span>
      <span className={`about-row-value${mono ? ' mono' : ''}`}>{value || '—'}</span>
    </div>
  );
}

/**
 * 「关于软件」分区（Eagle 偏好设置 →「关于」的位置）：
 * 版本与检查更新、运行环境、目录与诊断、帮助链接、开源组件。
 * 所有「本机事实」都来自主进程 app-info，前端不硬编码版本号，避免发版后忘记改。
 */
export default function AboutSection({ settings, patch, onToast, onOpenTutorial }: Props) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [up, setUp] = useState<UpdateState>(EMPTY_STATE);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  /** 网页兜底检查（开发态/浏览器预览）发现的发布页地址 */
  const [webUrl, setWebUrl] = useState('');

  useEffect(() => {
    getAppInfo().then(setInfo).catch(quiet);
    desktop?.getAutoLaunch?.().then(setAutoLaunch).catch(quiet);
    desktop?.updateState?.().then(setUp).catch(quiet);
    // 下载进度由主进程广播，这里只订阅，不做轮询
    return desktop?.onUpdateState?.((s) => setUp(s));
  }, []);

  const version = info?.version || '';
  const repo = info?.officialRepo || FALLBACK_REPO;
  const releasesUrl = `https://github.com/${repo}/releases`;
  const supported = !!up.supported;
  /** 只有安装版能就地升级；绿色版/开发态只能把人送到发布页 */
  const canSelfUpdate = supported;

  const check = async () => {
    setBusy(true);
    setMsg('');
    setWebUrl('');
    try {
      if (canSelfUpdate) {
        const r = await desktop?.updateCheck?.();
        if (!r?.ok) setMsg(r?.msg || '检查失败，请检查网络或代理设置');
        else if (!r.hasUpdate) setMsg(`已是最新版本 v${r.current}`);
        else setMsg(`发现新版本 v${r.latest}，可下载后一键重启安装`);
        return;
      }
      // 开发态 / 浏览器预览：只比对 GitHub 上的最新 tag，不下载
      if (!desktop?.checkForUpdates) {
        setMsg('浏览器预览模式不支持检查更新，请在安装版里使用');
        return;
      }
      const r = await desktop.checkForUpdates();
      if (!r?.ok) {
        setMsg(r?.msg || '检查失败，请检查网络或代理设置');
        return;
      }
      if (r.url) setWebUrl(r.url);
      if (r.hasUpdate) setMsg(`发现新版本 v${r.latest}（当前 v${r.current}），点下面的按钮到发布页下载`);
      else setMsg(`已是最新版本 v${r.current}`);
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    setBusy(true);
    try {
      const r = await desktop?.updateDownload?.();
      if (!r?.ok) setMsg(r?.msg || '开始下载失败');
      else onToast('已开始后台下载更新包，可以继续用');
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    const r = await desktop?.updateInstall?.();
    if (!r?.ok) setMsg(r?.msg || '安装失败，请稍后重试或到发布页手动下载');
  };

  /** 诊断信息：用户发给开发者时，版本/环境/路径一次说清，不用来回追问 */
  const copyDiagnostics = async () => {
    const text = [
      `应用：${APP_NAME} v${version || '?'}`,
      `安装形态：${info?.packaged ? '安装版' : '开发 / 绿色版'}`,
      `系统：${PLATFORM_LABEL[info?.platform || ''] || info?.platform || '?'} ${info?.arch || ''}`.trim(),
      `Electron ${info?.versions?.electron || '?'} / Chromium ${info?.versions?.chromium || '?'} / Node ${info?.versions?.node || '?'}`,
      `更新通道：${info?.updateChannel || 'release'}（${repo}）`,
      `数据目录：${info?.paths?.userData || '-'}`,
      `日志目录：${info?.paths?.logs || '-'}`,
      `崩溃转储：${info?.paths?.crashDumps || '-'}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      onToast('诊断信息已复制，可直接粘贴给开发者');
    } catch {
      onToast('复制失败，请手动选中下方文字复制', 'error');
    }
  };

  const openDir = async (key: 'userData' | 'logs' | 'crashDumps') => {
    if (!desktop?.openAppDir) {
      onToast('仅桌面端支持打开目录', 'error');
      return;
    }
    const err = await desktop.openAppDir(key);
    if (err) onToast(err, 'error');
  };

  return (
    <>
      <Card
        title="版本"
        desc="检查更新、看上一个大版本改了什么。安装版每次启动都会在后台静默查询，这期间可以照常使用；只有更新包下载完、能立刻安装时才会提示重启。"
      >
        <div className="about-hero">
          <div className="about-hero-mark">图库</div>
          <div className="about-hero-text">
            <div className="about-hero-name">
              {APP_NAME}
              <span className="about-hero-ver">{version ? `v${version}` : '浏览器预览'}</span>
            </div>
            <div className="hint" style={{ margin: 0 }}>
              本地优先的个人图库：采集、整理、检索、编辑、导出全在本机完成，不上传素材
            </div>
          </div>
        </div>

        <div className="about-actions">
          <button className="btn primary" disabled={busy || up.status === 'checking'} onClick={check}>
            {busy || up.status === 'checking' ? '检查中…' : '检查更新'}
          </button>
          {canSelfUpdate && up.status === 'available' && (
            <button className="btn" disabled={busy} onClick={download}>
              下载 v{up.version}
            </button>
          )}
          {canSelfUpdate && up.status === 'downloaded' && (
            <button className="btn primary" onClick={install}>
              重启并安装 v{up.version}
            </button>
          )}
          {!canSelfUpdate && webUrl && (
            <button className="btn" onClick={() => window.open(webUrl, '_blank', 'noopener')}>
              打开发布页下载
            </button>
          )}
          <button className="btn" onClick={() => window.open(releasesUrl, '_blank', 'noopener')}>
            更新日志
          </button>
        </div>

        {canSelfUpdate && up.status === 'downloading' && (
          <div style={{ marginTop: 10 }}>
            <div className="hint" style={{ margin: '0 0 4px' }}>
              正在下载 v{up.version}：{up.percent}%（可继续使用，不影响当前操作）
            </div>
            <progress value={up.percent} max={100} style={{ width: '100%', height: 8 }} />
          </div>
        )}
        {canSelfUpdate && up.status === 'downloaded' && (
          <div className="hint" style={{ marginTop: 8 }}>
            更新包已就绪：点「重启并安装」会关闭应用并自动完成升级，库数据与设置都会保留。
          </div>
        )}
        {canSelfUpdate && up.status === 'error' && up.error && (
          <div className="hint" style={{ marginTop: 8, color: 'var(--warn)' }}>
            更新失败：{up.error}
          </div>
        )}
        {!canSelfUpdate && (
          <div className="hint" style={{ marginTop: 8 }}>
            当前不是安装版（开发模式或绿色版），只能检查版本并到发布页手动下载；装好的安装版会在应用内直接升级。
          </div>
        )}
        {msg && <div className="hint" style={{ marginTop: 8 }}>{msg}</div>}
        {typeof up.installFailures === 'number' && up.installFailures > 0 && (
          <div className="hint" style={{ marginTop: 8, lineHeight: 1.9, color: 'var(--warn)' }}>
            已连续 {up.installFailures} 次安装失败：强制更新已自动降级为「可继续使用」，避免每次启动都被装不上的更新挡住。
            <button
              className="btn sm"
              style={{ marginLeft: 8 }}
              onClick={async () => {
                try {
                  await desktop?.updateResetFailures?.();
                  setUp({ ...up, installFailures: 0 });
                  onToast('已清零安装失败计数');
                } catch {
                  onToast('清零失败，请重启应用后再试', 'error');
                }
              }}
            >
              清零计数
            </button>
          </div>
        )}

        <div className="settings-subhead">启动</div>
        <div className="switch-row">
          <span>
            开机自动启动
            <span className="hint">　开机后直接进图库，不用再翻开始菜单</span>
          </span>
          <input
            type="checkbox"
            checked={autoLaunch}
            disabled={!desktop}
            title={desktop ? '' : '仅桌面端支持'}
            onChange={async (e) => {
              const next = e.target.checked;
              setAutoLaunch(next);
              try {
                const applied = (await desktop?.setAutoLaunch?.(next)) ?? next;
                setAutoLaunch(applied);
                patch({ autoLaunch: applied });
                onToast(applied ? '已开启开机自启' : '已关闭开机自启');
              } catch {
                setAutoLaunch(!next);
                onToast('设置开机自启失败，可能被系统策略拦截', 'error');
              }
            }}
          />
        </div>
        <div className="switch-row">
          <span>
            启动时自动检查更新
            <span className="hint">　关掉后只在点「检查更新」时才联网（改完点右上角保存）</span>
          </span>
          <input
            type="checkbox"
            checked={settings.autoUpdateCheck !== false}
            onChange={(e) => patch({ autoUpdateCheck: e.target.checked })}
          />
        </div>
      </Card>

      <Card title="运行环境" desc="反馈问题时把这几行一起发过来，能省掉大半来回确认。">
        <div className="about-grid">
          <Row label="应用版本" value={version ? `v${version}` : '—'} />
          <Row
            label="安装形态"
            value={info ? (info.packaged ? '安装版（支持应用内更新）' : '开发 / 绿色版') : '—'}
          />
          <Row
            label="系统"
            value={`${PLATFORM_LABEL[info?.platform || ''] || info?.platform || '—'}${info?.arch ? ` · ${info.arch}` : ''}`}
          />
          <Row label="Electron" value={info?.versions?.electron || '—'} mono />
          <Row label="Chromium" value={info?.versions?.chromium || '—'} mono />
          <Row label="Node.js" value={info?.versions?.node || '—'} mono />
          <Row label="V8" value={info?.versions?.v8 || '—'} mono />
          <Row label="更新通道" value={info?.updateChannel === 'release' ? '正式版（GitHub Releases）' : info?.updateChannel || '—'} />
        </div>
        {!info && (
          <div className="hint" style={{ marginTop: 8 }}>
            浏览器预览模式下读不到运行环境（这些数字来自桌面端主进程）。
          </div>
        )}
      </Card>

      <Card
        title="目录与诊断"
        desc="程序自己的数据、运行日志与崩溃转储都放在这里；素材本身在你设置的图片保存文件夹里，不在这里。"
      >
        <div className="about-paths">
          <div className="about-path">
            <div className="about-path-label">程序数据</div>
            <code>{info?.paths?.userData || '—'}</code>
            <button className="btn sm" disabled={!desktop} onClick={() => openDir('userData')}>
              打开
            </button>
          </div>
          <div className="about-path">
            <div className="about-path-label">运行日志</div>
            <code>{info?.paths?.logs || '—'}</code>
            <button className="btn sm" disabled={!desktop} onClick={() => openDir('logs')}>
              打开
            </button>
          </div>
          <div className="about-path">
            <div className="about-path-label">崩溃转储</div>
            <code>{info?.paths?.crashDumps || '—'}</code>
            <button className="btn sm" disabled={!desktop} onClick={() => openDir('crashDumps')}>
              打开
            </button>
          </div>
        </div>
        <div className="about-actions">
          <button className="btn" onClick={copyDiagnostics}>
            复制诊断信息
          </button>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          崩溃不会自动上报：出问题时在崩溃转储目录里取 dump 文件，连同诊断信息一起发出来即可。
        </div>
      </Card>

      <Card title="帮助与反馈" desc="遇到问题先查教程；确认是缺陷就到仓库提 issue，附上诊断信息会快很多。">
        <div className="about-actions">
          <button className="btn" onClick={onOpenTutorial}>
            使用教程（F1）
          </button>
          <button className="btn" onClick={() => window.open(`${releasesUrl}/latest`, '_blank', 'noopener')}>
            最新版本说明
          </button>
          <button className="btn" onClick={() => window.open(`https://github.com/${repo}/issues/new`, '_blank', 'noopener')}>
            报告问题
          </button>
          <button className="btn" onClick={() => window.open(`https://github.com/${repo}`, '_blank', 'noopener')}>
            源代码
          </button>
        </div>
        <div className="hint" style={{ marginTop: 8, lineHeight: 1.9 }}>
          · 界面卡住 / 白屏：先看「运行日志」，最近的报错在最末几行
          <br />· 缩略图转圈、图看不了：多为文件被移动或改名，「数据与维护 → 图库维护」里可清理失效记录后重新扫描
          <br />· 更新装不上：连续失败会自动降级为可继续使用，也可以到发布页手动下载安装包覆盖安装
        </div>
      </Card>

      <Card
        title="开源组件"
        desc="这个软件站在这些项目上。许可证以各自仓库为准，这里只列对功能有直接影响的主要组件。"
      >
        <div className="about-components">
          {COMPONENTS.map((c) => (
            <div className="about-component" key={c.name}>
              <div className="about-component-name">{c.name}</div>
              <div className="about-component-use">{c.use}</div>
              <div className="about-component-license">{c.license}</div>
            </div>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 10 }}>
          模型权重（中文 CLIP、人脸检测）来自各自上游项目，随插件包按需下载，不随安装包分发。
        </div>
      </Card>
    </>
  );
}
