/**
 * 全网以图搜图面板。
 *
 * 引擎分两类，界面上必须区分清楚：
 * - upload：服务端真把图上传出去（Yandex / SauceNAO），点一下就有结果；
 * - manual：那几个站点 2026 年已关掉匿名上传口（百度签名校验、搜狗 500、360 404、
 *   Lens / TinEye 只给付费 API），只能打开识图页让用户粘贴。原因原样写在卡片上，
 *   不做「点了以为搜了、其实什么都没发生」的假入口。
 *
 * 国外引擎要过国际网络：先体检，不通就弹出「只用国内引擎 / 仍然尝试」让用户决定，
 * 而不是让几个请求默默超时、假装搜过了。
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  api,
  BASE,
  copyImageToClipboard,
  type ReverseEngine,
  type ReverseEngineResult,
  type ReverseNetwork,
} from '../api';
import { IconClose } from './Icons';

export type ReverseTarget = {
  /** 单张图搜图 */
  imageId?: number;
  /** 人物搜图：服务端会挑「最清晰最完整」的那张 */
  personId?: number;
  /** 面板顶部的预览图（人物用封面脸裁切图，图片用缩略图） */
  previewUrl: string;
  title: string;
  /** 人物搜图时补一句「用的是哪一张」 */
  hint?: string;
};

type Props = {
  target: ReverseTarget | null;
  onClose: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
};

