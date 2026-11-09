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
import { api, BASE, type FacePerson, type FaceStatus } from '../api';
import type { ImageItem } from '../types';
import { IconDownload, IconImages, IconUsers } from '../components/Icons';
import { useLang } from '../lib/i18n';

type Props = {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  onOpen: (item: ImageItem, pool?: ImageItem[]) => void;
};

/** 同人阈值预设：值越低越容易合并，也越容易把路人并给同一个人 */
/** 选项文字要能完整塞进下拉框：收起态被裁掉的数字最容易被误读成「显示不全」 */
const COS_PRESETS = [
  { v: 0.5, zh: '严格（0.50）· 宁可分开', en: 'Strict (0.50) · keep apart' },
  { v: 0.42, zh: '标准（0.42）', en: 'Standard (0.42)' },
  { v: 0.35, zh: '宽松（0.35）· 更易合并', en: 'Loose (0.35) · easier to merge' },
];

export default function People({ onToast, onOpen }: Props) {
  const { lang } = useLang();
  /** 双语取词：英文缺失时回退中文，不显示空串 */
  const L = (zh: string, en: string) => (lang === 'en' && en ? en : zh);
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
      toastRef.current(`读取人脸状态失败：${(err as Error).message}`, 'error');
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
      if (st?.cleanError) toastRef.current(`清理失败：${st.cleanError}`, 'error');
      else if (st?.cleanMessage) toastRef.current(st.cleanMessage);
      void refresh();
    }
    prevCleaning.current = !!st?.cleaning;
  }, [st?.cleaning, st?.cleanError, st?.cleanMessage, refresh]);

  // 重建结束时同理：只说「重建完成」，不刷新列表的话屏幕上还是旧分组
  const prevRebuilding = useRef(false);
  useEffect(() => {
    if (prevRebuilding.current && !st?.rebuilding) {
      if (st?.rebuildError) toastRef.current(`重建失败：${st.rebuildError}`, 'error');
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
      toastRef.current((err as Error).message || '操作失败', 'error');
    }
  };

  const install = () =>
    guard(async () => {
      const r = await api.faceInstall();
      setSt(r);
      toastRef.current('开始下载人脸模型（约 191MB），可在任务中心查看进度');
    });

  const scan = (force: boolean) =>
    guard(async () => {
      if (force && !window.confirm('清空已识别的人脸并重新聚类？已起的人物名会一起清掉。')) return;
      const r = await api.faceScan({ force, minCos: cos });
      setSt(r);
      if (active != null) setActive(null);
      toastRef.current(force ? '已开始重新扫描全库' : '已开始扫描');
    });

  const stop = () =>
    guard(async () => {
      await api.faceScanCancel();
      toastRef.current('已请求停止扫描，正在收尾…');
      void refresh();
    });

  // 存量重算：老数据没有质量分、封面是「第一张脸」时代选的，这里一次性回填并重选
  const cleanup = () =>
    guard(async () => {
      const r = await api.faceQualityCleanup();
      setSt(r);
      if (r.busy) toastRef.current('扫描正在进行，等它结束后再清理（扫描本身也按质量门槛建组）');
      else toastRef.current('已开始清理模糊人脸并重选封面（可随时取消）');
      void refresh();
    });

  const cancelCleanup = () =>
    guard(async () => {
      await api.faceQualityCancel();
      toastRef.current('已请求取消清理，正在收尾…');
    });

  // 全局重建：只用库里已有的特征重新聚类，能一次性清掉「一堆后脑勺凑成一个人」这类历史误分
  const rebuild = () =>
    guard(async () => {
      const ok = window.confirm(
        '重建人物分组？\n\n会按现有特征重新聚类，解散明显不可信的簇（例如全是后脑勺/耳朵的「人物」），并按清晰度和尺寸重选封面。已命名的人物会尽量保留名字。'
      );
      if (!ok) return;
      const r = await api.faceRebuild();
      setSt(r);
      toastRef.current('已开始重建人物分组');
      void refresh();
    });

  const cancelRebuild = () =>
    guard(async () => {
      await api.faceRebuildCancel();
      toastRef.current('已请求取消重建，正在收尾…');
    });

  const openPerson = (p: FacePerson) =>
    guard(async () => {
      setActive(p.id);
      setActivePerson(p);
      setItems(null);
      setItemsLimit(500);
      setItemsTotal(0);
      setLoadingItems(true);
      try {
        const r = await api.facePersonItems(p.id, { limit: 500 });
        setItems(r.items);
        setItemsTotal(r.total ?? r.items.length);
      } finally {
        setLoadingItems(false);
      }
    });

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
      toastRef.current(`已合并 ${r.moved} 张人脸`);
      setMergeTo('');
      setActive(Number(mergeTo));
      await refresh();
      const t = persons.find((p) => p.id === Number(mergeTo));
      if (t) await openPerson(t);
    });

  const removePerson = () =>
    guard(async () => {
      if (active == null) return;
      if (!window.confirm('把这个人物删掉？该人物的所有人脸记录会被清除（图片本身不受影响）。')) return;
      await api.faceDeletePerson(active);
      setActive(null);
      setItems(null);
      await refresh();
    });

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
      toastRef.current(L('已设为封面（之后的扫描不会自动换掉）', 'Cover set — future scans will not replace it'));
    });

  const current = persons.find((p) => p.id === active) || activePerson;
  // 列表刷新后（清理/合并/重算）用最新数据覆盖快照，别让详情页停在旧数字上
  useEffect(() => {
    if (active == null) return;
    const hit = persons.find((p) => p.id === active);
    if (hit) setActivePerson(hit);
  }, [persons, active]);
  const coverUrl = (p: FacePerson) => (p.coverFaceId ? `${BASE}/api/face/crop/${p.coverFaceId}?size=224` : '');

  /* ------------------------------ 顶部状态条 ------------------------------ */
  const head = (
    <div className="page-head">
      <div>
        <h1 className="page-title">{L('人物', 'People')}</h1>
        <div className="page-sub">
          {L('本地识别照片里的人脸并按人分组 · 全流程离线，模型跑在本机', 'Group faces by person, fully offline — the model runs on your machine')}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {st?.downloaded && (
          // 以前只有一个裸 select，含义全藏在 hover 提示里；加可见标签与稳定宽度，
          // 免得窄窗口/系统缩放下选中项文字被裁掉，看起来像「显示不全」
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
            {L('同人阈值', 'Grouping')}
            <select
              className="input"
              value={cos}
              onChange={(e) => setCos(Number(e.target.value))}
              title={L(
                '同一个人判定的严格程度，改完需要「清空并重扫」才会对已有结果生效',
                'How strict "same person" is. Re-cluster (clear & rescan) for existing results to follow.'
              )}
              style={{ height: 32, minWidth: 176, paddingRight: 26 }}
            >
              {COS_PRESETS.map((o) => (
                <option key={o.v} value={o.v}>
                  {L(o.zh, o.en)}
                </option>
              ))}
            </select>
          </label>
        )}
        {!!st?.weakCoverPersons && (
          <button
            className={`btn sm${showAllPersons ? ' primary' : ''}`}
            onClick={() => setShowAllPersons((v) => !v)}
            title={L(
              '封面脸不够清晰的人物（多半只有一两张糊脸、甚至是误检）默认折叠，免得糊脸占满人物页',
              'People whose best face is still soft are folded away by default'
            )}
          >
            {showAllPersons
              ? L('只看清晰封面', 'Sharp covers only')
              : L(
                  `显示全部人物（另有 ${st.weakCoverPersons} 人封面不清晰）`,
                  `Show all (+${st.weakCoverPersons} soft covers)`
                )}
          </button>
        )}
        {st?.downloaded && !st.scanning && (
          st.cleaning ? (
            <button className="btn sm" onClick={() => void cancelCleanup()}>
              {L('取消清理', 'Cancel cleanup')}
              {st.cleanTotal ? ` ${st.cleanDone ?? 0}/${st.cleanTotal}` : ''}
            </button>
          ) : (
            <button
              className="btn sm"
              onClick={() => void cleanup()}
              title={L(
                '按质量门槛重新检查已检出的人脸，自动排除模糊/过小/后脑勺，并按清晰度与尺寸重选每个人的封面',
                'Re-check every detected face, auto-exclude blurry/tiny/back-of-head crops, and re-pick each cover by sharpness and size'
              )}
            >
              {L('清理模糊人脸', 'Clean blurry faces')}
            </button>
          )
        )}
        {!!st?.downloaded && (
          st.rebuilding ? (
            <button className="btn sm" onClick={() => void cancelRebuild()}>
              {L('取消重建', 'Cancel rebuild')}
              {st.rebuildTotal ? ` ${st.rebuildDone ?? 0}/${st.rebuildTotal}` : ''}
            </button>
          ) : (
            <button
              className="btn sm"
              disabled={!!st.cleaning || !!st.scanning}
              onClick={() => void rebuild()}
              title={L(
                '按现有特征重新聚类，解散「一堆后脑勺凑成一个人」这类不可信的簇，并按清晰度与尺寸重选封面（不解码图片，通常十几秒）',
                'Re-cluster from stored embeddings, dissolve untrustworthy clusters (e.g. a "person" made of back-of-heads), and re-pick covers'
              )}
            >
              {L('重建分组', 'Rebuild groups')}
            </button>
          )
        )}
        {st?.scanning ? (
          <button className="btn sm" onClick={() => void stop()}>
            {L('停止扫描', 'Stop')}
          </button>
        ) : (
          <>
            <button
              className="btn sm primary"
              disabled={!st?.downloaded || !!st?.downloading}
              onClick={() => void scan(false)}
              title={st?.downloaded ? '' : L('需要先下载模型', 'Download the model first')}
            >
              {st && st.persons > 0 ? L('扫描新增素材', 'Scan new') : L('扫描全库', 'Scan library')}
            </button>
            {!!st?.persons && (
              <>
                <button
                  className="btn sm"
                  onClick={() => void scan(true)}
                  title={L('清空人脸数据后按当前阈值重新聚类', 'Clear face data and re-cluster with the current threshold')}
                >
                  {L('清空并重扫', 'Re-cluster')}
                </button>
                <button
                  className="btn sm"
                  onClick={() =>
                    void guard(async () => {
                      if (!window.confirm('清空全部人脸与人物数据？图片、标签、评分都不受影响。')) return;
                      await api.faceReset();
                      setActive(null);
                      setItems(null);
                      await refresh();
                      toastRef.current(L('已清空人脸数据', 'Face data cleared'));
                    })
                  }
                  title={L('只清空人脸记录，不重新扫描', 'Remove face records without rescanning')}
                >
                  {L('清空数据', 'Clear data')}
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
            <IconUsers /> {L('需要先下载人脸模型', 'Face model required')}
          </h4>
          <p style={{ color: 'var(--muted)', lineHeight: 1.7, fontSize: 13 }}>
            ├─ {L('检测：SCRFD det_10g（约 17MB）', 'Detection: SCRFD det_10g (~17MB)')}
            <br />
            ├─ {L('特征：ArcFace w600k_r50（约 174MB，512 维）', 'Embedding: ArcFace w600k_r50 (~174MB, 512-d)')}
            <br />
            └─{' '}
            {L(
              '全部本地推理，照片不会上传；权重会按随包的可信哈希清单逐字节校验',
              'All inference is local; photos never leave this machine. Weights are verified byte-for-byte against the bundled hash list.'
            )}
          </p>
          {st.downloading ? (
            <div style={{ marginTop: 12 }}>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${st.progress}%` }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
                <span>{st.message || L('下载中…', 'Downloading…')}</span>
                <button className="btn sm" onClick={() => void guard(async () => { await api.faceInstallCancel(); })}>
                  {L('取消', 'Cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button className="btn sm primary" style={{ marginTop: 12 }} onClick={() => void install()}>
              <IconDownload /> {L('下载模型（约 191MB）', 'Download model (~191MB)')}
            </button>
          )}
          {st.error && (
            <div style={{ color: '#ff9a9a', fontSize: 12, marginTop: 8 }}>
              {L('上次失败：', 'Last attempt failed: ')}
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
            ← {L('全部人物', 'All people')}
          </button>
          {renaming?.id === active ? (
            <>
              <input
                className="input"
                autoFocus
                value={renaming.value}
                style={{ width: 220, height: 32 }}
                placeholder={L('给他/她起个名字', 'Give this person a name')}
                onChange={(e) => setRenaming({ id: active, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitRename();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
              <button className="btn sm primary" onClick={() => void submitRename()}>
                {L('保存', 'Save')}
              </button>
            </>
          ) : (
            <h3 style={{ margin: 0 }}>
              {current?.name || L('未命名人物', 'Unnamed person')}
              <button
                className="mini"
                style={{ marginLeft: 8 }}
                onClick={() => setRenaming({ id: active, value: current?.name || '' })}
              >
                {L('改名', 'Rename')}
              </button>
            </h3>
          )}
          <span
            className="tag-pill"
            title={L(
              '人脸数和照片数是两回事：一张合影里同一个人出现两次算两张脸、但只算一张照片',
              'Faces and photos are different: the same person twice in one shot counts as 2 faces, 1 photo'
            )}
          >
            {L(
              `${current?.count ?? 0} 张人脸 · ${itemsTotal || current?.photoCount || 0} 张照片`,
              `${current?.count ?? 0} faces · ${itemsTotal || current?.photoCount || 0} photos`
            )}
          </span>
          <span style={{ flex: 1 }} />
          {persons.length > 1 && (
            <>
              <select className="input" value={mergeTo} onChange={(e) => setMergeTo(e.target.value === '' ? '' : Number(e.target.value))} style={{ height: 32 }}>
                <option value="">{L('合并到…', 'Merge into…')}</option>
                {persons
                  .filter((p) => p.id !== active)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || L(`人物 #${p.id}`, `Person #${p.id}`)}（{p.photoCount ?? p.count} 张）
                    </option>
                  ))}
              </select>
              <button className="btn sm" disabled={mergeTo === ''} onClick={() => void merge()}>
                {L('合并', 'Merge')}
              </button>
            </>
          )}
          <button
            className="btn sm"
            onClick={() => void removePerson()}
            title={L('这个人物分错了：清掉他的全部人脸记录', 'Wrong grouping: remove every face record of this person')}
          >
            {L('删除该人物', 'Delete person')}
          </button>
        </div>

        {loadingItems && <div style={{ padding: 30, color: 'var(--muted)' }}>{L('正在读取…', 'Loading…')}</div>}
        {!loadingItems && items && !items.length && (
          <div style={{ padding: 30, color: 'var(--muted)' }}>
            {L('这个人目前没有可显示的图片（可能原图已被移出图库）。', 'No images to show — the originals may have been moved out of the library.')}
          </div>
        )}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
            gap: 8,
          }}
        >
          {(items || []).map((it) => (
            <div key={it.id} className="people-tile">
              <button
                onClick={() => onOpen(it, items || [])}
                className="people-tile-img"
                title={it.title}
              >
                <img src={`${BASE}${it.thumbUrl}`} alt={it.title} loading="lazy" />
              </button>
              {current?.coverImageId === it.id ? (
                <span
                  className="people-tile-badge"
                  title={L('这张正在当封面', 'This photo is the cover')}
                >
                  {L('当前封面', 'Cover')}
                </span>
              ) : (
                <button
                  className="people-tile-act"
                  onClick={() => void setCover(it.id)}
                  title={L(
                    '用这张照片当这个人的封面（设完锁定，扫描不会自动换）',
                    'Use this photo as the cover (locked, scans will not replace it)'
                  )}
                >
                  {L('设为封面', 'Set cover')}
                </button>
              )}
            </div>
          ))}
        </div>
        {!!items && itemsTotal > items.length && (
          <div className="hint" style={{ marginTop: 10 }}>
            {L(`只显示了 ${items.length} / ${itemsTotal} 张图片`, `Showing ${items.length} of ${itemsTotal} images`)}
            {itemsLimit < 2000 && (
              <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => void loadMoreItems()}>
                {L('显示更多', 'Show more')}
              </button>
            )}
          </div>
        )}
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
            <span>{L(`正在扫描：还剩 ${st.pending} 张未扫`, `Scanning: ${st.pending} left`)}</span>
            <span style={{ color: 'var(--muted)' }}>
              {L(`已识别 ${st.faces} 张人脸 / ${st.persons} 个人物`, `${st.faces} faces · ${st.persons} people`)}
            </span>
          </div>
        </div>
      )}

      {!st && (
        <div className="card" style={{ padding: 36, textAlign: 'center', color: 'var(--muted)' }}>
          {loadError
            ? L(`读取人脸状态失败：${loadError}（请刷新页面重试）`, `Failed to load face status: ${loadError}. Refresh to retry.`)
            : L('正在读取人脸状态…', 'Loading face status…')}
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
            {st.cleanMessage || L('正在重算人脸质量…', 'Re-checking face quality…')}
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
            {st.rebuildMessage || L('正在重建人物分组…', 'Rebuilding people…')}
          </div>
        </div>
      )}

      {!!st && !st.cleaning && !st.rebuilding && (!!st.hiddenFaces || !!st.unassessedFaces) && (
        <div className="hint" style={{ margin: '0 0 12px' }}>
          {L(
            `已自动排除 ${st.hiddenFaces ?? 0} 张不可用的人脸（模糊 / 过小 / 没纹理 / 后脑勺），不显示、不参与聚类；` +
              '其余只是不够清晰的脸照常显示，但不会当选封面。点开人物后，照片上悬停可以手动「设为封面」',
            `${st.hiddenFaces ?? 0} unusable faces excluded (blurry / tiny / flat / back-of-head) — hidden and not clustered; ` +
              'soft-but-usable faces still show, they just never become the cover. Open a person and hover a photo to pick the cover manually'
          )}
          {!!st.unassessedFaces &&
            L(
              `；另有 ${st.unassessedFaces} 张老数据还没有质量分，点「清理模糊人脸」回填`,
              `; ${st.unassessedFaces} older faces have no quality score yet — hit "Clean blurry faces" to backfill`
            )}
        </div>
      )}

      {!!st && !persons.length && (
        <div className="card" style={{ padding: 36, textAlign: 'center', color: 'var(--muted)' }}>
          <IconUsers />
          <div style={{ marginTop: 10, fontSize: 13.5 }}>
            {st.pending
              ? L(
                  `还有 ${st.pending} 张素材未扫描 — 点右上角「扫描全库」开始`,
                  `${st.pending} items not scanned yet — hit "Scan library" at the top right`
                )
              : st.weakCoverPersons
                ? L(
                    `已识别 ${st.weakCoverPersons} 个人物，但他们的封面脸都不够清晰 —— 点上方「显示全部人物」查看`,
                    `${st.weakCoverPersons} people found, but none has a sharp enough cover — hit "Show all" above`
                  )
                : L('还没有识别到人脸', 'No faces found yet')}
          </div>
          <div style={{ marginTop: 6, fontSize: 12 }}>
            {L('扫过的照片会被记住，下次只处理新增素材', 'Scanned photos are remembered, so later runs only touch new items')}
          </div>
        </div>
      )}

      {!!persons.length && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
            gap: 12,
          }}
        >
          {persons.map((p) => (
            <button
              key={p.id}
              onClick={() => void openPerson(p)}
              style={{
                padding: 0,
                border: '1px solid var(--line)',
                borderRadius: 10,
                overflow: 'hidden',
                background: 'var(--card)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
              title={`${p.name || L(`人物 #${p.id}`, `Person #${p.id}`)} · ${L(
                `${p.photoCount ?? p.count} 张照片 · ${p.count} 张人脸`,
                `${p.photoCount ?? p.count} photos · ${p.count} faces`
              )}`}
            >
              <div style={{ aspectRatio: '1 / 1', background: '#111' }}>
                {p.coverFaceId ? (
                  <img
                    src={coverUrl(p)}
                    alt={p.name || '人脸'}
                    loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
                    <IconImages />
                  </div>
                )}
              </div>
              <div style={{ padding: '7px 9px' }}>
                <div style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name || L(`人物 #${p.id}`, `Person #${p.id}`)}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {L(`${p.photoCount ?? p.count} 张照片`, `${p.photoCount ?? p.count} photos`)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {personsTotal > persons.length && (
        <div className="hint" style={{ marginTop: 12 }}>
          {L(`只显示了 ${persons.length} / ${personsTotal} 个人物`, `Showing ${persons.length} of ${personsTotal} people`)}
          {personsLimit < 2000 && (
            <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setPersonsLimit((n) => Math.min(2000, n + 500))}>
              {L('显示更多', 'Show more')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
