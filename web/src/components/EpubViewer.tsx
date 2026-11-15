import { useCallback, useEffect, useRef, useState } from 'react';
import { api, copyText } from '../api';
import type { ImageItem } from '../types';
import { IconCopy } from './Icons';
import '../styles/epub.css';

type Outline = Awaited<ReturnType<typeof api.epubOutline>>;
type Chapter = Awaited<ReturnType<typeof api.epubChapter>>;

interface Props {
  item: ImageItem;
  onToast?: (text: string) => void;
}

/** 读到哪一章：按素材 id 记在 localStorage，换台机器不会跟着走，但重开这本书能接上 */
const progressKey = (id: number) => `tuku:epub:${id}`;

function readProgress(id: number): number {
  try {
    const n = Number(window.localStorage.getItem(progressKey(id)));
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeProgress(id: number, n: number) {
  try {
    window.localStorage.setItem(progressKey(id), String(n));
  } catch {
    // 隐私模式 / 配额满时记不住进度不算错误，不让它影响阅读
  }
}

/**
 * EPUB 阅读器：目录 + 章节正文 + 插图。
 *
 * 为什么不在前端解压 EPUB：书里的 XHTML 直接 innerHTML 就是 XSS 与样式污染的口子，
 * 而且相对路径资源还要重写成 blob URL。服务端已经把一章转成「文本块 + data URL 插图」，
 * 这里只负责排版与翻页，不渲染任何书本自带的 HTML。
 */
export default function EpubViewer({ item, onToast }: Props) {
  const [outline, setOutline] = useState<Outline | null>(null);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tocOpen, setTocOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const loadChapter = useCallback(
    async (n: number) => {
      setLoading(true);
      setError('');
      try {
        const data = await api.epubChapter(item.id, n);
        setChapter(data);
        setIndex(n);
        writeProgress(item.id, n);
        scrollRef.current?.scrollTo({ top: 0 });
      } catch (err) {
        setError(`这一章读不出来：${(err as Error).message}`);
      } finally {
        setLoading(false);
      }
    },
    [item.id]
  );

  useEffect(() => {
    let alive = true;
    api
      .epubOutline(item.id)
      .then((data) => {
        if (!alive) return;
        setOutline(data);
        if (!data.chapters.length) {
          setError('这本书没有可读的章节');
          setLoading(false);
          return;
        }
        return loadChapter(Math.min(readProgress(item.id), data.chapters.length - 1));
      })
      .catch((err: Error) => {
        if (!alive) return;
        setError(`解析 EPUB 失败：${err.message}`);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [item.id, loadChapter]);

  /* 打开即接收键盘：不聚焦到按钮上，空格/方向键才不会被按钮吞掉 */
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const total = outline?.chapters.length || 0;
  const go = (n: number) => {
    if (n < 0 || n >= total || loading) return;
    loadChapter(n).catch(() => null);
  };

  const copyTitle = async () => {
    const ok = await copyText(outline?.title || item.title);
    onToast?.(ok ? '书名已复制' : '复制失败，请手动选中书名');
  };

  /* 阅读器自己的方向键：翻章而不是切图（阻止冒泡，灯箱的方向键切图在这里让位） */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      go(index - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      go(index + 1);
    }
  };

  return (
    <div className="epub" ref={rootRef} onKeyDown={onKeyDown} tabIndex={-1}>
      <aside className={`epub-toc${tocOpen ? '' : ' collapsed'}`} aria-label="目录">
        <div className="epub-toc-head">
          <button
            className="btn sm ghost"
            onClick={() => setTocOpen((v) => !v)}
            aria-expanded={tocOpen}
            title={tocOpen ? '收起目录' : '展开目录'}
          >
            {tocOpen ? '‹' : '›'}
          </button>
          {tocOpen && <strong>目录</strong>}
        </div>
        {tocOpen && (
          <ol className="epub-toc-list">
            {(outline?.chapters || []).map((c) => (
              <li key={c.index}>
                <button
                  className={`epub-toc-item${c.index === index ? ' on' : ''}`}
                  aria-current={c.index === index ? 'true' : undefined}
                  onClick={() => go(c.index)}
                  title={c.label}
                >
                  {c.label}
                </button>
              </li>
            ))}
          </ol>
        )}
      </aside>

      <div className="epub-main">
        <header className="epub-head">
          <div className="epub-meta">
            <strong>{outline?.title || item.title}</strong>
            {outline?.author && <span>{outline.author}</span>}
          </div>
          <div className="epub-nav">
            <button className="btn sm" disabled={index <= 0 || loading} onClick={() => go(index - 1)}>
              上一章
            </button>
            <span className="epub-count">
              {total ? `${index + 1} / ${total}` : '—'}
            </span>
            <button className="btn sm" disabled={index >= total - 1 || loading} onClick={() => go(index + 1)}>
              下一章
            </button>
          </div>
        </header>

        <div className="epub-body" ref={scrollRef}>
          {loading && !chapter && <div className="epub-tip">正在解析 EPUB…</div>}
          {error && <div className="epub-tip epub-error">{error}</div>}
          {chapter && (
            <article>
              <h2 className="epub-chapter-title">{chapter.label}</h2>
              {chapter.blocks.map((b, i) =>
                b.type === 'text' ? (
                  <p key={i} className="epub-p">
                    {b.text}
                  </p>
                ) : (
                  <img key={i} className="epub-img" src={b.src} alt="" loading="lazy" />
                )
              )}
              {!chapter.blocks.length && <div className="epub-tip">这一章没有文字内容</div>}
            </article>
          )}
        </div>

        <footer className="epub-foot">
          <button
            className="btn sm ghost"
            onClick={() => void copyTitle()}
            title="复制书名"
            aria-label="复制书名"
          >
            <IconCopy size={14} />
          </button>
          <span className="epub-tip-inline">方向键 ← → 翻章</span>
        </footer>
      </div>
    </div>
  );
}
