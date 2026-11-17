import { IconStar, IconPencil, IconWand, IconClose, IconSearch, IconStack } from '../Icons';
/**
 * 大图详情面板：一行摘要 + 可折叠的分组详情（基本信息 / 归类整理 / 颜色与智能）。
 *
 * 之前是十几个 meta-item 平铺，分辨率、大小、来源、星级、备注、色板、AI 识图、路径、标签
 * 全挤在同一行，找什么都得扫一遍。现在默认只留「一眼就要知道」的摘要，
 * 编辑型字段（文件夹 / 星级 / 备注 / 标签 / 色板 / AI）收进按组排列的详情。
 */
import type { Dispatch, SetStateAction } from 'react';
import type { ImageItem } from '../../types';
import {
  api,
  BUCKET_LABELS,
  SOURCE_LABELS,
  formatDate,
  formatSize,
  revealFile,
} from '../../api';
import { buildASE, buildPngSheet, downloadBlob } from '../../lib/palette';
import NotesPanel from './NotesPanel';
import FaceChips from './FaceChips';
import i18n from '../../i18n';

interface Props {
  item: ImageItem;
  /** 详情区是否展开（由 Lightbox 持有，顶栏「信息」按钮也控制它） */
  open: boolean;
  /** 当前资源库（多库并存时，用户最容易搞不清这张图到底在哪个库） */
  library?: { id?: string; name: string; path: string } | null;
  onToggle: () => void;
  isImage: boolean;
  imgFolders: { id: number; name: string; parent_id: number | null; path: string }[];
  setImgFolders: Dispatch<SetStateAction<Props['imgFolders']>>;
  onPatch?: (item: ImageItem, patch: Partial<ImageItem>) => void;
  onChangeToast?: (msg: string) => void;
  onFindColor?: (hue: string) => void;
  /** 打开「外部以图找图」面板（SauceNAO / Google Lens / TinEye…） */
  onOpenSource?: () => void;
  /** 打开堆叠查看器（看同素材的其他版本） */
  onOpenStack?: () => void;
  /** 跳到图库并只看某个文件夹（点归属文件夹的夹名就走这里） */
  onOpenFolder?: (folderId: number) => void;
  /** 点「人物 #123」：跳到人物页并打开这个人的照片墙 */
  onGotoPerson?: (personId: number) => void;
  onSaveTags: (item: ImageItem, tags: string[]) => void;
  tagInput: string;
  setTagInput: (v: string) => void;
  addTag: () => void;
  paletteColors: string[];
  simOpen: boolean;
  onToggleSim: () => void;
  aiDesc: { description?: string; issues?: string[]; quality?: number } | null;
  setAiDesc: Dispatch<SetStateAction<Props['aiDesc']>>;
  aiBusy: boolean;
  setAiBusy: (v: boolean) => void;
}

/** 导出用的安全文件名（去掉扩展名与非法字符） */
const safeName = (t: string) =>
  t.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) || 'palette';

/** 从标题取扩展名（ImageItem 没有单独的 ext 字段） */
const extOf = (title: string) => {
  const m = /\.([a-z0-9]{2,5})$/i.exec(title || '');
  return m ? m[1].toUpperCase() : '';
};

