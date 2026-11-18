/**
 * 人物：本地人脸扫描 / 聚类结果浏览。
 *
 * 与「整理」页的区别：整理是「同类项合并」，人物是「同一个人跨照片」，
 * 交互上必须能进到某个人的全部照片，所以做成独立视图而不是整理页的第五种模式。
 *
 * 界面上的所有数字都来自后端真实状态（pending / persons / faces），
 * 没有下载模型或还没扫描时，明确说清楚缺什么，不用空网格糊过去。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, BASE, copyImageToClipboard, revealFile, type FacePerson, type FaceStatus } from '../api';
import type { ImageItem } from '../types';
import { IconCopy, IconDownload, IconExpand, IconFolder, IconImages, IconSearch, IconTrash, IconUsers } from '../components/Icons';
import MasonryGrid from '../components/MasonryGrid';
import VirtualGrid from '../components/VirtualGrid';
import ReverseSearchDialog, { type ReverseTarget } from '../components/ReverseSearchDialog';
import Select from '../components/Select';
import { ensureHardware } from '../lib/hardware';
import i18n from '../i18n';
import { previewHoverProps } from '../lib/preview-prefetch';

type Props = {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  onOpen: (item: ImageItem, pool?: ImageItem[]) => void;
  /** 灯箱里点了「人物 #123」：直接进这个人的照片墙 */
  focusPersonId?: number | null;
  /** 同一个人连点两次也要能跳（只靠 id 变化不会触发 effect） */
  focusNonce?: number;
};

/** 照片墙的格子宽度：和图片列表页一样能调，人物页常要看细节，默认比列表页大一点 */
const PEOPLE_COL_MIN = 90;
const PEOPLE_COL_MAX = 320;
const PEOPLE_COL_KEY = 'tuku:people-col';

/** 同人阈值预设：值越低越容易合并，也越容易把路人并给同一个人 */
/** 选项文字要能完整塞进下拉框：收起态被裁掉的数字最容易被误读成「显示不全」 */
const COS_PRESETS = [
  { v: 0.5, label: i18n.t('k17f79bcf') },
  { v: 0.42, label: i18n.t('k9896c990') },
  { v: 0.35, label: i18n.t('k916c0f4b') },
];

