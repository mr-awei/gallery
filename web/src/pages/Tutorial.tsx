/**
 * 使用教程：分类导航 + 全文搜索 + 条目展开。
 *
 * 内容在 lib/tutorial-content.ts（纯数据），这里只负责检索与渲染：
 * 搜索按「标题 > 关键词 > 正文」加权，命中词高亮；不引入 markdown 依赖，
 * 正文只认 `代码` 与 **粗体** 两种行内标记。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TUTORIAL, TUTORIAL_CATEGORIES, TUTORIAL_SECTIONS, TUTORIAL_TOTAL } from '../lib/tutorial-content';

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把命中词包成 <mark>；没有关键词时原样返回 */
function highlight(text: string, tokens: string[]): ReactNode {
  if (!tokens.length) return text;
  const re = new RegExp(`(${tokens.map(escapeRe).join('|')})`, 'gi');
  const lowered = new Set(tokens);
  // split 带捕获组：奇数位就是命中片段，直接按位置判断，别在全局正则上 re.test（lastIndex 会漂）
  return text
    .split(re)
    .map((p, i) => (i % 2 === 1 && lowered.has(p.toLowerCase()) ? <mark key={i}>{p}</mark> : p));
}

/** 渲染一段带 `代码` / **粗体** / 高亮的文本 */
function inline(text: string, tokens: string[]): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <b key={i}>{highlight(part.slice(2, -2), tokens)}</b>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    return <span key={i}>{highlight(part, tokens)}</span>;
  });
}

/** 正文按空行分段，段内以 "- " 开头的是列表 */
function renderBody(body: string, tokens: string[]) {
  return body.split('\n\n').map((block, i) => {
    const lines = block.split('\n').filter(Boolean);
    if (lines.every((l) => l.startsWith('- '))) {
      return (
        <ul key={i} className="tut-list">
          {lines.map((l, j) => (
            <li key={j}>{inline(l.slice(2), tokens)}</li>
          ))}
        </ul>
      );
    }
    return <p key={i}>{inline(block, tokens)}</p>;
  });
}