function errText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export default function ReverseSearchDialog({ target, onClose, onToast }: Props) {
  const [engines, setEngines] = useState<ReverseEngine[]>([]);
  const [network, setNetwork] = useState<ReverseNetwork | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [needConfirm, setNeedConfirm] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ReverseEngineResult[] | null>(null);

  useEffect(() => {
    if (!target) return;
    let alive = true;
    setLoading(true);
    setResults(null);
    setNeedConfirm(false);
    api
      .reverseEngines()
      .then((r) => {
        if (!alive) return;
        setEngines(r.engines);
        setNetwork(r.network);
        // 默认勾上「能真上传且这次通」的引擎：不动手动档，免得一点开就弹好几个网页
        setPicked(new Set(r.engines.filter((e) => e.mode === 'upload' && e.ready).map((e) => e.id)));
      })
      .catch((err) => {
        if (!alive) return;
        onToast('读取搜图引擎失败：' + errText(err), 'error');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // 目标换了才重新拉清单；onToast 是父级内联函数，不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.imageId, target?.personId]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !running) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, running, onClose]);

  const cnEngines = useMemo(() => engines.filter((e) => e.region === 'cn'), [engines]);
  const globalEngines = useMemo(() => engines.filter((e) => e.region === 'global'), [engines]);
  const selectedGlobalBlocked = engines.filter(
    (e) => picked.has(e.id) && e.mode === 'upload' && e.region === 'global' && !e.ready
  );

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async (ids: string[]) => {
    if (!target || !ids.length) {
      onToast('至少选一个引擎', 'error');
      return;
    }
    setRunning(true);
    setNeedConfirm(false);
    setResults([]);
    try {
      const r = await api.reverseSearchAll({ imageId: target.imageId, personId: target.personId, engines: ids });
      setResults(r.results);
      // 手动档要先复制原图再打开识图页；上传档直接开结果页
      let copied = false;
      for (const one of r.results) {
        if (!one.ok || !one.url) continue;
        if (one.mode === 'manual' && !copied) {
          try {
            await copyImageToClipboard(`${BASE}/api/images/${r.image.id}/file`);
            copied = true;
          } catch (err) {
            onToast('复制图片到剪贴板失败：' + errText(err), 'error');
          }
        }
        window.open(one.url, '_blank', 'noopener,noreferrer');
      }
      const bad = r.results.filter((x) => !x.ok);
      if (bad.length) {
        onToast(`搜图完成：${r.results.length - bad.length} 个成功，${bad.length} 个失败`, 'error');
      } else {
        onToast(`已在 ${r.results.length} 个引擎里搜这张图`);
      }
    } catch (err) {
      onToast('搜图失败：' + errText(err), 'error');
    } finally {
      setRunning(false);
    }
  };

  const start = () => {
    const ids = [...picked];
    if (selectedGlobalBlocked.length && !needConfirm) {
      // 国外引擎这次不通：先问，用户拒绝就只跑国内
      setNeedConfirm(true);
      return;
    }
    void run(ids);
  };

  if (!target) return null;

  const engineRow = (e: ReverseEngine) => (
    <button
      key={e.id}
      type="button"
      className={`rs-engine${picked.has(e.id) ? ' on' : ''}${e.mode === 'manual' ? ' manual' : ''}${e.ready ? '' : ' off'}`}
      onClick={() => toggle(e.id)}
      title={e.mode === 'manual' ? e.why || '' : e.desc}
    >
      <span className="rs-engine-name">{e.name}</span>
      <span className="rs-engine-tag">
        {e.mode === 'manual' ? '打开识图页粘贴' : e.ready ? '可直接搜' : '网络不通'}
      </span>
      <span className="rs-engine-desc">{e.mode === 'manual' ? e.why : e.desc}</span>
    </button>
  );

  return createPortal(
    <div className="modal-backdrop rs-backdrop" onClick={() => !running && onClose()}>
      <div className="modal-card rs-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{'全网以图搜图'}</b>
          <span className="rs-title" title={target.title}>
            {target.title}
          </span>
          <button className="icon-btn" onClick={onClose} title={'关闭（Esc）'}>
            <IconClose />
          </button>
        </div>

        <div className="rs-body">
          <div className="rs-target">
            {target.previewUrl && <img src={target.previewUrl} alt="" />}
            <div className="rs-target-text">
              <b>{target.hint || '用这张照片去检索'}</b>
              <span>
                {target.personId
                  ? '自动选这个人最清晰、人脸最大的一张：质量分高的优先，其次看人脸在画面里占多大'
                  : '会把原图上传给支持直传的引擎；不支持直传的引擎打开页面后粘贴（已自动复制）'}
              </span>
            </div>
          </div>

          {loading && <div className="rs-hint">{'正在检测各引擎可用性…'}</div>}

          <div className="rs-group">
            <div className="rs-group-title">{'国内引擎'}</div>
            <div className="rs-engines">{cnEngines.map(engineRow)}</div>
          </div>

          <div className="rs-group">
            <div className="rs-group-title">
              {'国外引擎'}
              {network && !network.ok && <em className="rs-bad">{'国际网络本次不通'}</em>}
            </div>
            <div className="rs-engines">{globalEngines.map(engineRow)}</div>
          </div>

          {needConfirm && (
            <div className="rs-confirm">
              <div>
                {`国际网络不通（${selectedGlobalBlocked.map((e) => e.name).join('、')} 连不上），这些引擎大概率搜不出来。要只用国内引擎吗？`}
              </div>
              <div className="rs-confirm-actions">
                <button
                  className="btn primary sm"
                  onClick={() => {
                    const ids = engines.filter((e) => e.region === 'cn').map((e) => e.id);
                    setPicked(new Set(ids));
                    void run(ids);
                  }}
                >
                  {'只用国内引擎'}
                </button>
                <button className="btn ghost sm" onClick={() => void run([...picked])}>
                  {'仍然全部尝试'}
                </button>
              </div>
            </div>
          )}

          <div className="rs-actions">
            <button className="btn primary" disabled={running || !picked.size} onClick={start}>
              {running ? '正在搜…' : `开始搜图（${picked.size} 个引擎）`}
            </button>
            <button className="btn ghost sm" onClick={() => setPicked(new Set(engines.map((e) => e.id)))}>
              {'全选'}
            </button>
            <button className="btn ghost sm" onClick={() => setPicked(new Set())}>
              {'清空'}
            </button>
            {network && (
              <span className="rs-hint">
                {'引擎按钮可多选；打开多个页面时浏览器可能拦截弹窗'}
              </span>
            )}
          </div>

          {results && (
            <div className="rs-results">
              {results.map((r) => (
                <div key={r.engine} className={`rs-result${r.ok ? '' : ' bad'}`}>
                  <div className="rs-result-head">
                    <b>{r.name}</b>
                    <span className={`rs-badge ${r.region}`}>{r.region === 'cn' ? '国内' : '国外'}</span>
                    <span className="rs-result-note">{r.ok ? r.note : r.error}</span>
                    {r.url && (
                      <button className="btn ghost sm" onClick={() => window.open(r.url, '_blank', 'noopener,noreferrer')}>
                        {'再打开'}
                      </button>
                    )}
                  </div>
                  {!!r.results?.length && (
                    <ul className="rs-hits">
                      {r.results.slice(0, 5).map((hit, i) => (
                        <li key={`${r.engine}-${i}`}>
                          <span className="rs-sim">{Math.round(hit.similarity)}%</span>
                          {hit.link ? (
                            <a href={hit.link} target="_blank" rel="noreferrer">
                              {hit.title}
                            </a>
                          ) : (
                            <span>{hit.title}</span>
                          )}
                          {hit.detail && <em>{hit.detail.slice(0, 60)}</em>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