export default function People({ onToast, onOpen, focusPersonId, focusNonce }: Props) {
  /** 服务端按原因统计（模糊 / 人脸过小 / …），拼成一行「模糊 12 / 人脸过小 3」 */
  const whyText = (m?: Record<string, number>) =>
    Object.entries(m || {})
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(' / ');
  const [st, setSt] = useState<FaceStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [persons, setPersons] = useState<FacePerson[]>([]);
  const [personsTotal, setPersonsTotal] = useState(0);
  const [personsLimit, setPersonsLimit] = useState(500);
  // 默认只看「封面够清晰」的人物：只有一两张糊脸的人物多是误检，不该占满第一屏
  const [showAllPersons, setShowAllPersons] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  // 当前人物对象留一份快照：persons 列表会随「只看清晰封面」/limit/搜索变化，
  // 靠 id 反查常常查不到，结果详情页把「21 张人脸」显示成「0 张人脸」
  const [activePerson, setActivePerson] = useState<FacePerson | null>(null);
  const [items, setItems] = useState<ImageItem[] | null>(null);
  const [itemsTotal, setItemsTotal] = useState(0);
  const [itemsLimit, setItemsLimit] = useState(500);
  const [loadingItems, setLoadingItems] = useState(false);
  const [cos, setCos] = useState(0.42);
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);
  const [mergeTo, setMergeTo] = useState<number | ''>('');
  /** 照片墙格子宽度（和图片列表页的缩放滑杆一个意思，记在本地） */
  const [colW, setColW] = useState(() => {
    const saved = Number(localStorage.getItem(PEOPLE_COL_KEY));
    return saved >= PEOPLE_COL_MIN && saved <= PEOPLE_COL_MAX ? saved : 150;
  });
  useEffect(() => {
    localStorage.setItem(PEOPLE_COL_KEY, String(colW));
  }, [colW]);
  /** 右键菜单：人物卡片与人物照片共用一套 .card-ctx 样式 */
  const [personCtx, setPersonCtx] = useState<{ x: number; y: number; p: FacePerson } | null>(null);
  const [photoCtx, setPhotoCtx] = useState<{ x: number; y: number; item: ImageItem } | null>(null);
  /** 全网以图搜图面板的目标（人物或单张图） */
  const [rsTarget, setRsTarget] = useState<ReverseTarget | null>(null);

  // 右键菜单：点别处 / 滚动 / Esc 都关掉，别留一个悬浮层挡住图
  useEffect(() => {
    if (!personCtx && !photoCtx) return;
    const close = () => {
      setPersonCtx(null);
      setPhotoCtx(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('wheel', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [personCtx, photoCtx]);

  const toastRef = useRef(onToast);
  toastRef.current = onToast;

  const refresh = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        api.faceStatus(),
        api.facePersons({ limit: personsLimit, all: showAllPersons }),
      ]);
      setSt(s);
      setLoadError('');
      setPersons(p.persons);
      // total 是库里的真实总数：超过 limit 时界面必须明说「只显示了一部分」
      setPersonsTotal(p.total ?? p.persons.length);
    } catch (err) {
      // 读取失败时不能停在「还没有识别到人脸」上：那是在拿空态冒充失败
      setLoadError(String((err as Error).message || err));
      toastRef.current(i18n.t('kcf1d5e87', { p0: (err as Error).message }), 'error');
    }
  }, [personsLimit, showAllPersons]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 扫描/下载/清理进行中才轮询；停下来后立刻停，避免空转
  const busyNow = !!st && (st.scanning || st.downloading || !!st.cleaning || !!st.rebuilding);

  // 清理任务结束时给一句结果：进度条消失却不说结果，用户不知道到底排除了多少
  const prevCleaning = useRef(false);
  useEffect(() => {
    if (prevCleaning.current && !st?.cleaning) {
      if (st?.cleanError) toastRef.current(i18n.t('k9b27d3e4', { p0: st.cleanError }), 'error');
      else if (st?.cleanMessage) toastRef.current(st.cleanMessage);
      void refresh();
    }
    prevCleaning.current = !!st?.cleaning;
  }, [st?.cleaning, st?.cleanError, st?.cleanMessage, refresh]);

  // 重建结束时同理：只说「重建完成」，不刷新列表的话屏幕上还是旧分组
  const prevRebuilding = useRef(false);
  useEffect(() => {
    if (prevRebuilding.current && !st?.rebuilding) {
      if (st?.rebuildError) toastRef.current(i18n.t('k938b209c', { p0: st.rebuildError }), 'error');
      else if (st?.rebuildMessage) toastRef.current(st.rebuildMessage);
      void refresh();
    }
    prevRebuilding.current = !!st?.rebuilding;
  }, [st?.rebuilding, st?.rebuildError, st?.rebuildMessage, refresh]);
  useEffect(() => {
    if (!busyNow) return;
    const t = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(t);
  }, [busyNow, refresh]);

  const guard = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      toastRef.current((err as Error).message || i18n.t('k5fa802be'), 'error');
    }
  };

  const install = () =>
    guard(async () => {
      const r = await api.faceInstall();
      setSt(r);
      toastRef.current(i18n.t('ke72f2501'));
    });

  const scan = (force: boolean) =>
    guard(async () => {
      // 扫全库是逐张跑 SCRFD + ArcFace 两套 ONNX：先把内存/核心说清楚，别让用户等一次 OOM
      if (!(await ensureHardware('face'))) return;
      if (force && !window.confirm(i18n.t('k851ac3e0'))) return;
      const r = await api.faceScan({ force, minCos: cos });
      setSt(r);
      if (active != null) setActive(null);
      toastRef.current(force ? i18n.t('k59287a20') : i18n.t('k269feabc'));
    });

  const stop = () =>
    guard(async () => {
      await api.faceScanCancel();
      toastRef.current(i18n.t('k60ec11d9'));
      void refresh();
    });

  // 存量重算：老数据没有质量分、封面是「第一张脸」时代选的，这里一次性回填并重选
  const cleanup = () =>
    guard(async () => {
      const r = await api.faceQualityCleanup();
      setSt(r);
      if (r.busy) toastRef.current(i18n.t('k30f90f88'));
      else toastRef.current(i18n.t('kfb859113'));
      void refresh();
    });

  const cancelCleanup = () =>
    guard(async () => {
      await api.faceQualityCancel();
      toastRef.current(i18n.t('ke5b35cb5'));
    });

  // 全局重建：只用库里已有的特征重新聚类，能一次性清掉「一堆后脑勺凑成一个人」这类历史误分
  const rebuild = () =>
    guard(async () => {
      const ok = window.confirm(
        i18n.t('ka6b9cb43')
      );
      if (!ok) return;
      const r = await api.faceRebuild();
      setSt(r);
      toastRef.current(i18n.t('ke0c7afdf'));
      void refresh();
    });

  const cancelRebuild = () =>
    guard(async () => {
      await api.faceRebuildCancel();
      toastRef.current(i18n.t('k6a834324'));
    });

  /**
   * 按 id 打开某个人：列表点击、灯箱跳转、合并后跳转都走这一条。
   * 没有 snapshot 时先去取人物本身 —— 从灯箱跳进来只有 id，
   * 名字/封面/张数都得靠这次请求，否则详情页会把「126 张」显示成 0。
   */
  const openPersonById = (id: number, snapshot?: FacePerson) =>
    guard(async () => {
      setActive(id);
      if (snapshot) setActivePerson(snapshot);
      setItems(null);
      setItemsLimit(500);
      setItemsTotal(0);
      setLoadingItems(true);
      try {
        if (!snapshot) setActivePerson(await api.facePerson(id).catch(() => null));
        const r = await api.facePersonItems(id, { limit: 500 });
        setItems(r.items);
        setItemsTotal(r.total ?? r.items.length);
      } finally {
        setLoadingItems(false);
      }
    });

  const openPerson = (p: FacePerson) => openPersonById(p.id, p);

  // 灯箱里点「人物 #123」：切进这一页就直接打开这个人的照片墙
  const focusRef = useRef(-1);
  useEffect(() => {
    if (!focusPersonId) return;
    const nonce = focusNonce ?? 0;
    if (focusRef.current === nonce) return;
    focusRef.current = nonce;
    void openPersonById(focusPersonId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPersonId, focusNonce]);

  const loadMoreItems = () =>
    guard(async () => {
      if (active == null) return;
      const next = Math.min(2000, itemsLimit + 500);
      const r = await api.facePersonItems(active, { limit: next });
      setItems(r.items);
      setItemsTotal(r.total ?? r.items.length);
      setItemsLimit(next);
    });

  const submitRename = () =>
    guard(async () => {
      if (!renaming) return;
      const r = await api.faceRename(renaming.id, renaming.value);
      setPersons((prev) => prev.map((p) => (p.id === r.id ? { ...p, name: r.name } : p)));
      setRenaming(null);
    });

  const merge = () =>
    guard(async () => {
      if (active == null || mergeTo === '') return;
      const r = await api.faceMerge(active, Number(mergeTo));
      toastRef.current(i18n.t('kf9f8fb0e', { p0: r.moved }));
      setMergeTo('');
      setActive(Number(mergeTo));
      await refresh();
      const t = persons.find((p) => p.id === Number(mergeTo));
      if (t) await openPerson(t);
    });

  const removePerson = () => {
    if (active == null) return;
    void removePersonById(active);
  };

  /**
   * 手动指定封面。
   * 自动挑的封面再准也有「我就要这张」的需求；设完会锁住，
   * 后续扫描/清理不会再按清晰度把它换掉（否则用户会以为按钮没生效）。
   */
  const setCover = (imageId: number) =>
    guard(async () => {
      if (active == null) return;
      const r = await api.facePersonCover(active, imageId);
      const patch = (p: FacePerson): FacePerson => ({
        ...p,
        coverFaceId: r.coverFaceId,
        coverImageId: r.coverImageId,
        coverPx: r.coverPx,
        coverLocked: true,
      });
      setPersons((prev) => prev.map((p) => (p.id === active ? patch(p) : p)));
      setActivePerson((prev) => (prev && prev.id === active ? patch(prev) : prev));
      toastRef.current(i18n.t('k253b288a'));
    });

  const current = persons.find((p) => p.id === active) || activePerson;
  // 列表刷新后（清理/合并/重算）用最新数据覆盖快照，别让详情页停在旧数字上
  useEffect(() => {
    if (active == null) return;
    const hit = persons.find((p) => p.id === active);
    if (hit) setActivePerson(hit);
  }, [persons, active]);
  const coverUrl = (p: FacePerson) => (p.coverFaceId ? `${BASE}/api/face/crop/${p.coverFaceId}?size=224` : '');

  /** 去掉人物的全部人脸记录（图片本身不动） */
  const removePersonById = (id: number) =>
    guard(async () => {
      if (!window.confirm(i18n.t('kd9103a35'))) return;
      await api.faceDeletePerson(id);
      if (active === id) {
        setActive(null);
        setItems(null);
      }
      await refresh();
      toastRef.current(i18n.t('k64a0cdc3'));
    });

  /** 用这个人「最清晰最完整」的一张去全网搜图（挑图在服务端做，这里只给预览） */
  const searchPerson = (p: FacePerson) =>
    setRsTarget({
      personId: p.id,
      previewUrl: coverUrl(p),
      title: p.name || i18n.t('kffab35b2', { p0: p.id }),
      hint: i18n.t('k82f84fc3'),
    });

  const searchImage = (it: ImageItem) =>
    setRsTarget({ imageId: it.id, previewUrl: `${BASE}${it.thumbUrl}`, title: it.title });

  /** 菜单贴着鼠标出现，但不能溢出窗口 */
  const menuPos = (x: number, y: number, h = 210) => ({
    left: Math.min(x, Math.max(8, window.innerWidth - 208)),
    top: Math.min(y, Math.max(8, window.innerHeight - h)),
  });

  const copyText = (text: string) =>
    guard(async () => {
      await navigator.clipboard.writeText(text);
      toastRef.current(i18n.t('kc1489675'));
    });

  /* 右键菜单与搜图面板：三个分支（未下载/单人/网格）都要能弹出来 */
  const overlays = (
    <>
      {personCtx &&
        createPortal(
          <div
            className="card-ctx"
            style={menuPos(personCtx.x, personCtx.y)}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              onClick={() => {
                const p = personCtx.p;
                setPersonCtx(null);
                void openPerson(p);
              }}
            >
              <IconUsers /> {i18n.t('k6ba507fb')}
            </button>
            <button
              onClick={() => {
                const p = personCtx.p;
                setPersonCtx(null);
                searchPerson(p);
              }}
            >
              <IconSearch /> {i18n.t('k375e3ed7')}
            </button>
            <button
              onClick={() => {
                const p = personCtx.p;
                setPersonCtx(null);
                setRenaming({ id: p.id, value: p.name || '' });
                if (active !== p.id) void openPerson(p);
              }}
            >
              {i18n.t('k1f73fff4')}
            </button>
            <button
              onClick={() => {
                const p = personCtx.p;
                setPersonCtx(null);
                void removePersonById(p.id);
              }}
            >
              <IconTrash /> {i18n.t('k59af8fd9')}
            </button>
          </div>,
          document.body
        )}

      {photoCtx &&
        createPortal(
          <div
            className="card-ctx"
            style={menuPos(photoCtx.x, photoCtx.y, 250)}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              onClick={() => {
                const it = photoCtx.item;
                setPhotoCtx(null);
                onOpen(it, items || []);
              }}
            >
              <IconExpand /> {i18n.t('ka1c43723')}
            </button>
            <button
              onClick={() => {
                const it = photoCtx.item;
                setPhotoCtx(null);
                // 带上归属文件夹：回图库后筛选直接落在那一夹，关掉大图就停在那张图旁边
                void (async () => {
                  let folderId: number | null = null;
                  try {
                    const r = await api.imageFolders(it.id);
                    folderId = r.folders[0]?.id ?? null;
                  } catch {
                    // 查不到归属夹就按全库定位，不影响「打开这张图」
                    folderId = null;
                  }
                  window.dispatchEvent(
                    new CustomEvent('tuku:locate-image', { detail: { item: it, folderId } })
                  );
                })();
              }}
            >
              <IconImages /> {i18n.t('k3be29c7f')}
            </button>
            <button
              onClick={() => {
                const it = photoCtx.item;
                setPhotoCtx(null);
                searchImage(it);
              }}
            >
              <IconSearch /> {i18n.t('k375e3ed7')}
            </button>
            <button
              onClick={() => {
                const it = photoCtx.item;
                setPhotoCtx(null);
                void revealFile(it.path).catch((err: Error) =>
                  toastRef.current(i18n.t('kd8816168') + err.message, 'error')
                );
              }}
            >
              <IconFolder /> {i18n.t('kc24fc05a')}
            </button>
            <button
              onClick={() => {
                const it = photoCtx.item;
                setPhotoCtx(null);
                void copyImageToClipboard(`${BASE}${it.thumbUrl}`)
                  .then(() => toastRef.current(i18n.t('k73101507')))
                  .catch((err: Error) => toastRef.current(err.message, 'error'));
              }}
            >
              <IconCopy /> {i18n.t('k1819ff01')}
            </button>
            <button
              onClick={() => {
                const it = photoCtx.item;
                setPhotoCtx(null);
                void copyText(it.path);
              }}
            >
              <IconCopy /> {i18n.t('kf4130cae')}
            </button>
            {current?.coverImageId !== photoCtx.item.id && (
              <button
                onClick={() => {
                  const it = photoCtx.item;
                  setPhotoCtx(null);
                  void setCover(it.id);
                }}
              >
                {i18n.t('k137f3c79')}
              </button>
            )}
          </div>,
          document.body
        )}

      <ReverseSearchDialog target={rsTarget} onClose={() => setRsTarget(null)} onToast={onToast} />
    </>
  );

  /* ------------------------------ 顶部状态条 ------------------------------ */
  const head = (
    <div className="page-head">
      <div>
        <h1 className="page-title">{i18n.t('keec124ab')}</h1>
        <div className="page-sub">
          {i18n.t('k748f5380')}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {st?.downloaded && (
          // 以前只有一个裸 select，含义全藏在 hover 提示里；加可见标签与稳定宽度，
          // 免得窄窗口/系统缩放下选中项文字被裁掉，看起来像「显示不全」
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
            {i18n.t('kcd074759')}
            <select
              className="input"
              value={cos}
              onChange={(e) => setCos(Number(e.target.value))}
              title={i18n.t('kc6c23ff8')}
              // .input 自带 9px 上下内边距，再钉 height 就把 13px 的字挤成一条 —— 收掉内边距
              style={{ height: 32, minWidth: 176, padding: '0 26px 0 10px' }}
            >
              {COS_PRESETS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {!!st?.weakCoverPersons && (
          <button
            className={`btn sm${showAllPersons ? ' primary' : ''}`}
            onClick={() => setShowAllPersons((v) => !v)}
            aria-pressed={showAllPersons}
            title={i18n.t('k47aebfac')}
          >
            {showAllPersons
              ? i18n.t('k4b7ac5f0')
              : i18n.t('k5403bb40', { p0: st.weakCoverPersons })}
          </button>
        )}
        {st?.downloaded && !st.scanning && (
          st.cleaning ? (
            <button className="btn sm" onClick={() => void cancelCleanup()}>
              {i18n.t('ka784e3f9')}
              {st.cleanTotal ? ` ${st.cleanDone ?? 0}/${st.cleanTotal}` : ''}
            </button>
          ) : (
            <button
              className="btn sm"
              onClick={() => void cleanup()}
              title={i18n.t('k5ebdce42')}
            >
              {i18n.t('ka32d7e0c')}
            </button>
          )
        )}
        {!!st?.downloaded && (
          st.rebuilding ? (
            <button className="btn sm" onClick={() => void cancelRebuild()}>
              {i18n.t('k440a4644')}
              {st.rebuildTotal ? ` ${st.rebuildDone ?? 0}/${st.rebuildTotal}` : ''}
            </button>
          ) : (
            <button
              className="btn sm"
              disabled={!!st.cleaning || !!st.scanning}
              onClick={() => void rebuild()}
              title={i18n.t('k98136d03')}
            >
              {i18n.t('k32cd4641')}
            </button>
          )
        )}
        {st?.scanning ? (
          <button className="btn sm" onClick={() => void stop()}>
            {i18n.t('k9f6ffc8e')}
          </button>
        ) : (
          <>
            <button
              className="btn sm primary"
              disabled={!st?.downloaded || !!st?.downloading}
              onClick={() => void scan(false)}
              title={st?.downloaded ? '' : i18n.t('kd8158f66')}
            >
              {st && st.persons > 0 ? i18n.t('k69f86fd8') : i18n.t('k2890d381')}
            </button>
            {!!st?.persons && (
              <>
                <button
                  className="btn sm"
                  onClick={() => void scan(true)}
                  title={i18n.t('k6298e6f7')}
                >
                  {i18n.t('k48ccc87d')}
                </button>
                <button
                  className="btn sm"
                  onClick={() =>
                    void guard(async () => {
                      if (!window.confirm(i18n.t('k6135b5df'))) return;
                      await api.faceReset();
                      setActive(null);
                      setItems(null);
                      await refresh();
                      toastRef.current(i18n.t('k3f76cdcf'));
                    })
                  }
                  title={i18n.t('kd527df7b')}
                >
                  {i18n.t('k36d40a48')}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );

  /* ------------------------------ 未下载模型 ------------------------------ */
  if (st && !st.downloaded) {
    return (
      <div>
        {head}
        <div className="card" style={{ maxWidth: 640 }}>
          <h4 className="section-title">
            <IconUsers /> {i18n.t('k1992286b')}
          </h4>
          <p style={{ color: 'var(--muted)', lineHeight: 1.7, fontSize: 13 }}>
            ├─ {i18n.t('k340d0329')}
            <br />
            ├─ {i18n.t('k67090829')}
            <br />
            └─{' '}
            {i18n.t('kd427a9de')}
          </p>
          {st.downloading ? (
            <div style={{ marginTop: 12 }}>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${st.progress}%` }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
                <span>{st.message || i18n.t('k0164eeb4')}</span>
                <button className="btn sm" onClick={() => void guard(async () => { await api.faceInstallCancel(); })}>
                  {i18n.t('k625fb26b')}
                </button>
              </div>
            </div>
          ) : (
            <button className="btn sm primary" style={{ marginTop: 12 }} onClick={() => void install()}>
              <IconDownload /> {i18n.t('k5e737cf3')}
            </button>
          )}
          {st.error && (
            <div style={{ color: '#ff9a9a', fontSize: 12, marginTop: 8 }}>
              {i18n.t('k3656e6f7')}
              {st.error}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ------------------------------ 单人详情 ------------------------------ */
  if (active != null) {
    return (
      <div>
        {head}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '0 0 14px', flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => { setActive(null); setActivePerson(null); setItems(null); }}>
            ← {i18n.t('k1c212204')}
          </button>
          {renaming?.id === active ? (
            <>
              <input
                className="input"
                autoFocus
                value={renaming.value}
                style={{ width: 220, height: 32 }}
                placeholder={i18n.t('kc98563dc')}
                onChange={(e) => setRenaming({ id: active, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitRename();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
              <button className="btn sm primary" onClick={() => void submitRename()}>
                {i18n.t('kbe5fbbe3')}
              </button>
            </>
          ) : (
            <h3 style={{ margin: 0 }}>
              {current?.name || i18n.t('k5b02a0b4')}
              <button
                className="mini"
                style={{ marginLeft: 8 }}
                onClick={() => setRenaming({ id: active, value: current?.name || '' })}
              >
                {i18n.t('kd239370e')}
              </button>
            </h3>
          )}
          <span
            className="tag-pill"
            title={i18n.t('k8b2d6dd3')}
          >
            {i18n.t('k1648f8ae', { p0: current?.count ?? 0, p1: itemsTotal || current?.photoCount || 0 })}
          </span>
          <span style={{ flex: 1 }} />
          {persons.length > 1 && (
            <>
              {/*
                这串选项是「人物 #2949（126 张）」，比占位文字长得多：用自绘下拉，
                弹层固定不小于 200px、带搜索框，选中后按钮上的文字超长才省略，
                不会再出现原生下拉把名字和张数一起压掉的情况
              */}
              <Select
                value={mergeTo === '' ? '' : String(mergeTo)}
                onChange={(v) => setMergeTo(v === '' ? '' : Number(v))}
                title={i18n.t('k9f977b96')}
                style={{ height: 32, padding: '0 10px', minWidth: 168, maxWidth: 300 }}
              >
                <option value="">{i18n.t('k95144b30')}</option>
                {persons
                  .filter((p) => p.id !== active)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || i18n.t('kffab35b2', { p0: p.id })}（{p.photoCount ?? p.count} 张）
                    </option>
                  ))}
              </Select>
              <button className="btn sm" disabled={mergeTo === ''} onClick={() => void merge()}>
                {i18n.t('kbd81577a')}
              </button>
            </>
          )}
          <label
            className="people-size"
            title={i18n.t('kc0a1e7f7')}
          >
            <IconImages />
            <input
              type="range"
              min={PEOPLE_COL_MIN}
              max={PEOPLE_COL_MAX}
              step={10}
              value={colW}
              onChange={(e) => setColW(Number(e.target.value))}
              aria-label={i18n.t('ke9ef7e80')}
            />
          </label>
          <button
            className="btn sm"
            onClick={() => void removePerson()}
            title={i18n.t('k6ac21f4e')}
          >
            {i18n.t('k59af8fd9')}
          </button>
        </div>

        {loadingItems && <div style={{ padding: 30, color: 'var(--muted)' }}>{i18n.t('k62a33abd')}</div>}
        {!loadingItems && items && !items.length && (
          <div style={{ padding: 30, color: 'var(--muted)' }}>
            {i18n.t('k4e491c8b')}
          </div>
        )}
        {/*
          照片墙必须走 MasonryGrid 的窗口虚拟滚动：老实现是整个 items 一次性 map 成
          DOM，再配一个「只显示 2000 张」的上限挡住 —— 名人照片几千张时首屏就要排
          几千个 img，滚动掉帧且内存疯长。格子尺寸仍由 colW 滑块控制。
        */}
        <MasonryGrid
          items={items || []}
          colWidth={colW}
          renderItem={(it) => (
            <div
              className="people-tile"
              onContextMenu={(e) => {
                e.preventDefault();
                setPhotoCtx({ x: e.clientX, y: e.clientY, item: it });
              }}
            >
              <button
                {...previewHoverProps(it)}
                onClick={() => onOpen(it, items || [])}
                className="people-tile-img"
                title={it.title}
              >
                <img src={`${BASE}${it.thumbUrl}`} alt={it.title} loading="lazy" />
              </button>
              {current?.coverImageId === it.id ? (
                <span
                  className="people-tile-badge"
                  title={i18n.t('k60c58095')}
                >
                  {i18n.t('k227ce721')}
                </span>
              ) : (
                <button
                  className="people-tile-act"
                  onClick={() => void setCover(it.id)}
                  title={i18n.t('kd0de668d')}
                >
                  {i18n.t('k137f3c79')}
                </button>
              )}
            </div>
          )}
        />
        {!!items && itemsTotal > items.length && (
          <div className="hint" style={{ marginTop: 10 }}>
            {i18n.t('k0efb77bd', { p0: items.length, p1: itemsTotal })}
            {itemsLimit < 2000 && (
              <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => void loadMoreItems()}>
                {i18n.t('kc7043f10')}
              </button>
            )}
          </div>
        )}
        {overlays}
      </div>
    );
  }

  /* ------------------------------ 人物网格 ------------------------------ */
  return (
    <div>
      {head}

      {st?.downloading && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="progress-track" style={{ margin: 0 }}>
            <div className="progress-fill" style={{ width: `${st.progress}%` }} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{st.message}</div>
        </div>
      )}

      {st?.scanning && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12.5 }}>
            <IconUsers />
            <span>{i18n.t('kebd58151', { p0: st.pending })}</span>
            <span style={{ color: 'var(--muted)' }}>
              {i18n.t('k57fa61f8', { p0: st.faces, p1: st.persons })}
            </span>
          </div>
        </div>
      )}

      {!st && (
        <div className="card" style={{ padding: 36, textAlign: 'center', color: 'var(--muted)' }}>
          {loadError
            ? i18n.t('k4d343ded', { p0: loadError })
            : i18n.t('k8b0dd365')}
        </div>
      )}

      {!!st?.cleaning && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 12 }}>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${st.cleanTotal ? Math.round(((st.cleanDone ?? 0) / st.cleanTotal) * 100) : 0}%` }}
            />
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
            {st.cleanMessage || i18n.t('k1e204142')}
          </div>
          {!!whyText(st.cleanReasons) && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{whyText(st.cleanReasons)}</div>
          )}
        </div>
      )}

      {!!st?.rebuilding && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 12 }}>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${st.rebuildTotal ? Math.round(((st.rebuildDone ?? 0) / st.rebuildTotal) * 100) : 0}%` }}
            />
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
            {st.rebuildMessage || i18n.t('kf4ee693e')}
          </div>
        </div>
      )}

      {!!st && !st.cleaning && !st.rebuilding && (!!st.hiddenFaces || !!st.unassessedFaces) && (
        <div className="hint" style={{ margin: '0 0 12px' }}>
          {i18n.t('k8eeb8c33', { p0: st.hiddenFaces ?? 0 }) +
              i18n.t('k2f36d6c1')}
          {!!st.unassessedFaces &&
            i18n.t('kd92bc093', { p0: st.unassessedFaces })}
        </div>
      )}

      {!!st && !persons.length && (
        <div className="card" style={{ padding: 36, textAlign: 'center', color: 'var(--muted)' }}>
          <IconUsers />
          <div style={{ marginTop: 10, fontSize: 13.5 }}>
            {st.pending
              ? i18n.t('k1e7edfe7', { p0: st.pending })
              : st.weakCoverPersons
                ? i18n.t('k3d849b93', { p0: st.weakCoverPersons })
                : i18n.t('ka1620bc6')}
          </div>
          <div style={{ marginTop: 6, fontSize: 12 }}>
            {i18n.t('k766e316d')}
          </div>
        </div>
      )}

      {!!persons.length && (
        /*
          人物卡片也走窗口虚拟滚动：以前是 persons.map 全量铺 DOM，几千个人物时
          光首屏就要生成几千张封面图请求。extraHeight 是卡片下方两行文字的高度。
        */
        <VirtualGrid
          items={persons}
          keyOf={(p) => p.id}
          colWidth={132}
          gap={12}
          ratio={1}
          extraHeight={46}
          renderItem={(p) => (
            <button
              onClick={() => void openPerson(p)}
              onContextMenu={(e) => {
                e.preventDefault();
                setPersonCtx({ x: e.clientX, y: e.clientY, p });
              }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                width: '100%',
                height: '100%',
                padding: 0,
                border: '1px solid var(--line)',
                borderRadius: 10,
                overflow: 'hidden',
                background: 'var(--card)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
              title={`${p.name || `人物 #${p.id}`} · ${`${p.photoCount ?? p.count} 张照片 · ${p.count} 张人脸`}`}
            >
              <div style={{ flex: 1, minHeight: 0, background: '#111' }}>
                {p.coverFaceId ? (
                  <img
                    src={coverUrl(p)}
                    alt={p.name || i18n.t('kf2cbe035')}
                    loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
                    <IconImages />
                  </div>
                )}
              </div>
              <div style={{ padding: '7px 9px', flex: 'none' }}>
                <div style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name || i18n.t('kffab35b2', { p0: p.id })}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {i18n.t('kdaae3512', { p0: p.photoCount ?? p.count })}
                </div>
              </div>
            </button>
          )}
        />
      )}
      {personsTotal > persons.length && (
        <div className="hint" style={{ marginTop: 12 }}>
          {i18n.t('k16174d87', { p0: persons.length, p1: personsTotal })}
          {personsLimit < 2000 && (
            <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setPersonsLimit((n) => Math.min(2000, n + 500))}>
              {i18n.t('kc7043f10')}
            </button>
          )}
        </div>
      )}
      {overlays}
    </div>
  );
}