function tokensOf(q: string) {
  return q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** 搜索命中时挑一段最相关的正文当预览（去掉行内标记，只保留第一句/第一条） */
function snippetOf(body: string, tokens: string[]) {
  const plain = body.replace(/\*\*/g, '').replace(/`/g, '');
  const blocks = plain.split('\n\n');
  const hit = blocks.find((b) => tokens.some((t) => b.toLowerCase().includes(t)));
  const block = (hit || blocks[0] || '').replace(/^- /gm, '').split('\n')[0];
  return block.length > 180 ? `${block.slice(0, 180)}…` : block;
}

export default function Tutorial({ initialQuery = '' }: { initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery);
  const [cat, setCat] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set([TUTORIAL[0]?.sections[0]?.id].filter(Boolean) as string[]));
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setQ(initialQuery);
  }, [initialQuery]);

  const tokens = useMemo(() => tokensOf(q), [q]);

  const results = useMemo(() => {
    if (!tokens.length) return null;
    return TUTORIAL_SECTIONS.map((s) => {
      const hay = {
        title: s.title.toLowerCase(),
        kw: s.keywords.join(' ').toLowerCase(),
        text: (s.summary + '\n' + s.body).toLowerCase(),
      };
      let score = 0;
      for (const t of tokens) {
        if (hay.title.includes(t)) score += 4;
        else if (hay.kw.includes(t)) score += 3;
        else if (hay.text.includes(t)) score += 1;
        else return null;
      }
      return { s, score };
    })
      .filter((x): x is { s: (typeof TUTORIAL_SECTIONS)[number]; score: number } => !!x)
      .sort((a, b) => b.score - a.score || a.s.title.localeCompare(b.s.title, 'zh-Hans-CN'))
      .filter((x) => !cat || x.s.categoryId === cat);
  }, [tokens, cat]);

  const sections = useMemo(
    () => TUTORIAL.filter((c) => !cat || c.id === cat),
    [cat]
  );

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="tut-page">
      <header className="tut-head">
        <div>
          <h2>使用教程</h2>
          <p className="tut-sub">
            共 {TUTORIAL_TOTAL} 条功能说明，覆盖 {TUTORIAL_CATEGORIES.length} 个分类。输入关键词搜索，或从左侧分类进入。
          </p>
        </div>
        <div className="tut-search">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                if (q) setQ('');
                else inputRef.current?.blur();
              }
            }}
            placeholder="搜功能：堆叠、水印、时间点笔记、壁纸…"
            aria-label="搜索教程"
          />
          {q && (
            <button className="tut-clear" onClick={() => setQ('')} title="清空搜索">
              ×
            </button>
          )}
        </div>
      </header>

      <div className="tut-layout">
        <nav className="tut-nav" aria-label="教程分类">
          <button className={`tut-nav-item${cat === null ? ' on' : ''}`} onClick={() => setCat(null)}>
            全部
            <span>{TUTORIAL_TOTAL}</span>
          </button>
          {TUTORIAL_CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={`tut-nav-item${cat === c.id ? ' on' : ''}`}
              onClick={() => setCat(cat === c.id ? null : c.id)}
            >
              {c.title}
              <span>{c.count}</span>
            </button>
          ))}
        </nav>

        <div className="tut-main">
          {results ? (
            <>
              <div className="tut-result-head">
                找到 <b>{results.length}</b> 条{cat ? `（${TUTORIAL_CATEGORIES.find((c) => c.id === cat)?.title}）` : ''}
                {results.length === 0 && <span className="tut-empty-hint">换个词试试，比如「堆叠」「导出」「快捷键」</span>}
              </div>
              {results.map(({ s }) => (
                <article className="tut-card" key={s.id} id={`tut-${s.id}`}>
                  <div className="tut-card-head">
                    <div className="tut-card-title">
                      <h3>{highlight(s.title, tokens)}</h3>
                      <span className="tut-chip">{s.categoryTitle}</span>
                    </div>
                    <button className="tut-toggle" onClick={() => toggle(s.id)} aria-expanded={open.has(s.id)}>
                      {open.has(s.id) ? '收起' : '查看全文'}
                    </button>
                  </div>
                  <p className="tut-summary">{highlight(snippetOf(s.body, tokens), tokens)}</p>
                  {open.has(s.id) && <div className="tut-body">{renderBody(s.body, tokens)}</div>}
                  {open.has(s.id) && s.shortcuts && (
                    <div className="tut-keys">
                      {s.shortcuts.map((k) => (
                        <span key={k.keys} className="tut-key">
                          <kbd>{k.keys}</kbd>
                          {k.desc}
                        </span>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </>
          ) : (
            sections.map((c) => (
              <section className="tut-group" key={c.id}>
                <h3 className="tut-group-title">
                  {c.title}
                  <span>{c.sections.length} 条</span>
                </h3>
                {c.sections.map((s) => {
                  const isOpen = open.has(s.id);
                  return (
                    <article className="tut-card" key={s.id} id={`tut-${s.id}`}>
                      <div className="tut-card-head">
                        <div className="tut-card-title">
                          <h3>{s.title}</h3>
                          <span className="tut-summary-inline">{s.summary}</span>
                        </div>
                        <button
                          className="tut-toggle"
                          onClick={() => toggle(s.id)}
                          aria-expanded={isOpen}
                          title={isOpen ? '收起' : '展开'}
                        >
                          {isOpen ? '收起' : '展开'}
                        </button>
                      </div>
                      {isOpen && (
                        <>
                          <div className="tut-body">{renderBody(s.body, [])}</div>
                          {s.shortcuts && (
                            <div className="tut-keys">
                              {s.shortcuts.map((k) => (
                                <span key={k.keys} className="tut-key">
                                  <kbd>{k.keys}</kbd>
                                  {k.desc}
                                </span>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </article>
                  );
                })}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
