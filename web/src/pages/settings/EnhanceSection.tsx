import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatSize, quiet } from '../../api';
import { subscribeEvents } from '../../events';
import type {
  AiUpscaleStatus,
  EnhanceAiModel,
  EnhanceModel,
  EnhanceRemoteService,
  HardwareReport,
  Settings as SettingsType,
} from '../../types';
import { loadHardware, refreshHardware } from '../../lib/hardware';
import { IconTrash } from '../../components/Icons';
import Select from '../../components/Select';
import Card from './Card';
import i18n from '../../i18n';

interface Props {
  settings: SettingsType;
  patch: (p: Partial<SettingsType>) => void;
  onToast: (m: string, kind?: 'info' | 'error') => void;
}

/** 常用免费线上增强服务预设（一键添加后可自行微调，再用「测试服务」验证） */
const REMOTE_PRESETS: {
  key: string;
  name: string;
  tag: string;
  desc: string;
  service: Omit<EnhanceRemoteService, 'id'>;
}[] = [
  {
    key: 'hf-swin2sr',
    name: i18n.t('k85372d4a'),
    tag: i18n.t('ke6ac331c'),
    desc: i18n.t('k73c181f9'),
    service: {
      name: 'HuggingFace Swin2SR ×4',
      uploadUrl: 'https://api-inference.huggingface.co/models/caidas/swin2SR-realworld-sr-x4-64-bsrgan-psnr',
      method: 'POST',
      bodyMode: 'binary',
      fileField: 'file',
      headers: [{ key: 'Authorization', value: i18n.t('k136cef2b') }],
      resultType: 'direct',
      resultUrlPath: '',
      params: [],
      apiKey: '',
    },
  },
  {
    key: 'deepai',
    name: i18n.t('k31b53c58'),
    tag: i18n.t('k1d9b4a7a'),
    desc: i18n.t('kdab6a681'),
    service: {
      name: i18n.t('kf4bc1d4a'),
      uploadUrl: 'https://api.deepai.org/api/torch-srgan',
      method: 'POST',
      bodyMode: 'multipart',
      fileField: 'image',
      headers: [{ key: 'api-key', value: i18n.t('k063e5bc7') }],
      resultType: 'json',
      resultUrlPath: 'output_url',
      params: [],
      apiKey: '',
    },
  },
  {
    key: 'deepai-waifu2x',
    name: i18n.t('kbf938d41'),
    tag: i18n.t('k1d9b4a7a'),
    desc: i18n.t('k53a13df5'),
    service: {
      name: 'DeepAI waifu2x',
      uploadUrl: 'https://api.deepai.org/api/waifu2x',
      method: 'POST',
      bodyMode: 'multipart',
      fileField: 'image',
      headers: [{ key: 'api-key', value: i18n.t('k063e5bc7') }],
      resultType: 'json',
      resultUrlPath: 'output_url',
      params: [],
      apiKey: '',
    },
  },
  {
    key: 'selfhost',
    name: i18n.t('k07de3520'),
    tag: i18n.t('k737a9bd9'),
    desc: i18n.t('k648d94d0'),
    service: {
      name: i18n.t('k2a0d7027'),
      uploadUrl: 'http://127.0.0.1:8000/upscale',
      method: 'POST',
      bodyMode: 'multipart',
      fileField: 'file',
      headers: [],
      resultType: 'direct',
      resultUrlPath: '',
      params: [],
      apiKey: '',
    },
  },
];

  /** 偏好模型特征名 → 中文（便于看懂模型学到了什么） */
  const featureLabel = (f: string) => {
    const [kind, value] = f.split(':');
    const map: Record<string, string> = {
      src: i18n.t('k26ca20b1'),
      kw: i18n.t('k9699a50e'),
      bucket: i18n.t('k7bb16c5d'),
      orient: i18n.t('ka465db53'),
      hue: i18n.t('k672c88b9'),
      bright: i18n.t('k01feca0e'),
      sharp: i18n.t('k0a4afe98'),
      term: i18n.t('k8801870e'),
    };
    const v: Record<string, string> = {
      sd: i18n.t('kba5d85c3'), fhd: '1080P', '2k': '2K', '4k': '4K',
      portrait: i18n.t('k1d4b5f79'), landscape: i18n.t('kaffd00f2'), square: i18n.t('k5c036336'), gray: i18n.t('k4b90efb3'),
    };
    return `${map[kind] || kind}·${v[value] ?? value}`;
  };

