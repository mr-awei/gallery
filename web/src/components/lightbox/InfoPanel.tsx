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
            title="该图由「画质增强」放大过，磁盘文件已是当前尺寸"
          >
            ✨ 已增强 {item.enhanceScale}×（原 {item.originalWidth}×{item.originalHeight}）
          </span>
        )}
        <span className="lb-sum-dim">{formatSize(item.sizeBytes)}</span>
        <span className="lb-sum-sep" />
        <span className="lb-sum-dim">{SOURCE_LABELS[item.source] || item.source}</span>
        <span className="lb-sum-sep" />
        <span className="lb-sum-dim">{formatDate(item.createdAt)}</span>
        <span className="lb-sum-sep" />
        <span className="stars lb-sum-stars">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              className={`star${(item.rating || 0) >= n ? ' on' : ''}`}
              title={`${n} 星`}
              onClick={() => onPatch?.(item, { rating: item.rating === n ? 0 : n })}
            >
              ★
            </button>
          ))}
        </span>
        {!!item.note && (
          <span className="lb-sum-note" title={item.note}>
            📝 {item.note}
          </span>
        )}
        {!!item.tags.length && (
          <span className="lb-sum-tags" title={item.tags.join('、')}>
            {item.tags.map((t) => `#${t}`).join(' ')}
          </span>
        )}
        <button className="lb-sum-toggle" onClick={onToggle} title="展开 / 收起详情（I）">
          {open ? '收起详情 ▴' : '详情 ▾'}
        </button>
      </div>

      {open && (
        <div className="lb-groups">
          <section className="lb-group">
            <h5>基本信息</h5>
            <div className="lb-kv">
              <b>{isImage ? '分辨率' : '媒体信息'}</b>
              <span>
                {isImage ? (
                  <>
                    {item.width} × {item.height}
                    {ext ? ` · ${ext}` : ''} · {BUCKET_LABELS[item.bucket]}
                  </>
                ) : (
                  <>
                    {(item.mediaKind || 'file').toUpperCase()}
                    {item.duration > 0 ? ` · ${Math.round(item.duration)} 秒` : ''}
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
                      title={`${library.name}${library.path ? `\n${library.path}` : ''}\n点击复制库路径`}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(library.path);
                          onChangeToast?.(`已复制库路径：${library.path}`);
                        } catch {
                          onChangeToast?.(library.path || library.name);
                        }
                      }}
                    >
                      {library.name}
                    </span>
                    {library.path ? <span className="lb-lib-path">{library.path}</span> : null}
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
              <span>{item.viewCount ? `看过 ${item.viewCount} 次` : '还没看过'}</span>
            </div>
            <div className="lb-kv">
              <b>本地文件</b>
              <span
                className="lb-link"
                title={item.path}
                onClick={() => revealFile(item.path)}
              >
                {item.path ? item.path.replace(/^.*[\\/]/, '') : '—'}
              </span>
            </div>
          </section>

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
                        title="点 × 从该文件夹移出（不删除图片）"
                      >
                        {f.name}
                        <button
                          className="lb-folder-x"
                          title={`从「${f.name}」移出`}
                          onClick={async () => {
                            try {
                              await api.removeFromFolder(f.id, [item.id]);
                              setImgFolders((prev) => prev.filter((x) => x.id !== f.id));
                              onChangeToast?.(`已从「${f.name}」移出`);
                            } catch (err) {
                              onChangeToast?.(`移出失败：${(err as Error).message}`);
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
                  placeholder="添加标签…"
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
                    <span className="tag-pill inherited" key={t} title="来自所属文件夹的标签，只读：改文件夹标签即可">
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
                    title={`${n} 星`}
                    onClick={() => onPatch?.(item, { rating: item.rating === n ? 0 : n })}
                  >
                    ★
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
                placeholder="记点什么…（回车保存）"
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
          </section>

          <section className="lb-group">
            <h5>颜色与智能</h5>
            <div className="lb-kv">
              <b>主色系</b>
              <span className="lb-kv-row">
                <span
                  className="color-chip"
                  style={{ background: item.dominant || 'rgba(255,255,255,0.15)' }}
                  title={item.dominant || '未提取主色'}
                />
                <span className="lb-mono">{item.dominant || '—'}</span>
                {onFindColor && !!hueKey && (
                  <button
                    className="btn sm ghost"
                    title={
                      hueKey === 'gray'
                        ? '跳到图库，只看黑白灰图片'
                        : '跳到图库，只看同色系的图片'
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
                      title={`导出这张图的 ${paletteColors.length} 色主色板（.ase，Photoshop / Illustrator 可直接导入）`}
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
                      title="导出 PNG 色卡（色块 + 色值），适合贴到设计稿或沟通文档"
                      onClick={async () => {
                        try {
                          downloadBlob(
                            await buildPngSheet(paletteColors),
                            `${safeName(item.title)}.png`,
                          );
                        } catch {
                          onChangeToast?.('导出失败：画布不可用');
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
                  title="用 CLIP 深度特征找出与这张最像的其他图（相似度可调）"
                >
                  {simOpen ? '✕ 收起面板' : '🔍 找相似'}
                </button>
              </span>
            </div>
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
                      onChangeToast?.(`AI 识图失败：${(err as Error).message}`);
                    } finally {
                      setAiBusy(false);
                    }
                  }}
                >
                  {aiBusy ? '识别中…' : aiDesc?.description ? '重新识别' : 'AI 识图'}
                </button>
                <span className="lb-ai-desc">
                  {aiDesc?.description ||
                    '（还没识别，点左侧按钮让 AI 描述这张图，之后可用自然语言搜索）'}
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