export default function InfoPanel({
  item,
  open,
  library,
  onToggle,
  isImage,
  imgFolders,
  setImgFolders,
  onPatch,
  onChangeToast,
  onFindColor,
  onOpenSource,
  onOpenStack,
  onOpenFolder,
  onGotoPerson,
  onSaveTags,
  tagInput,
  setTagInput,
  addTag,
  paletteColors,
  simOpen,
  onToggleSim,
  aiDesc,
  setAiDesc,
  aiBusy,
  setAiBusy,
}: Props) {
  const ext = extOf(item.title);
  const hueKeyOf = () => {
    const first = (item.hue || '').split(',').filter(Boolean)[0];
    // 黑白灰图没有色相（hue 为空）：仍然给出入口，按「黑白灰」筛选
    return first !== undefined ? first : item.dominant ? 'gray' : '';
  };
  const hueKey = hueKeyOf();

  return (
    <div className="lightbox-info" onClick={(e) => e.stopPropagation()}>
      {/* 摘要：不展开也能看清这是什么图、多大、什么时候来的、几星 */}
      <div className="lb-sum">
        <span className="lb-sum-main">
          {isImage ? `${item.width} × ${item.height}` : (item.mediaKind || 'file').toUpperCase()}
        </span>
        {isImage && ext && <span className="lb-sum-pill">{ext}</span>}
        {!isImage && item.duration > 0 && (
          <span className="lb-sum-dim">{Math.round(item.duration)} 秒</span>
        )}
        {isImage && <span className="lb-sum-pill">{BUCKET_LABELS[item.bucket]}</span>}
        {item.enhanced && (
          <span
            className="enhanced-tag"
            title={i18n.t('k99d9366e')}
          >
            <IconWand size={12} /> 已增强 {item.enhanceScale}×（原 {item.originalWidth}×{item.originalHeight}）
          </span>
        )}
        <span className="lb-sum-dim">{formatSize(item.sizeBytes)}</span>
        <span className="lb-sum-sep" />
        <span className="lb-sum-dim">{SOURCE_LABELS[item.source] || item.source}</span>
        <span className="lb-sum-sep" />
        <span className="lb-sum-dim">{formatDate(item.createdAt)}</span>
        {(item.stackCount || 0) > 1 && (
          <span
            className="lb-sum-pill"
            style={{ cursor: onOpenStack ? 'pointer' : 'default' }}
            title={i18n.t('kee91860d', { p0: item.stackCount })}
            onClick={onOpenStack}
          >
            <IconStack size={13} /> {item.stackCount}
          </span>
        )}
        <span className="lb-sum-sep" />
        <span className="stars lb-sum-stars">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              className={`star${(item.rating || 0) >= n ? ' on' : ''}`}
              title={i18n.t('k2409dbfd', { p0: n })}
              aria-pressed={(item.rating || 0) === n}
              aria-label={i18n.t('k455aeb45', { p0: n })}
              onClick={() => onPatch?.(item, { rating: item.rating === n ? 0 : n })}
            >
              <IconStar size={13} />
            </button>
          ))}
        </span>
        {!!item.note && (
          <span className="lb-sum-note" title={item.note}>
            <IconPencil size={12} /> {item.note}
          </span>
        )}
        {!!item.tags.length && (
          <span className="lb-sum-tags" title={item.tags.join('、')}>
            {item.tags.map((t) => `#${t}`).join(' ')}
          </span>
        )}
        <button className="lb-sum-toggle" onClick={onToggle} title={i18n.t('k9f0e5026')}>
          {open ? i18n.t('ka08fbc3d') : i18n.t('k57948478')}
        </button>
      </div>

      {open && (
        <div className="lb-groups">
          <section className="lb-group">
            <h5>基本信息</h5>
            <div className="lb-kv">
              <b>{isImage ? i18n.t('k874a5816') : i18n.t('k5bab3781')}</b>
              <span>
                {isImage ? (
                  <>
                    {item.width} × {item.height}
                    {ext ? ` · ${ext}` : ''} · {BUCKET_LABELS[item.bucket]}
                  </>
                ) : (
                  <>
                    {(item.mediaKind || 'file').toUpperCase()}
                    {item.duration > 0 ? i18n.t('k744ab13d', { p0: Math.round(item.duration) }) : ''}
                    {item.md5 ? ` · MD5 ${item.md5.slice(0, 8)}` : ''}
                  </>
                )}
              </span>
            </div>
            <div className="lb-kv">
              <b>文件大小</b>
              <span>{formatSize(item.sizeBytes)}</span>
            </div>
            <div className="lb-kv">
              <b>所属资源库</b>
              <span>
                {library ? (
                  <>
                    <span
                      className="lb-link"
                      title={i18n.t('kf368c6bb', { p0: library.name, p1: library.path ? `\n${library.path}` : '' })}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(library.path);
                          onChangeToast?.(i18n.t('k001640a9', { p0: library.path }));
                        } catch {
                          onChangeToast?.(library.path || library.name);
                        }
                      }}
                    >
                      {library.name}
                    </span>
                    {library.path ? (
                      <span
                        className="lb-lib-path is-clickable"
                        title={i18n.t('kfc744ac1', { p0: library.path })}
                        onClick={() =>
                          revealFile(library.path).catch((err) =>
                            onChangeToast?.(i18n.t('k9cd07541', { p0: (err as Error).message }))
                          )
                        }
                      >
                        {library.path}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="lb-kv-empty">读取中…</span>
                )}
              </span>
            </div>
            <div className="lb-kv">
              <b>采集来源</b>
              <span>
                {SOURCE_LABELS[item.source] || item.source}
                {item.keyword ? ` · ${item.keyword}` : ''}
              </span>
            </div>
            <div className="lb-kv">
              <b>采集时间</b>
              <span>{formatDate(item.createdAt)}</span>
            </div>
            <div className="lb-kv">
              <b>浏览情况</b>
              <span>{item.viewCount ? i18n.t('k44149c53', { p0: item.viewCount }) : i18n.t('k8e63d8eb')}</span>
            </div>
            <div className="lb-kv">
              <b>使用统计</b>
              <span>
                {item.copyCount || item.exportCount
                  ? i18n.t('k702ac552', { p0: item.copyCount || 0, p1: item.exportCount || 0, p2: item.lastUsedAt ? i18n.t('k9796a0a3', { p0: formatDate(item.lastUsedAt) }) : '' })
                  : i18n.t('ka13e4fd2')}
              </span>
            </div>
            <div className="lb-kv">
              <b>本地文件</b>
              <span
                className="lb-link"
                title={i18n.t('k6d89daf9', { p0: item.path || '' })}
                onClick={() =>
                  revealFile(item.path).catch((err) =>
                    onChangeToast?.(i18n.t('k22c7225f', { p0: (err as Error).message }))
                  )
                }
              >
                {item.path ? item.path.replace(/^.*[\\/]/, '') : '—'}
              </span>
            </div>
          </section>

          {/* 没有检出人脸时整块不渲染，不给空标题占高度 */}
          <FaceChips imageId={item.id} onToast={(m) => onChangeToast?.(m)} onGotoPerson={onGotoPerson} />

          <section className="lb-group">
            <h5>归类整理</h5>
            <div className="lb-kv">
              <b>文件夹</b>
              <span>
                {imgFolders.length ? (
                  <span className="lb-folder-chips">
                    {imgFolders.map((f) => (
                      <span
                        key={f.id}
                        className="lb-folder-chip"
                        title={i18n.t('k65b7bdd2')}
                      >
                        {/* 夹名本身就是最好的入口：用户看到「第一次完整导出.jpg」这类夹名，
                            想的就是去这夹里看这张图，不该只给一个移出的 × */}
                        {onOpenFolder ? (
                          <button
                            className="lb-folder-open"
                            title={i18n.t('kd07ceb8f', { p0: f.name })}
                            onClick={() => onOpenFolder(f.id)}
                          >
                            {f.name}
                          </button>
                        ) : (
                          f.name
                        )}
                        <button
                          className="lb-folder-x"
                          title={i18n.t('k45e6bd1b', { p0: f.name })}
                          onClick={async () => {
                            try {
                              await api.removeFromFolder(f.id, [item.id]);
                              setImgFolders((prev) => prev.filter((x) => x.id !== f.id));
                              onChangeToast?.(i18n.t('kb3435cd3', { p0: f.name }));
                            } catch (err) {
                              onChangeToast?.(i18n.t('k33d2d003', { p0: (err as Error).message }));
                            }
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="lb-kv-empty">未归入任何文件夹</span>
                )}
              </span>
            </div>
            <div className="lb-kv">
              <b>标签</b>
              <div className="tag-editor">
                {item.tags.map((t) => (
                  <span className="tag-pill" key={t}>
                    {t}
                    <button onClick={() => onSaveTags(item, item.tags.filter((x) => x !== t))}>
                      ×
                    </button>
                  </span>
                ))}
                <input
                  className="input input-sm"
                  placeholder={i18n.t('k2ee656f3')}
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addTag();
                  }}
                />
                <button className="btn sm" onClick={addTag}>
                  添加
                </button>
              </div>
            </div>
            {!!item.inheritedTags?.length && (
              <div className="lb-kv">
                <b>继承标签</b>
                <span className="tag-editor">
                  {item.inheritedTags.map((t) => (
                    <span className="tag-pill inherited" key={t} title={i18n.t('kd6b1cd7c')}>
                      {t}
                    </span>
                  ))}
                </span>
              </div>
            )}
            <div className="lb-kv">
              <b>我的星级</b>
              <span className="stars">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    className={`star${(item.rating || 0) >= n ? ' on' : ''}`}
                    title={i18n.t('k2409dbfd', { p0: n })}
                    onClick={() => onPatch?.(item, { rating: item.rating === n ? 0 : n })}
                  >
                    <IconStar size={13} />
                  </button>
                ))}
                {!!item.rating && (
                  <button className="star-clear" onClick={() => onPatch?.(item, { rating: 0 })}>
                    清除
                  </button>
                )}
              </span>
            </div>
            <div className="lb-kv">
              <b>我的备注</b>
              <input
                key={item.id}
                className="input input-sm"
                placeholder={i18n.t('kddaa9c1f')}
                defaultValue={item.note}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onPatch?.(item, { note: (e.target as HTMLInputElement).value });
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                onBlur={(e) => {
                  if (e.target.value !== item.note) onPatch?.(item, { note: e.target.value });
                }}
              />
            </div>
            <NotesPanel imageId={item.id} duration={item.duration} onToast={onChangeToast} />
          </section>

          <section className="lb-group">
            <h5>颜色与智能</h5>
            <div className="lb-kv">
              <b>主色系</b>
              <span className="lb-kv-row">
                <span
                  className="color-chip"
                  style={{ background: item.dominant || 'rgba(255,255,255,0.15)' }}
                  title={item.dominant || i18n.t('k6d337a66')}
                />
                <span className="lb-mono">{item.dominant || '—'}</span>
                {onFindColor && !!hueKey && (
                  <button
                    className="btn sm ghost"
                    title={
                      hueKey === 'gray'
                        ? i18n.t('kdf71af13')
                        : i18n.t('kdbc9c974')
                    }
                    onClick={() => onFindColor(hueKey)}
                  >
                    找同色系
                  </button>
                )}
                {!!paletteColors.length && (
                  <>
                    <button
                      className="btn sm ghost"
                      title={i18n.t('kec023270', { p0: paletteColors.length })}
                      onClick={() =>
                        downloadBlob(
                          buildASE(paletteColors, item.title.replace(/\.[^.]+$/, '')),
                          `${safeName(item.title)}.ase`,
                        )
                      }
                    >
                      ASE
                    </button>
                    <button
                      className="btn sm ghost"
                      title={i18n.t('k82f7e270')}
                      onClick={async () => {
                        try {
                          downloadBlob(
                            await buildPngSheet(paletteColors),
                            `${safeName(item.title)}.png`,
                          );
                        } catch {
                          onChangeToast?.(i18n.t('kd531b1f8'));
                        }
                      }}
                    >
                      PNG
                    </button>
                  </>
                )}
              </span>
            </div>
            <div className="lb-kv">
              <b>找相似</b>
              <span>
                <button
                  className={`btn sm${simOpen ? ' primary' : ''}`}
                  onClick={onToggleSim}
                  title={i18n.t('kb6c7b4e1')}
                >
                  {simOpen ? (<><IconClose size={12} /> 收起面板</>) : (<><IconSearch size={12} /> 找相似</>)}
                </button>
              </span>
            </div>
            {onOpenSource && (
              <div className="lb-kv">
                <b>外部搜图</b>
                <span>
                  <button
                    className="btn sm"
                    onClick={onOpenSource}
                    title={i18n.t('k05155801')}
                  >
                    <IconSearch size={12} /> 以图找图
                  </button>
                </span>
              </div>
            )}
            <div className="lb-kv">
              <b>AI 识图</b>
              <div className="lb-kv-row lb-kv-col">
                <button
                  className="btn sm"
                  disabled={aiBusy}
                  onClick={async () => {
                    setAiBusy(true);
                    try {
                      const d = await api.analyzeImage(item.id);
                      setAiDesc(d);
                    } catch (err) {
                      onChangeToast?.(i18n.t('k14fa2f47', { p0: (err as Error).message }));
                    } finally {
                      setAiBusy(false);
                    }
                  }}
                >
                  {aiBusy ? i18n.t('k5f021cab') : aiDesc?.description ? i18n.t('k2a3dd292') : i18n.t('kd7e6a876')}
                </button>
                <span className="lb-ai-desc">
                  {aiDesc?.description ||
                    i18n.t('kd121ba78')}
                </span>
                {!!aiDesc?.issues?.length && (
                  <span className="lb-ai-issues">可能的问题：{aiDesc.issues.join('、')}</span>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
