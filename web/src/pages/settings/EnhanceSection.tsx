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
    name: 'Hugging Face · Swin2SR 图像超分',
    tag: '免费 · 需 Token',
    desc: '免费 Serverless 推理，直接返回图片。到 huggingface.co 注册后生成 hf_ 开头的 Token 填入',
    service: {
      name: 'HuggingFace Swin2SR ×4',
      uploadUrl: 'https://api-inference.huggingface.co/models/caidas/swin2SR-realworld-sr-x4-64-bsrgan-psnr',
      method: 'POST',
      bodyMode: 'binary',
      fileField: 'file',
      headers: [{ key: 'Authorization', value: 'Bearer 在这里填你的 hf_ Token' }],
      resultType: 'direct',
      resultUrlPath: '',
      params: [],
      apiKey: '',
    },
  },
  {
    key: 'deepai',
    name: 'DeepAI · 超分辨率（Torch-SRGAN）',
    tag: '免费额度 · 需 Key',
    desc: '老牌接口，注册即送免费额度。上传后返回结果链接，需填入 api-key',
    service: {
      name: 'DeepAI 超分',
      uploadUrl: 'https://api.deepai.org/api/torch-srgan',
      method: 'POST',
      bodyMode: 'multipart',
      fileField: 'image',
      headers: [{ key: 'api-key', value: '在这里填你的 DeepAI Key' }],
      resultType: 'json',
      resultUrlPath: 'output_url',
      params: [],
      apiKey: '',
    },
  },
  {
    key: 'deepai-waifu2x',
    name: 'DeepAI · waifu2x 放大（动漫/插画）',
    tag: '免费额度 · 需 Key',
    desc: '与上面同一家的动漫风超分接口，同样填 DeepAI 的 api-key 即可',
    service: {
      name: 'DeepAI waifu2x',
      uploadUrl: 'https://api.deepai.org/api/waifu2x',
      method: 'POST',
      bodyMode: 'multipart',
      fileField: 'image',
      headers: [{ key: 'api-key', value: '在这里填你的 DeepAI Key' }],
      resultType: 'json',
      resultUrlPath: 'output_url',
      params: [],
      apiKey: '',
    },
  },
  {
    key: 'selfhost',
    name: '自建 Real-ESRGAN 服务',
    tag: '完全免费 · 无限次',
    desc: '开源自建（如 image-enhance-api / realesrgan-api），本机或服务器部署，无需 Key',
    service: {
      name: '自建超分服务',
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
      src: '来源',
      kw: '关键词',
      bucket: '分辨率档',
      orient: '方向',
      hue: '色系',
      bright: '亮度档',
      sharp: '清晰度档',
      term: '画面问题',
    };
    const v: Record<string, string> = {
      sd: '低清', fhd: '1080P', '2k': '2K', '4k': '4K',
      portrait: '竖图', landscape: '横图', square: '方图', gray: '黑白灰',
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
        onToast(`增强模型列表刷新失败：${msg}`, 'error');
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
            if (st.error) onToast(`去背景模型下载失败：${st.error}`, 'error');
            else onToast(st.message || '去背景模型下载完成');
          }
          mattingDownloadingRef.current = !!st.downloading;
        }
        if (d?.sr) {
          const st = d.sr;
          setSr(st);
          if (srLoadingRef.current && !st.loading) {
            onToast(st.error ? `模型下载失败：${st.error}` : '超分模型已就绪');
            reloadModels();
          }
          srLoadingRef.current = !!st.loading;
        }
        if (d?.aiUp) {
          const st = d.aiUp;
          setAiUp(st);
          if (aiUpDownloadingRef.current && !st.downloading) {
            // 运行库 / Real-CUGAN / 社区模型三类安装都走这里收尾；结果带在 message/installError 里
            if (st.installError) onToast(`安装失败：${st.installError}`, 'error');
            else onToast(st.message || '安装完成');
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
    title="画质增强"
    desc="设置「低于该标准」的图片自动收录，并选择增强方式。改动后点右上角「保存设置」生效。"
  >
    <div className="field">
      <label>目标标准（低于该分辨率的图片视为待增强）</label>
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
        <option value="custom">自定义…</option>
      </Select>
    </div>
    {settings.enhance?.standard === 'custom' && (
      <div style={{ display: 'flex', gap: 8, marginTop: -4 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>宽度（px）</label>
          <input
            className="input"
            type="number"
            value={settings.enhance?.customWidth ?? 1920}
            onChange={(e) => patch({ enhance: { ...settings.enhance, customWidth: Number(e.target.value) || 0 } })}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>高度（px）</label>
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
      <label>默认增强模型</label>
      <Select
        className="select"
        style={{ width: '100%' }}
        value={settings.enhance?.model || 'sharp-standard'}
        onChange={(v) => patch({ enhance: { ...settings.enhance, model: v } })}
      >
        <optgroup label="内置插值放大（离线，不生成新细节）">
          {(enhanceModels.builtin || []).map((m: EnhanceModel) => (
            <option key={m.id} value={m.id}>
              {m.label} · {m.desc}
            </option>
          ))}
        </optgroup>
        {(enhanceModels.ai || []).length > 0 && (
          <optgroup label="AI 超分模型（Real-ESRGAN）">
            {(enhanceModels.ai || []).map((m: EnhanceAiModel) => (
              <option key={m.id} value={m.id} disabled={!m.available}>
                {m.label}
                {m.available ? '' : '（未安装）'}
              </option>
            ))}
          </optgroup>
        )}
        {(enhanceModels.remote || []).length > 0 && (
          <optgroup label="线上服务">
            {(enhanceModels.remote || []).map((r: EnhanceRemoteService) => (
              <option key={r.id} value={`remote:${r.id}`}>
                {r.name}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
      <div className="hint">
        内置模型基于 sharp 插值放大，离线可用、无额外依赖；也可在下方配置线上免费增强服务
      </div>
      {modelsErr && (
        <div className="hint" style={{ color: 'var(--err, #e5484d)' }}>
          模型列表读取失败：{modelsErr}
          <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={reloadModels}>
            重试
          </button>
        </div>
      )}
    </div>

    <div className="settings-subtitle">AI 超分模型（Real-ESRGAN）</div>
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
              ? '● 已安装，但运行环境异常'
              : '● 已安装，可离线使用'
            : '○ 未安装'}
        </b>
        {aiUp?.installed && aiUp.gpu && (
          <span className="tag-pill ok">AI 加速：{aiUp.gpu}</span>
        )}
        <span className="hint" style={{ marginLeft: 'auto' }}>
          免 Python / 免 CUDA · 约 43MB · 一次下载永久离线
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
              onToast('已开始下载（约 43MB），可在下方查看进度');
            } catch (err) {
              onToast((err as Error).message, 'error');
            }
          }}
        >
          {aiUp?.downloading
            ? aiUp.progress >= 0
              ? `下载中 ${aiUp.progress}%`
              : '下载中…'
            : aiUp?.installed
              ? '重新安装 / 修复'
              : '下载并安装运行库'}
        </button>
        <button
          className="btn"
          disabled={!aiUp?.installed}
          onClick={async () => {
            try {
              const r = await api.aiUpscaleSelfTest();
              setAiUp(await api.aiUpscaleStatus());
              onToast(r.gpu ? `自检通过，AI 加速：${r.gpu}` : `自检失败：${r.error}`);
            } catch (err) {
              onToast((err as Error).message, 'error');
            }
          }}
        >
          重新检测
        </button>
      </div>

      <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
        · 安装后「画质增强」页的模型下拉里会出现 3 个真·AI 超分模型：
        <br />　realesrgan-x4plus（通用照片）、x4plus-anime（二次元/插画）、animevideov3（动漫/写真，最快）
        <br />· AI 超分单张约数秒到数十秒，批量任务在后台执行，可在增强页看进度
        <br />· 运行环境：Real-ESRGAN ncnn + Vulkan，使用显卡加速，无需安装 Python 或 CUDA
      </div>

      {/* 社区模型（真人照片效果更好）+ Real-CUGAN（两级降噪放大） */}
      <div className="settings-subtitle" style={{ marginTop: 14 }}>
        社区模型与 Real-CUGAN
      </div>
      <div className="hint" style={{ marginBottom: 8, lineHeight: 1.9 }}>
        · 社区模型比内置 realesrgan-x4plus 更适合真人照片（涂抹感更少、细节更稳），点「安装」即下载（单个约几 MB）
        <br />· Real-CUGAN 带降噪档位：装了它之后，**噪点重 / 压缩狠的图会自动走两级流程**：Real-CUGAN 2× 降噪 → 主模型补到标准
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
                onToast(`已开始后台下载 ${m.label}，进度见下方`);
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
              onToast('已开始后台下载 Real-CUGAN 运行库，进度见下方');
            } catch (err) {
              onToast((err as Error).message, 'error');
            }
          }}
        >
          {aiUp?.downloading
            ? aiUp.progress >= 0
              ? `下载中 ${aiUp.progress}%`
              : '下载中…'
            : aiUp?.cugan?.installed
              ? '重新安装 Real-CUGAN'
              : '↓ 安装 Real-CUGAN 运行库（约 30MB）'}
        </button>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {aiUp?.cugan?.installed
            ? `已安装（可用模型 ${(aiUp.cugan.models || []).length} 个）`
            : '未安装：噪点重的图将只走单级放大'}
          </span>
          </div>

          {/* AI 去背景 */}
      <div className="settings-subtitle" style={{ marginTop: 14 }}>
        AI 去背景（本地 ONNX，三档可选）
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>
        按质量自动选档：装了旗舰档（BEN2，1024px）就用它，其次精细档（BiRefNet lite），都没有才用轻量档（U-2-Net，320px）。
        发丝、绒毛、玻璃与半透明边缘，旗舰 / 精细档明显更干净（代价是 CPU 单张几秒）；
        <strong>三档都只做人像 / 主体分割</strong>，纯风景、商品、文字图往往抠不干净（工具会提示「几乎没抠出主体」）。
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
                  当前使用
                </span>
              )}
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {p.installed ? `${Math.round(p.size / 1024 / 1024)}MB 已下载` : `约 ${Math.round(p.sizeHint / 1024 / 1024)}MB`}
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
                    onToast(`已开始后台下载：${p.label}`);
                  } catch (err) {
                    onToast((err as Error).message, 'error');
                  }
                }}
              >
                {isThis ? `下载中 ${matting?.progress}%` : p.installed ? '重新下载' : '下载'}
              </button>
              {isThis && (
                <button
                  className="btn sm"
                  onClick={async () => {
                    try {
                      await api.mattingCancel();
                      onToast('已取消下载');
                      setMatting(await api.mattingStatus());
                    } catch (err) {
                      onToast((err as Error).message, 'error');
                    }
                  }}
                >
                  取消
                </button>
              )}
            </div>
          );
        })}
        {!matting?.profiles?.length && (
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            未下载：去背景功能需要先下载模型（一次性）。完整清单与删除入口见「设置 → 下载中心」。
          </span>
        )}
      </div>
      <div className="hint" style={{ marginTop: 6 }}>
        {matting?.downloaded
          ? '已就绪：大图预览 → 「✂ 去背景」，生成透明 PNG 存为新图，原图不动'
          : '去背景功能需要先下载模型（一次性）'}
      </div>
      {!!matting?.error && (
        <div className="hint" style={{ color: 'var(--err, #e5484d)', marginTop: 6 }}>
          {matting.error}
        </div>
      )}

      {/* 本地偏好模型：个性化推荐 */}
      <div className="settings-subtitle" style={{ marginTop: 14 }}>
        本地偏好模型（个性化推荐）
      </div>
      <div className="hint" style={{ marginBottom: 8, lineHeight: 1.9 }}>
        · 用你的行为离线训练：收藏 / 壁纸「喜欢」当正样本，删除并选了原因 / 壁纸「不喜欢」当负样本
        <br />· 只用画面属性（来源、分辨率、方向、色系、亮度、清晰度、模糊噪点等问题词）建模，全部在本机完成
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
                  ? `训练完成：${r.samples} 个样本（喜欢 ${r.pos} / 不喜欢 ${r.neg}），已更新 ${r.updated} 张图的偏好分`
                  : r.message || '训练失败'
              );
            } catch (err) {
              onToast((err as Error).message, 'error');
            }
          }}
        >
          训练偏好模型
        </button>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {pref?.trained
            ? `已训练（${pref.samples} 样本 · ${pref.featureCount} 特征）`
            : '未训练：图库「推荐」排序与壁纸挑选将使用中性分'}
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
          高画质（慢）· Transformer 超分
          </div>
          <div className="hint" style={{ marginBottom: 8, lineHeight: 1.9 }}>
          · Swin2SR（SwinIR 后续工作）重建更自然、伪影更少，但 CPU 上单张约十秒级，适合少量重点图
          <br />· 首次使用会自动下载模型（几十到几百 MB，走国内镜像）；点下面的按钮可提前下载 / 预热
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
              onToast(`已开始后台下载 ${m.label}，进度见下方`);
            } catch (err) {
              onToast((err as Error).message, 'error');
            }
          }}
          title={m.desc}
          >
          {m.downloaded ? '✓ ' : '↓ '}
          {m.label}
          {m.loaded ? '（已就绪）' : ''}
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

    <div className="settings-subtitle">线上增强服务（可选）</div>
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
            ＋ 添加此服务
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
            placeholder="服务名称"
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
            title="删除该服务"
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
          <label>上传接口地址（接收 multipart 文件字段）</label>
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
            <label>文件字段名</label>
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
            <label>返回类型</label>
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
              <option value="json">JSON（含结果地址）</option>
              <option value="direct">直接返回图片</option>
            </Select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>请求体方式</label>
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
              <option value="multipart">表单上传（多数服务）</option>
              <option value="binary">二进制直传（Hugging Face 等）</option>
            </Select>
          </div>
        </div>
        {svc.resultType !== 'direct' && (
          <div className="field">
            <label>结果地址字段路径（如 data.output，留空尝试 url/result/output）</label>
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
          <label>附加参数（每行 key=value，可选）</label>
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
          <label>自定义请求头（每行 名称=值，可选；如 api-key=xxx）</label>
          <textarea
            className="input"
            rows={2}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
            value={(svc.headers || []).map((h) => `${h.key}=${h.value}`).join('\n')}
            placeholder={'api-key=你的Key\nAuthorization=Bearer xxx'}
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
            {remoteTesting === svc.id ? '测试中…' : '测试服务'}
          </button>
          <span className="hint">用一张 64×64 测试图跑完整流程，不会改动你的图片</span>
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
      ＋ 新增线上服务
    </button>
    <div className="hint" style={{ marginTop: 12 }}>
      · 软件会自动：上传图片 → 按参数请求 → 下载结果 → 覆盖原文件（其他软件打开即为增强后效果）
      <br />· 线上服务需自备接口（开源/免费增强 API 均可），请遵守其使用条款
    </div>

      {/* 硬件门槛：抠图 / 超分要跑本地模型，机器不够时得先让用户看见差距 */}
      <div className="settings-subtitle" style={{ marginTop: 18 }}>
        本机硬件与大模型功能的最低要求
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
              : '未读到'}
            {' · Vulkan '}
            {hw.hardware.gpu.vulkan.capable === true
              ? '可用'
              : hw.hardware.gpu.vulkan.capable === false
                ? '不可用'
                : '未确认（装好运行库后点「重新检测」）'}
          </div>
          <table className="hw-table" style={{ marginTop: 10 }}>
            <colgroup>
              <col style={{ width: '36%' }} />
              <col />
              <col style={{ width: 72 }} />
            </colgroup>
            <thead>
              <tr>
                <th>功能 / 引擎</th>
                <th>最低要求</th>
                <th>判定</th>
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
                      '无需检查（不用模型）'
                    )}
                  </td>
                  <td className="hw-verdict" title={f.reason}>
                    {f.level === 'ok' ? '满足' : f.level === 'warn' ? '偏低，可试' : '不可用'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="hint" style={{ marginTop: 8, lineHeight: 1.8 }}>
            把鼠标停在上面的「最低要求 / 判定」上可以看到门槛的依据（哪些是官方说明、哪些是我们按模型规模估的）。
          </div>
          <button
            className="btn sm"
            style={{ marginTop: 8 }}
            disabled={hwBusy}
            onClick={async () => {
              setHwBusy(true);
              try {
                setHw(await refreshHardware());
                onToast('硬件信息已重新检测');
              } catch (err) {
                onToast(`检测失败：${(err as Error).message}`, 'error');
              } finally {
                setHwBusy(false);
              }
            }}
          >
            {hwBusy ? '检测中…' : '重新检测'}
          </button>
        </>
      ) : (
        <div className="hint">正在读取本机硬件…（读不到不影响其它设置）</div>
      )}
  </Card>
  );
}