export default function EnhanceSection({ settings, patch, onToast }: Props) {
  const [enhanceModels, setEnhanceModels] = useState<{
    builtin: EnhanceModel[];
    remote: EnhanceRemoteService[];
    ai?: EnhanceAiModel[];
  }>({
    builtin: [],
    remote: [],
    ai: [],
  });
  const [aiUp, setAiUp] = useState<AiUpscaleStatus | null>(null);
  // 第二档：Transformer 超分（Swin2SR）模型状态
  const [sr, setSr] = useState<Awaited<ReturnType<typeof api.aiSrStatus>> | null>(null);
  // 本地偏好模型状态
  const [pref, setPref] = useState<Awaited<ReturnType<typeof api.prefStatus>> | null>(null);
  // AI 去背景模型状态
  const [matting, setMatting] = useState<Awaited<ReturnType<typeof api.mattingStatus>> | null>(null);
  const [remoteTest, setRemoteTest] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [remoteTesting, setRemoteTesting] = useState<string>('');
  // 本机硬件 + 各模型功能的最低配置判定（服务端 /api/hardware）
  const [hw, setHw] = useState<HardwareReport | null>(null);
  const [hwBusy, setHwBusy] = useState(false);

  // 模型列表读不到时，下拉框会变成空的，用户只会觉得「增强功能没了」——得说清原因
  const [modelsErr, setModelsErr] = useState('');

  /** 装完模型/运行库后刷新列表：失败要提示，否则新模型不会出现在下拉里 */
  const reloadModels = useCallback(() => {
    api
      .enhanceModels()
      .then((m) => {
        setEnhanceModels(m);
        setModelsErr('');
      })
      .catch((err) => {
        const msg = (err as Error).message;
        setModelsErr(msg);
        onToast(i18n.t('kb13fdbdb', { p0: msg }), 'error');
      });
  }, [onToast]);

  // 初始加载（原样迁自父组件）
  useEffect(() => {
    api
      .enhanceModels()
      .then((m) => {
        setEnhanceModels(m);
        setModelsErr('');
      })
      .catch((err) => setModelsErr((err as Error).message));
    api.aiUpscaleStatus().then(setAiUp).catch(quiet);
    api.aiSrStatus().then(setSr).catch(quiet);
    api.prefStatus().then(setPref).catch(quiet);
    api.mattingStatus().then(setMatting).catch(quiet);
    // 硬件探测要起一次 PowerShell，读不到就留空（界面显示「读取失败」，不影响其它设置）
    loadHardware().then(setHw).catch(quiet);
  }, []);

  // 下载进度推送（sr / AI 超分运行库）→ 订阅 job 事件（原样迁自父组件）
  const srLoadingRef = useRef(false);
  srLoadingRef.current = !!sr?.loading;
  const aiUpDownloadingRef = useRef(false);
  aiUpDownloadingRef.current = !!aiUp?.downloading;
  const mattingDownloadingRef = useRef(false);
  mattingDownloadingRef.current = !!matting?.downloading;

  useEffect(() => {
    const off = subscribeEvents('job', (d) => {
      try {
        // 去背景模型下载进度已并入 job 快照（服务端运行期 5s 心跳推一帧），
        // 不再每 1s 打一次 mattingStatus 接口
        if (d?.matting) {
          const st = d.matting;
          setMatting(st);
          // 以前失败只写进状态里不弹提示，用户只看到按钮回到「未下载」，不知道败在哪
          if (mattingDownloadingRef.current && !st.downloading) {
            if (st.error) onToast(i18n.t('ka9752541', { p0: st.error }), 'error');
            else onToast(st.message || i18n.t('k912dde57'));
          }
          mattingDownloadingRef.current = !!st.downloading;
        }
        if (d?.sr) {
          const st = d.sr;
          setSr(st);
          if (srLoadingRef.current && !st.loading) {
            onToast(st.error ? i18n.t('k00a1ea19', { p0: st.error }) : i18n.t('k56c38b88'));
            reloadModels();
          }
          srLoadingRef.current = !!st.loading;
        }
        if (d?.aiUp) {
          const st = d.aiUp;
          setAiUp(st);
          if (aiUpDownloadingRef.current && !st.downloading) {
            // 运行库 / Real-CUGAN / 社区模型三类安装都走这里收尾；结果带在 message/installError 里
            if (st.installError) onToast(i18n.t('k55e6a828', { p0: st.installError }), 'error');
            else onToast(st.message || i18n.t('k8bd39e4e'));
            reloadModels();
          }
          aiUpDownloadingRef.current = !!st.downloading;
        }
      } catch {
        /* ignore */
      }
    });
    return () => {
      off();
    };
  }, [onToast, reloadModels]);

  return (
  <Card
    title={i18n.t('kfd5e4c21')}
    desc={i18n.t('kd27ed140')}
  >
    <div className="field">
      <label>{i18n.t('kf0c69797')}</label>
      <Select
        className="select"
        style={{ width: '100%' }}
        value={settings.enhance?.standard || '1080p'}
        onChange={(v) => patch({ enhance: { ...settings.enhance, standard: v } })}
      >
        <option value="480p">480P（854×480）</option>
        <option value="720p">720P（1280×720）</option>
        <option value="1080p">1080P（1920×1080）</option>
        <option value="2k">2K（2560×1440）</option>
        <option value="4k">4K（3840×2160）</option>
        <option value="custom">{i18n.t('k27de3745')}</option>
      </Select>
    </div>
    {settings.enhance?.standard === 'custom' && (
      <div style={{ display: 'flex', gap: 8, marginTop: -4 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>{i18n.t('k4a8aa103')}</label>
          <input
            className="input"
            type="number"
            value={settings.enhance?.customWidth ?? 1920}
            onChange={(e) => patch({ enhance: { ...settings.enhance, customWidth: Number(e.target.value) || 0 } })}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>{i18n.t('k63be317b')}</label>
          <input
            className="input"
            type="number"
            value={settings.enhance?.customHeight ?? 1080}
            onChange={(e) => patch({ enhance: { ...settings.enhance, customHeight: Number(e.target.value) || 0 } })}
          />
        </div>
      </div>
    )}
    <div className="field">
      <label>{i18n.t('kc6dccaeb')}</label>
      <Select
        className="select"
        style={{ width: '100%' }}
        value={settings.enhance?.model || 'sharp-standard'}
        onChange={(v) => patch({ enhance: { ...settings.enhance, model: v } })}
      >
        <optgroup label={i18n.t('ka86133b1')}>
          {(enhanceModels.builtin || []).map((m: EnhanceModel) => (
            <option key={m.id} value={m.id}>
              {m.label} · {m.desc}
            </option>
          ))}
        </optgroup>
        {(enhanceModels.ai || []).length > 0 && (
          <optgroup label={i18n.t('k2444b1fb')}>
            {(enhanceModels.ai || []).map((m: EnhanceAiModel) => (
              <option key={m.id} value={m.id} disabled={!m.available}>
                {m.label}
                {m.available ? '' : i18n.t('k6e8eee75')}
              </option>
            ))}
          </optgroup>
        )}
        {(enhanceModels.remote || []).length > 0 && (
          <optgroup label={i18n.t('k9ec2b4af')}>
            {(enhanceModels.remote || []).map((r: EnhanceRemoteService) => (
              <option key={r.id} value={`remote:${r.id}`}>
                {r.name}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
      <div className="hint">
        {i18n.t('ke617c0ed')}
      </div>
      {modelsErr && (
        <div className="hint" style={{ color: 'var(--err, #e5484d)' }}>
          模型列表读取失败：{modelsErr}
          <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={reloadModels}>
            {i18n.t('k132c5cdc')}
          </button>
        </div>
      )}
    </div>

    <div className="settings-subtitle">{i18n.t('k2444b1fb')}</div>
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 12,
        marginBottom: 14,
        background: 'var(--panel)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>
          {aiUp?.installed
            ? aiUp.usable === false
              ? i18n.t('kcf1894c3')
              : i18n.t('kfaf2c8d0')
            : i18n.t('kb5f8b643')}
        </b>
        {aiUp?.installed && aiUp.gpu && (
          <span className="tag-pill ok">AI 加速：{aiUp.gpu}</span>
        )}
        <span className="hint" style={{ marginLeft: 'auto' }}>
          {i18n.t('kdfc8fad9')}
        </span>
      </div>

      {aiUp?.downloading && (
        <>
          {aiUp.progress >= 0 && (
            <div className="enh-progress" style={{ marginTop: 10 }}>
              <div style={{ width: `${aiUp.progress}%` }} />
            </div>
          )}
          <div className="hint" style={{ marginTop: 6 }}>{aiUp.message}</div>
        </>
      )}

      {aiUp?.usable === false && aiUp.error && (
        <div className="ai-result" style={{ marginTop: 8, borderColor: 'rgba(248,113,113,0.4)' }}>
          {aiUp.error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button
          className="btn primary"
          disabled={!!aiUp?.downloading}
          onClick={async () => {
            try {
              await api.aiUpscaleInstall();
              setAiUp(await api.aiUpscaleStatus());
              onToast(i18n.t('kc4d33324'));
            } catch (err) {
              onToast((err as Error).message, 'error');
            }
          }}
        >
          {aiUp?.downloading
            ? aiUp.progress >= 0
              ? i18n.t('ke8ffc780', { p0: aiUp.progress })
              : i18n.t('k0164eeb4')
            : aiUp?.installed
              ? i18n.t('kd17a2434')
              : i18n.t('k13020716')}
        </button>
        <button
          className="btn"
          disabled={!aiUp?.installed}
          onClick={async () => {
            try {
              const r = await api.aiUpscaleSelfTest();
              setAiUp(await api.aiUpscaleStatus());
              onToast(r.gpu ? i18n.t('k37c12d48', { p0: r.gpu }) : i18n.t('k5b6a6f12', { p0: r.error }));
            } catch (err) {
              onToast((err as Error).message, 'error');
            }
          }}
        >
          {i18n.t('kf515f8fb')}
        </button>
      </div>

      <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
        {i18n.t('k0ca4c694')}
        <br />　{i18n.t('kd0864cb4')}
        <br />{i18n.t('kc305226e')}
        <br />{i18n.t('kd07d720c')}
      </div>

      {/* 社区模型（真人照片效果更好）+ Real-CUGAN（两级降噪放大） */}
      <div className="settings-subtitle" style={{ marginTop: 14 }}>
        {i18n.t('k470ebbe4')}
      </div>
      <div className="hint" style={{ marginBottom: 8, lineHeight: 1.9 }}>
        {i18n.t('kbbcf3e36')}
        <br />{i18n.t('k4ca1d6da')}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        {(aiUp?.community || []).map((m: { id: string; label: string; desc: string; installed: boolean }) => (
          <button
            key={m.id}
            className={`btn sm${m.installed ? '' : ' primary'}`}
            disabled={!aiUp?.installed || !!aiUp?.downloading}
            onClick={async () => {
              try {
                // 后台下载：接口立刻返回，进度/结果靠下方进度条与 job 心跳（以前同步等下载，按钮毫无反馈）
                setAiUp(await api.aiUpscaleInstallModel(m.id));
                onToast(i18n.t('kd321da29', { p0: m.label }));
              } catch (err) {
                onToast((err as Error).message, 'error');
              }
            }}
            title={m.desc}
          >
            {m.installed ? '✓ ' : aiUp?.downloading ? '… ' : '↓ '}
            {m.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className={`btn sm${aiUp?.cugan?.installed ? '' : ' primary'}`}
          disabled={!!aiUp?.downloading}
          onClick={async () => {
            try {
              // 后台下载：立刻返回，下载 / 解压 / 自检各阶段进度走 job 心跳
              setAiUp(await api.aiUpscaleInstallCugan());
              onToast(i18n.t('k5ff18233'));
            } catch (err) {
              onToast((err as Error).message, 'error');
            }
          }}
        >
          {aiUp?.downloading
            ? aiUp.progress >= 0
              ? i18n.t('ke8ffc780', { p0: aiUp.progress })
              : i18n.t('k0164eeb4')
            : aiUp?.cugan?.installed
              ? i18n.t('kdf8bd133')
              : i18n.t('k0f2f113b')}
        </button>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {aiUp?.cugan?.installed
            ? i18n.t('kab2075f3', { p0: (aiUp.cugan.models || []).length })
            : i18n.t('k028a624d')}
          </span>
          </div>

          {/* AI 去背景 */}
      <div className="settings-subtitle" style={{ marginTop: 14 }}>
        {i18n.t('k83bcedb8')}
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>
        按质量自动选档：装了旗舰档（BEN2，1024px）就用它，其次精细档（BiRefNet lite），都没有才用轻量档（U-2-Net，320px）。
        发丝、绒毛、玻璃与半透明边缘，旗舰 / 精细档明显更干净（代价是 CPU 单张几秒）；
        <strong>{i18n.t('k4136ffa7')}</strong>{i18n.t('k1374cb80')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(matting?.profiles || []).map((p) => {
          const isThis = matting?.downloading && matting?.installing === p.id;
          return (
            <div
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                border: '1px solid var(--border, #e6e8eb)',
                borderRadius: 6,
                padding: '6px 10px',
              }}
            >
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{p.label}</span>
              {p.active && matting?.downloaded && (
                <span
                  style={{
                    fontSize: 10.5,
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: 'rgba(37,99,235,.1)',
                    color: '#2563eb',
                  }}
                >
                  {i18n.t('kbe4cd65b')}
                </span>
              )}
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {p.installed ? i18n.t('kef33d77f', { p0: Math.round(p.size / 1024 / 1024) }) : i18n.t('kc306a498', { p0: Math.round(p.sizeHint / 1024 / 1024) })}
              </span>
              <button
                className={`btn sm${p.installed ? '' : ' primary'}`}
                disabled={!!matting?.downloading}
                style={{ marginLeft: 'auto' }}
                onClick={async () => {
                  try {
                    // 后台下载：接口立刻返回，进度靠 SSE / 轮询（以前这个请求要等整包下完）
                    await api.mattingInstall(p.id);
                    setMatting(await api.mattingStatus());
                    onToast(i18n.t('k4e516b04', { p0: p.label }));
                  } catch (err) {
                    onToast((err as Error).message, 'error');
                  }
                }}
              >
                {isThis ? i18n.t('ke8ffc780', { p0: matting?.progress }) : p.installed ? i18n.t('k754569be') : i18n.t('kf26ef914')}
              </button>
              {isThis && (
                <button
                  className="btn sm"
                  onClick={async () => {
                    try {
                      await api.mattingCancel();
                      onToast(i18n.t('k8b228e0b'));
                      setMatting(await api.mattingStatus());
                    } catch (err) {
                      onToast((err as Error).message, 'error');
                    }
                  }}
                >
                  {i18n.t('k625fb26b')}
                </button>
              )}
            </div>
          );
        })}
        {!matting?.profiles?.length && (
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            {i18n.t('kc7e088a2')}
          </span>
        )}
      </div>
      <div className="hint" style={{ marginTop: 6 }}>
        {matting?.downloaded
          ? i18n.t('k3676697f')
          : i18n.t('ka18ce425')}
      </div>
      {!!matting?.error && (
        <div className="hint" style={{ color: 'var(--err, #e5484d)', marginTop: 6 }}>
          {matting.error}
        </div>
      )}

      {/* 本地偏好模型：个性化推荐 */}
      <div className="settings-subtitle" style={{ marginTop: 14 }}>
        {i18n.t('k8d84a070')}
      </div>
      <div className="hint" style={{ marginBottom: 8, lineHeight: 1.9 }}>
        {i18n.t('k2771c23d')}
        <br />{i18n.t('k7e7bf1c5')}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn primary"
          onClick={async () => {
            try {
              const r = await api.prefTrain();
              setPref(await api.prefStatus());
              onToast(
                r.ok
                  ? i18n.t('k4f158176', { p0: r.samples, p1: r.pos, p2: r.neg, p3: r.updated })
                  : r.message || i18n.t('kaf7552e1')
              );
            } catch (err) {
              onToast((err as Error).message, 'error');
            }
          }}
        >
          {i18n.t('k2b9fcc7b')}
        </button>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {pref?.trained
            ? i18n.t('k42054592', { p0: pref.samples, p1: pref.featureCount })
            : i18n.t('k5c257446')}
        </span>
      </div>
      {!!(pref?.top || []).length && (
        <div className="hint" style={{ marginTop: 8, lineHeight: 1.9 }}>
          模型最看重的因素：
          {(pref?.top || []).map((t) => (
            <span key={t.feature} style={{ marginRight: 8 }}>
              {featureLabel(t.feature)}
              <b style={{ marginLeft: 4 }}>{t.w > 0 ? `+${t.w}` : t.w}</b>
            </span>
          ))}
        </div>
      )}

      {/* 第二档：Transformer 系（Swin2SR）——高画质但慢 */}
          <div className="settings-subtitle" style={{ marginTop: 14 }}>
          {i18n.t('k396f9ecc')}
          </div>
          <div className="hint" style={{ marginBottom: 8, lineHeight: 1.9 }}>
          {i18n.t('kab06f919')}
          <br />{i18n.t('k93102922')}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {(sr?.models || []).map((m) => (
          <button
          key={m.id}
          className={`btn sm${m.downloaded ? '' : ' primary'}`}
          disabled={!!sr?.loading}
          onClick={async () => {
            try {
              // 后台下载：接口立刻返回，进度/结果走 job 心跳
              // （以前同步等几百 MB 下载，前端 20s 超时弹「请求超时」，其实后台还在下）
              const r = await api.aiSrLoad(m.id);
              setSr(r);
              onToast(i18n.t('kd321da29', { p0: m.label }));
            } catch (err) {
              onToast((err as Error).message, 'error');
            }
          }}
          title={m.desc}
          >
          {m.downloaded ? '✓ ' : '↓ '}
          {m.label}
          {m.loaded ? i18n.t('k15e5209f') : ''}
          </button>
          ))}
          </div>
          {!!sr?.loading && (
          <div className="hint" style={{ marginTop: 8 }}>
          正在处理：{sr.message || sr.loading}
          </div>
          )}
          {!!sr?.error && (
          <div className="hint" style={{ marginTop: 8, color: 'var(--err, #e5484d)' }}>
          {sr.error}
          </div>
          )}
          </div>

    <div className="settings-subtitle">{i18n.t('k8333570d')}</div>
    <div className="settings-desc">
      软件会自动完成「上传图片 → 按参数请求 → 下载结果 → 覆盖原文件」。下面是可直接一键添加的常用免费服务，
      添加后请把 Key 换成自己的，再点「测试服务」验证连通性（返回内容会直接显示出来，便于照着调整）。
      支持「一次请求返回结果」的接口；需要轮询任务的服务（如 Replicate、Bigjpg 官方 API）请改用下方自建服务。
    </div>
    <div className="preset-grid">
      {REMOTE_PRESETS.map((p) => (
        <div className="preset-card" key={p.key}>
          <div className="preset-head">
            <b>{p.name}</b>
            <span className="tag-pill">{p.tag}</span>
          </div>
          <div className="hint">{p.desc}</div>
          <button
            className="btn sm"
            onClick={() =>
              patch({
                enhance: {
                  ...settings.enhance,
                  remoteServices: [
                    ...(settings.enhance.remoteServices || []),
                    { ...p.service, id: String(Date.now()) + p.key },
                  ],
                },
              })
            }
          >
            {i18n.t('keca076b7')}
          </button>
        </div>
      ))}
    </div>

    {(settings.enhance?.remoteServices || []).map((svc: EnhanceRemoteService) => (
      <div
        key={svc.id}
        style={{
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 10,
          marginBottom: 10,
          background: 'var(--panel)',
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder={i18n.t('k8f3747c0')}
            value={svc.name}
            onChange={(e) =>
              patch({
                enhance: {
                  ...settings.enhance,
                  remoteServices: settings.enhance.remoteServices.map((s) =>
                    s.id === svc.id ? { ...s, name: e.target.value } : s
                  ),
                },
              })
            }
          />
          <button
            className="del"
            title={i18n.t('ka9fafb87')}
            aria-label={i18n.t('k7e09b872', { p0: svc.name || i18n.t('k7f0425a8') })}
            onClick={() =>
              patch({
                enhance: {
                  ...settings.enhance,
                  remoteServices: settings.enhance.remoteServices.filter((s) => s.id !== svc.id),
                },
              })
            }
          >
            <IconTrash />
          </button>
        </div>
        <div className="field">
          <label>{i18n.t('k4080a72b')}</label>
          <input
            className="input"
            value={svc.uploadUrl}
            placeholder="https://example.com/api/upscale"
            onChange={(e) =>
              patch({
                enhance: {
                  ...settings.enhance,
                  remoteServices: settings.enhance.remoteServices.map((s) =>
                    s.id === svc.id ? { ...s, uploadUrl: e.target.value } : s
                  ),
                },
              })
            }
          />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>{i18n.t('k42b54b3d')}</label>
            <input
              className="input"
              value={svc.fileField || 'file'}
              onChange={(e) =>
                patch({
                  enhance: {
                    ...settings.enhance,
                    remoteServices: settings.enhance.remoteServices.map((s) =>
                      s.id === svc.id ? { ...s, fileField: e.target.value } : s
                    ),
                  },
                })
              }
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>{i18n.t('k322b25e7')}</label>
            <Select
              className="select"
              style={{ width: '100%' }}
              value={svc.resultType || 'json'}
              onChange={(v) =>
                patch({
                  enhance: {
                    ...settings.enhance,
                    remoteServices: settings.enhance.remoteServices.map((s) =>
                      s.id === svc.id ? { ...s, resultType: v as 'direct' | 'json' } : s
                    ),
                  },
                })
              }
            >
              <option value="json">{i18n.t('k3e2c15d3')}</option>
              <option value="direct">{i18n.t('kdefd2055')}</option>
            </Select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>{i18n.t('kbfb4c69a')}</label>
            <Select
              className="select"
              style={{ width: '100%' }}
              value={svc.bodyMode || 'multipart'}
              onChange={(v) =>
                patch({
                  enhance: {
                    ...settings.enhance,
                    remoteServices: settings.enhance.remoteServices.map((s) =>
                      s.id === svc.id ? { ...s, bodyMode: v as 'multipart' | 'binary' } : s
                    ),
                  },
                })
              }
            >
              <option value="multipart">{i18n.t('k6975dd0b')}</option>
              <option value="binary">{i18n.t('kd242eb0e')}</option>
            </Select>
          </div>
        </div>
        {svc.resultType !== 'direct' && (
          <div className="field">
            <label>{i18n.t('kf53c9571')}</label>
            <input
              className="input"
              value={svc.resultUrlPath || ''}
              placeholder="data.output"
              onChange={(e) =>
                patch({
                  enhance: {
                    ...settings.enhance,
                    remoteServices: settings.enhance.remoteServices.map((s) =>
                      s.id === svc.id ? { ...s, resultUrlPath: e.target.value } : s
                    ),
                  },
                })
              }
            />
          </div>
        )}
        <div className="field">
          <label>{i18n.t('kb15be1c4')}</label>
          <textarea
            className="input"
            rows={2}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
            value={(svc.params || []).map((p) => `${p.key}=${p.value}`).join('\n')}
            placeholder={'scale=2\nnoise=1'}
            onChange={(e) =>
              patch({
                enhance: {
                  ...settings.enhance,
                  remoteServices: settings.enhance.remoteServices.map((s) =>
                    s.id === svc.id
                      ? {
                          ...s,
                          params: e.target.value
                            .split('\n')
                            .map((l) => l.trim())
                            .filter(Boolean)
                            .map((l) => {
                              const i = l.indexOf('=');
                              return i < 0
                                ? { key: l, value: '' }
                                : { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
                            }),
                        }
                      : s
                  ),
                },
              })
            }
          />
        </div>
        <div className="field">
          <label>{i18n.t('k4d2cb06d')}</label>
          <textarea
            className="input"
            rows={2}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
            value={(svc.headers || []).map((h) => `${h.key}=${h.value}`).join('\n')}
            placeholder={i18n.t('k5f0f4f59')}
            onChange={(e) =>
              patch({
                enhance: {
                  ...settings.enhance,
                  remoteServices: settings.enhance.remoteServices.map((s) =>
                    s.id === svc.id
                      ? {
                          ...s,
                          headers: e.target.value
                            .split('\n')
                            .map((l) => l.trim())
                            .filter(Boolean)
                            .map((l) => {
                              const i = l.indexOf('=');
                              return i < 0
                                ? { key: l, value: '' }
                                : { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
                            }),
                        }
                      : s
                  ),
                },
              })
            }
          />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn sm"
            disabled={remoteTesting === svc.id}
            onClick={async () => {
              setRemoteTesting(svc.id);
              try {
                const r = await api.enhanceRemoteTest(svc);
                setRemoteTest((prev) => ({ ...prev, [svc.id]: { ok: r.ok, message: r.message } }));
              } catch (err) {
                setRemoteTest((prev) => ({
                  ...prev,
                  [svc.id]: { ok: false, message: (err as Error).message },
                }));
              } finally {
                setRemoteTesting('');
              }
            }}
          >
            {remoteTesting === svc.id ? i18n.t('k2ff33d1a') : i18n.t('k3c8adc9f')}
          </button>
          <span className="hint">{i18n.t('kd99e0adf')}</span>
        </div>
        {remoteTest[svc.id] && (
          <div
            className="ai-result"
            style={{
              marginTop: 8,
              borderColor: remoteTest[svc.id].ok ? 'rgba(74,222,128,0.4)' : 'rgba(248,113,113,0.4)',
            }}
          >
            {remoteTest[svc.id].ok ? '✓ ' : '✗ '}
            {remoteTest[svc.id].message}
          </div>
        )}
      </div>
    ))}
    <button
      className="btn"
      onClick={() =>
        patch({
          enhance: {
            ...settings.enhance,
            remoteServices: [
              ...(settings.enhance.remoteServices || []),
              {
                id: String(Date.now()),
                name: '',
                uploadUrl: '',
                fileField: 'file',
                method: 'POST',
                bodyMode: 'multipart',
                headers: [],
                resultType: 'json',
                resultUrlPath: '',
                apiKey: '',
                params: [],
              },
            ],
          },
        })
      }
    >
      {i18n.t('k5873e51b')}
    </button>
    <div className="hint" style={{ marginTop: 12 }}>
      {i18n.t('k65b3dc1a')}
      <br />{i18n.t('kcfd66f7b')}
    </div>

      {/* 硬件门槛：抠图 / 超分要跑本地模型，机器不够时得先让用户看见差距 */}
      <div className="settings-subtitle" style={{ marginTop: 18 }}>
        {i18n.t('ka8145dd5')}
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>
        抠图、AI 超分、人脸扫描、语义检索都是本地跑模型：内存不够会卡死或中途失败，AI 超分还必须有能跑
        Vulkan 的显卡。达不到最低配置时，点功能会先弹一张对照表；配置偏低但仍能试的，会给你「仍然继续」。
      </div>
      {hw ? (
        <>
          <div className="hint" style={{ lineHeight: 1.9 }}>
            · 处理器：{hw.hardware.cpu.model}（{hw.hardware.cpu.cores} 核 · {hw.hardware.cpu.arch} ·{' '}
            {hw.hardware.cpu.platform}）
            <br />· 内存：{formatSize(hw.hardware.ram.totalMB * 1048576)}，当前可用{' '}
            {formatSize(hw.hardware.ram.freeMB * 1048576)}
            <br />· 显卡：
            {hw.hardware.gpu.devices.length
              ? hw.hardware.gpu.devices
                  .map((d) => (d.vramMB ? `${d.name}（${formatSize(d.vramMB * 1048576)}）` : d.name))
                  .join(' / ')
              : i18n.t('k317477be')}
            {' · Vulkan '}
            {hw.hardware.gpu.vulkan.capable === true
              ? i18n.t('kad6b7038')
              : hw.hardware.gpu.vulkan.capable === false
                ? i18n.t('kd1e4a7e9')
                : i18n.t('k927933bf')}
          </div>
          <table className="hw-table" style={{ marginTop: 10 }}>
            <colgroup>
              <col style={{ width: '36%' }} />
              <col />
              <col style={{ width: 72 }} />
            </colgroup>
            <thead>
              <tr>
                <th>{i18n.t('k3ccc0ef1')}</th>
                <th>{i18n.t('kd9eb9322')}</th>
                <th>{i18n.t('ke777f812')}</th>
              </tr>
            </thead>
            <tbody>
              {hw.features.map((f) => (
                <tr key={f.id} className={f.level === 'ok' ? 'ok' : f.level === 'warn' ? 'warn' : 'bad'}>
                  <td>
                    {f.label}
                    <div className="hw-engine">{f.engine}</div>
                  </td>
                  <td title={f.basis.join('\n')}>
                    {f.checks.length ? (
                      <ul className="hw-reqs">
                        {f.checks.map((c) => (
                          <li key={c.id}>
                            {c.label} {c.need}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      i18n.t('k1c7e477d')
                    )}
                  </td>
                  <td className="hw-verdict" title={f.reason}>
                    {f.level === 'ok' ? i18n.t('kc4865b1d') : f.level === 'warn' ? i18n.t('k70323700') : i18n.t('kd1e4a7e9')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="hint" style={{ marginTop: 8, lineHeight: 1.8 }}>
            {i18n.t('k90ed7347')}
          </div>
          <button
            className="btn sm"
            style={{ marginTop: 8 }}
            disabled={hwBusy}
            onClick={async () => {
              setHwBusy(true);
              try {
                setHw(await refreshHardware());
                onToast(i18n.t('k0f8f24e9'));
              } catch (err) {
                onToast(i18n.t('kbc1969eb', { p0: (err as Error).message }), 'error');
              } finally {
                setHwBusy(false);
              }
            }}
          >
            {hwBusy ? i18n.t('k0a08b242') : i18n.t('kf515f8fb')}
          </button>
        </>
      ) : (
        <div className="hint">{i18n.t('k8dd9f460')}</div>
      )}
  </Card>
  );
}
