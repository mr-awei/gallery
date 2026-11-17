import React, { useEffect, useState } from 'react';
import { desktop, getAppInfo, quiet } from '../../api';
import type { AppInfo, HotfixState, UpdateState } from '../../api';
import type { Settings as SettingsType } from '../../types';
import Card from './Card';
import i18n from '../../i18n';

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
const APP_NAME = i18n.t('k2e57064f');

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
  { name: 'Electron / Chromium', use: i18n.t('k99ca5e2b'), license: 'MIT / BSD-3-Clause' },
  { name: 'React 18', use: i18n.t('k7e5d2a58'), license: 'MIT' },
  { name: 'Express 5', use: i18n.t('k67b2555f'), license: 'MIT' },
  { name: 'SQLite（node:sqlite）', use: i18n.t('k5550585c'), license: 'Public Domain' },
  { name: 'sharp / libvips', use: i18n.t('k727a42e4'), license: 'Apache-2.0 / LGPL-3.0+' },
  { name: 'libheif-js', use: i18n.t('kf8d9116c'), license: 'LGPL-3.0' },
  { name: '@huggingface/transformers', use: i18n.t('k1320addd'), license: 'Apache-2.0' },
  { name: 'ONNX Runtime（WASM）', use: i18n.t('k934ffa8c'), license: 'MIT' },
  { name: 'three.js', use: i18n.t('k289c0fd3'), license: 'MIT' },
  { name: 'JSZip / SheetJS / mammoth / @webtoon/psd', use: i18n.t('kf251e035'), license: 'MIT / Apache-2.0 / BSD-2-Clause' },
  { name: 'electron-updater', use: i18n.t('kafd2a275'), license: 'MIT' },
  { name: 'Vite 7', use: i18n.t('k9d4cb5d5'), license: 'MIT' },
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
  /** 热更状态：反映本机事实（生效序号 / 待生效序号 / 是否停用） */
  const [hot, setHot] = useState<HotfixState | null>(null);
  const [hotBusy, setHotBusy] = useState(false);
  const [hotMsg, setHotMsg] = useState('');

  useEffect(() => {
    getAppInfo().then(setInfo).catch(quiet);
    desktop?.getAutoLaunch?.().then(setAutoLaunch).catch(quiet);
    desktop?.updateState?.().then(setUp).catch(quiet);
    desktop?.hotfixState?.().then(setHot).catch(quiet);
    // 下载进度由主进程广播，这里只订阅，不做轮询
    return desktop?.onUpdateState?.((s) => setUp(s));
  }, []);

  const version = info?.version || '';
  const repo = info?.officialRepo || FALLBACK_REPO;
  const releasesUrl = `https://github.com/${repo}/releases`;
  const supported = !!up.supported;
  /** 只有安装版能就地升级；绿色版/开发态只能把人送到发布页 */
  const canSelfUpdate = supported;

  const applyMode = settings.hotfixApply || 'next';
  const applyLabel = applyMode === 'now' ? i18n.t('kdd3312ed') : applyMode === 'manual' ? i18n.t('k50b126e9') : i18n.t('kff5d3ddd');

  const refreshHot = () => desktop?.hotfixState?.().then(setHot).catch(quiet);

  const checkHotfix = async () => {
    setHotBusy(true);
    setHotMsg('');
    try {
      const r = await desktop?.hotfixCheck?.();
      if (!r) setHotMsg(i18n.t('k6d5d45e6'));
      else if (!r.ok) setHotMsg(r.error || i18n.t('k7620acaa'));
      else setHotMsg(i18n.t('ke617ba7e', { p0: r.seq, p1: r.notes ? `：${r.notes}` : '', p2: applyLabel }));
      await refreshHot();
    } finally {
      setHotBusy(false);
    }
  };

  const applyHotfix = async () => {
    setHotBusy(true);
    setHotMsg(i18n.t('k8468d21a'));
    try {
      const r = await desktop?.hotfixApply?.();
      // 成功时主进程会重载所有窗口，这里的提示只是刷新失败时的兜底
      setHotMsg(r?.applied ? i18n.t('k417529b9', { p0: r.seq }) : r?.error || i18n.t('kd0c8a173'));
      await refreshHot();
    } finally {
      setHotBusy(false);
    }
  };

  const importHotfix = async () => {
    setHotBusy(true);
    setHotMsg('');
    try {
      const r = await desktop?.hotfixImport?.();
      if (r?.ok) setHotMsg(i18n.t('k493bfda2', { p0: r.seq, p1: r.notes ? `：${r.notes}` : '', p2: applyLabel }));
      else setHotMsg(r?.error || i18n.t('kfddcd7c6'));
      await refreshHot();
    } finally {
      setHotBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    setMsg('');
    setWebUrl('');
    try {
      if (canSelfUpdate) {
        const r = await desktop?.updateCheck?.();
        if (!r?.ok) setMsg(r?.msg || i18n.t('k7620acaa'));
        else if (!r.hasUpdate) setMsg(i18n.t('k49e4f46d', { p0: r.current }));
        else setMsg(i18n.t('kb2e90acc', { p0: r.latest }));
        return;
      }
      // 开发态 / 浏览器预览：只比对 GitHub 上的最新 tag，不下载
      if (!desktop?.checkForUpdates) {
        setMsg(i18n.t('kfe5a7b55'));
        return;
      }
      const r = await desktop.checkForUpdates();
      if (!r?.ok) {
        setMsg(r?.msg || i18n.t('k7620acaa'));
        return;
      }
      if (r.url) setWebUrl(r.url);
      if (r.hasUpdate)
        setMsg(
          i18n.t('k101343db', { p0: r.latest, p1: r.current }),
        );
      else setMsg(i18n.t('k49e4f46d', { p0: r.current }));
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    setBusy(true);
    try {
      const r = await desktop?.updateDownload?.();
      if (!r?.ok) setMsg(r?.msg || i18n.t('kdd26574f'));
      else onToast(i18n.t('k4c654082'));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    const r = await desktop?.updateInstall?.();
    if (!r?.ok) setMsg(r?.msg || i18n.t('k3bdcb2ee'));
  };

  /** 诊断信息：用户发给开发者时，版本/环境/路径一次说清，不用来回追问 */
  const copyDiagnostics = async () => {
    const text = [
      i18n.t('k2472ef95', { p0: APP_NAME, p1: version || '?' }),
      i18n.t('k45e4c01b', { p0: info?.packaged ? i18n.t('k57b2b95e') : i18n.t('ke6f1361d') }),
      i18n.t('k2ba85bdc', { p0: PLATFORM_LABEL[info?.platform || ''] || info?.platform || '?', p1: info?.arch || '' }).trim(),
      `Electron ${info?.versions?.electron || '?'} / Chromium ${info?.versions?.chromium || '?'} / Node ${info?.versions?.node || '?'}`,
      i18n.t('kf7e8bb51', { p0: info?.updateChannel || 'release', p1: repo }),
      i18n.t('k3f485aa9', { p0: info?.paths?.userData || '-' }),
      i18n.t('k0a0fc1a8', { p0: info?.paths?.logs || '-' }),
      i18n.t('ka7c7059d', { p0: info?.paths?.crashDumps || '-' }),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      onToast(i18n.t('k2f3ef2b7'));
    } catch {
      onToast(i18n.t('k12263b09'), 'error');
    }
  };

  const openDir = async (key: 'userData' | 'logs' | 'crashDumps') => {
    if (!desktop?.openAppDir) {
      onToast(i18n.t('k63508a02'), 'error');
      return;
    }
    const err = await desktop.openAppDir(key);
    if (err) onToast(err, 'error');
  };

  return (
    <>
      <Card
        title={i18n.t('kfe2df04a')}
        desc={i18n.t('k93fee306')}
      >
        <div className="about-hero">
          <div className="about-hero-mark">{i18n.t('k6084bc4b')}</div>
          <div className="about-hero-text">
            <div className="about-hero-name">
              {APP_NAME}
              <span className="about-hero-ver">{version ? `v${version}` : i18n.t('ka03c37a0')}</span>
            </div>
            <div className="hint" style={{ margin: 0 }}>
              {i18n.t('k625585d2')}
            </div>
          </div>
        </div>

        <div className="about-actions">
          <button className="btn primary" disabled={busy || up.status === 'checking'} onClick={check}>
            {busy || up.status === 'checking' ? i18n.t('kd6a22312') : i18n.t('k4ff13370')}
          </button>
          {canSelfUpdate && up.status === 'available' && (
            <button className="btn" disabled={busy} onClick={download}>
              {i18n.t('k1c036f90', { p0: up.version })}
            </button>
          )}
          {canSelfUpdate && up.status === 'downloaded' && (
            <button className="btn primary" onClick={install}>
              {i18n.t('k3d690e80', { p0: up.version })}
            </button>
          )}
          {!canSelfUpdate && webUrl && (
            <button className="btn" onClick={() => window.open(webUrl, '_blank', 'noopener')}>
              {i18n.t('kef532ca9')}
            </button>
          )}
          <button className="btn" onClick={() => window.open(releasesUrl, '_blank', 'noopener')}>
            {i18n.t('k23093bb2')}
          </button>
        </div>

        {canSelfUpdate && up.status === 'downloading' && (
          <div style={{ marginTop: 10 }}>
            <div className="hint" style={{ margin: '0 0 4px' }}>
              {i18n.t('kd365fc19', { p0: up.version, p1: up.percent })}
            </div>
            <progress value={up.percent} max={100} style={{ width: '100%', height: 8 }} />
          </div>
        )}
        {canSelfUpdate && up.status === 'downloaded' && (
          <div className="hint" style={{ marginTop: 8 }}>
            {i18n.t('kdafa99fb')}
          </div>
        )}
        {canSelfUpdate && up.status === 'error' && up.error && (
          <div className="hint" style={{ marginTop: 8, color: 'var(--warn)' }}>
            {i18n.t('k87ef41fc')}
            {up.error}
          </div>
        )}
        {!canSelfUpdate && (
          <div className="hint" style={{ marginTop: 8 }}>
            {i18n.t('k073af007')}
          </div>
        )}
        {msg && <div className="hint" style={{ marginTop: 8 }}>{msg}</div>}
        {typeof up.installFailures === 'number' && up.installFailures > 0 && (
          <div className="hint" style={{ marginTop: 8, lineHeight: 1.9, color: 'var(--warn)' }}>
            {i18n.t('k338dd681', { p0: up.installFailures })}
            <button
              className="btn sm"
              style={{ marginLeft: 8 }}
              onClick={async () => {
                try {
                  await desktop?.updateResetFailures?.();
                  setUp({ ...up, installFailures: 0 });
                  onToast(i18n.t('k96f2bfab'));
                } catch {
                  onToast(i18n.t('kf7674bfc'), 'error');
                }
              }}
            >
              {i18n.t('kaf8335bc')}
            </button>
          </div>
        )}

        <div className="settings-subhead">{i18n.t('k8e54ddfe')}</div>
        <div className="switch-row">
          <span>
            {i18n.t('ka8ca7568')}
            <span className="hint">　{i18n.t('kdc5456bc')}</span>
          </span>
          <input
            type="checkbox"
            checked={autoLaunch}
            disabled={!desktop}
            title={desktop ? '' : i18n.t('kc8d639f3')}
            onChange={async (e) => {
              const next = e.target.checked;
              setAutoLaunch(next);
              try {
                const applied = (await desktop?.setAutoLaunch?.(next)) ?? next;
                setAutoLaunch(applied);
                patch({ autoLaunch: applied });
                onToast(applied ? i18n.t('kf6c535fd') : i18n.t('k9a351c5a'));
              } catch {
                setAutoLaunch(!next);
                onToast(i18n.t('kab15ab80'), 'error');
              }
            }}
          />
        </div>
        <div className="switch-row">
          <span>
            {i18n.t('ka2f7c6d7')}
            <span className="hint">
              　{i18n.t('k11a2aa66')}
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.autoUpdateCheck !== false}
            onChange={(e) => patch({ autoUpdateCheck: e.target.checked })}
          />
        </div>
        <div className="switch-row">
          <span>
            {i18n.t('k0bd43333')}
            <span className="hint">　{i18n.t('kc8615791')}</span>
          </span>
          <select
            className="input"
            style={{ flex: '0 0 auto', minWidth: 150 }}
            value={settings.hotfixApply || 'next'}
            onChange={(e) => patch({ hotfixApply: e.target.value as 'next' | 'now' | 'manual' })}
            aria-label={i18n.t('k0bd43333')}
          >
            <option value="next">{i18n.t('kff5d3ddd')}</option>
            <option value="now">{i18n.t('kdd3312ed')}</option>
            <option value="manual">{i18n.t('k50b126e9')}</option>
          </select>
        </div>
      </Card>

      <Card
        title={i18n.t('k5a07e4e1')}
        desc={
          i18n.t('keb714d6e') +
          i18n.t('k2d5a673b')
        }
      >
        <div className="about-grid">
          <Row
            label={i18n.t('k4298a6d6')}
            value={
              !hot
                ? '—'
                : hot.activeSeq
                  ? i18n.t('kd5406e69', { p0: version ? `v${version}` : '', p1: hot.activeSeq })
                  : i18n.t('k5c3b2b3c', { p0: version ? `v${version}` : '' })
            }
          />
          <Row
            label={i18n.t('k438aa860')}
            value={hot?.pendingSeq ? `#${hot.pendingSeq}${hot.pendingNotes ? ` · ${hot.pendingNotes}` : ''}` : i18n.t('kd81bb206')}
          />
          <Row label={i18n.t('k5a2b4de3')} value={!hot?.enabled ? i18n.t('k69351d53') : applyLabel} />
        </div>
        <div className="about-actions">
          <button className="btn" onClick={checkHotfix} disabled={hotBusy || !hot?.enabled}>
            {i18n.t('k2ce4d684')}
          </button>
          <button
            className="btn primary"
            onClick={applyHotfix}
            disabled={hotBusy || !hot?.pendingSeq}
            title={hot?.pendingSeq ? i18n.t('k0d9f3334') : i18n.t('kd0c8a173')}
          >
            {i18n.t('k634872c7')}
          </button>
          <button className="btn" onClick={importHotfix} disabled={hotBusy || !hot?.enabled}>
            {i18n.t('kb3e75599')}
          </button>
        </div>
        {hotMsg ? <div className="hint" style={{ marginTop: 8 }}>{hotMsg}</div> : null}
      </Card>

      <Card
        title={i18n.t('k158744a8')}
        desc={i18n.t('k8efcd781')}
      >
        <div className="about-grid">
          <Row label={i18n.t('k7c46d9d1')} value={version ? `v${version}` : '—'} />
          <Row
            label={i18n.t('k3a91c7d2')}
            value={info ? (info.packaged ? i18n.t('k5b7465ca') : i18n.t('ke6f1361d')) : '—'}
          />
          <Row
            label={i18n.t('k8a8b895f')}
            value={`${PLATFORM_LABEL[info?.platform || ''] || info?.platform || '—'}${info?.arch ? ` · ${info.arch}` : ''}`}
          />
          <Row label="Electron" value={info?.versions?.electron || '—'} mono />
          <Row label="Chromium" value={info?.versions?.chromium || '—'} mono />
          <Row label="Node.js" value={info?.versions?.node || '—'} mono />
          <Row label="V8" value={info?.versions?.v8 || '—'} mono />
          <Row
            label={i18n.t('kcae049cb')}
            value={info?.updateChannel === 'release' ? i18n.t('k9fff2087') : info?.updateChannel || '—'}
          />
        </div>
        {!info && (
          <div className="hint" style={{ marginTop: 8 }}>
            {i18n.t('k48b3d06a')}
          </div>
        )}
      </Card>

      <Card
        title={i18n.t('k325fdeb4')}
        desc={i18n.t('k9a437663')}
      >
        <div className="about-paths">
          <div className="about-path">
            <div className="about-path-label">{i18n.t('kbed1b262')}</div>
            <code>{info?.paths?.userData || '—'}</code>
            <button className="btn sm" disabled={!desktop} onClick={() => openDir('userData')}>
              {i18n.t('kd7098f50')}
            </button>
          </div>
          <div className="about-path">
            <div className="about-path-label">{i18n.t('k284a98fa')}</div>
            <code>{info?.paths?.logs || '—'}</code>
            <button className="btn sm" disabled={!desktop} onClick={() => openDir('logs')}>
              {i18n.t('kd7098f50')}
            </button>
          </div>
          <div className="about-path">
            <div className="about-path-label">{i18n.t('k6b3551c1')}</div>
            <code>{info?.paths?.crashDumps || '—'}</code>
            <button className="btn sm" disabled={!desktop} onClick={() => openDir('crashDumps')}>
              {i18n.t('kd7098f50')}
            </button>
          </div>
        </div>
        <div className="about-actions">
          <button className="btn" onClick={copyDiagnostics}>
            {i18n.t('ka5b98f67')}
          </button>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          {i18n.t('k4c45e133')}
        </div>
      </Card>

      <Card
        title={i18n.t('k3f3663e9')}
        desc={i18n.t('kfe250666')}
      >
        <div className="about-actions">
          <button className="btn" onClick={onOpenTutorial}>
            {i18n.t('k86e19b14')}
          </button>
          <button className="btn" onClick={() => window.open(`${releasesUrl}/latest`, '_blank', 'noopener')}>
            {i18n.t('ke542dfa6')}
          </button>
          <button className="btn" onClick={() => window.open(`https://github.com/${repo}/issues/new`, '_blank', 'noopener')}>
            {i18n.t('kfd05265a')}
          </button>
          <button className="btn" onClick={() => window.open(`https://github.com/${repo}`, '_blank', 'noopener')}>
            {i18n.t('k81cb1f5d')}
          </button>
        </div>
        <div className="hint" style={{ marginTop: 8, lineHeight: 1.9 }}>
          {i18n.t('kde39a3b9')}
          <br />
          {i18n.t('k5eb66a97')}
          <br />
          {i18n.t('ke5df43d0')}
        </div>
      </Card>

      <Card
        title={i18n.t('k843d86af')}
        desc={i18n.t('kc2d464ce')}
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
          {i18n.t('kc2558fb3')}
        </div>
      </Card>
    </>
  );
}
