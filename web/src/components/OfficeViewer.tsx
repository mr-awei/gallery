import { useEffect, useState } from 'react';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import type { ImageItem } from '../types';

interface Props {
  item: ImageItem;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
}

const MAX_ROWS = 300;
const MAX_COLS = 30;

/** 只保留排版类标签，顺手剥掉 on* 事件与 script：mammoth 输出虽可信，仍按不可信 HTML 处理 */
const ALLOWED = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'EM', 'U', 'S', 'UL', 'OL', 'LI',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'BR', 'HR', 'BLOCKQUOTE', 'A', 'SPAN', 'DIV',
  'IMG', 'SUP', 'SUB', 'CODE', 'PRE',
]);

function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (let guard = 0; guard < 200; guard++) {
    const bad = Array.from(doc.body.querySelectorAll('*')).find((el) => !ALLOWED.has(el.tagName));
    if (!bad) break;
    bad.replaceWith(...Array.from(bad.childNodes));
  }
  doc.body.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name) || (attr.name === 'href' && /^javascript:/i.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noreferrer');
    }
  });
  return doc.body.innerHTML;
}

const extOf = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

const xmlDecode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * Office 内嵌预览（纯前端、离线可跑）：
 * - .docx → mammoth 转 HTML，按纸张样式渲染
 * - .xlsx/.csv → SheetJS 转表格，多 Sheet 可切换
 * - .pptx → 解压 ppt/slides/*.xml 抽文本，按页给大纲
 * - 老格式 .doc/.xls/.ppt 没有纯前端解析器，明确引导用系统应用打开（不做假预览）
 */
export default function OfficeViewer({ item, onToast }: Props) {
  const ext = extOf(item.title);
  const [html, setHtml] = useState('');
  const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [slides, setSlides] = useState<string[][]>([]);
  /** txt / md 纯文本预览 */
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setHtml('');
    setSheets([]);
    setSlides([]);
    setText('');
    setActiveSheet(0);
    (async () => {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`读取失败 HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (ext === 'docx') {
        const out = await mammoth.convertToHtml({ arrayBuffer: buf });
        if (!cancelled) setHtml(sanitize(out.value || '<p class="ov-empty">文档没有可显示的正文</p>'));
      } else if (ext === 'xlsx' || ext === 'csv') {
        const wb = XLSX.read(buf, { type: 'array' });
        const list = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name];
          const all = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, blankrows: false, raw: false });
          return {
            name,
            rows: all.slice(0, MAX_ROWS).map((r) => (r || []).slice(0, MAX_COLS).map((c) => (c == null ? '' : String(c)))),
          };
        });
        if (!cancelled) setSheets(list);
      } else if (ext === 'pptx') {
        const zip = await JSZip.loadAsync(buf);
        const names = Object.keys(zip.files)
          .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
          .sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1] || 0) - Number(b.match(/(\d+)\.xml$/)?.[1] || 0));
        const pages: string[][] = [];
        for (const n of names) {
          const xml = await zip.file(n)?.async('string');
          if (!xml) continue;
          const texts = Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)).map((m) => xmlDecode(m[1]).trim()).filter(Boolean);
          pages.push(texts);
        }
        if (!cancelled) setSlides(pages);
      } else if (ext === 'txt' || ext === 'md') {
        // 纯文本直接解码，截断到 20 万字符避免超大日志卡住渲染
        if (!cancelled) setText(new TextDecoder('utf-8').decode(buf).slice(0, 200000));
      } else {
        throw new Error('该格式没有纯前端解析器（老版 Office / iWork 文稿请用系统应用打开）');
      }
    })()
      .catch((err) => {
        if (cancelled) return;
        setError((err as Error).message);
        onToast?.(`预览失败：${(err as Error).message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.url, ext, onToast]);

  if (loading) {
    return (
      <div className="ov-stage">
        <div className="ov-loading">正在解析 {ext.toUpperCase()} …</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ov-stage">
        <div className="ov-empty">
          <b>无法内嵌预览</b>
          <span>{error}</span>
          <span className="ov-empty-hint">可以点下方「在文件夹中显示」，用系统默认应用打开</span>
        </div>
      </div>
    );
  }

  if (ext === 'docx') {
    return (
      <div className="ov-stage">
        <div className="ov-page ov-doc" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    );
  }

  if (ext === 'txt' || ext === 'md') {
    return (
      <div className="ov-stage">
        <div className="ov-page ov-doc">
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 13,
              lineHeight: 1.75,
            }}
          >
            {text || '（空文件）'}
          </pre>
        </div>
      </div>
    );
  }

  if (ext === 'xlsx' || ext === 'csv') {
    const sheet = sheets[activeSheet];
    return (
      <div className="ov-stage ov-stage-sheet">
        {sheets.length > 1 && (
          <div className="ov-sheets">
            {sheets.map((s, i) => (
              <button key={s.name} className={`ov-sheet-tab${i === activeSheet ? ' on' : ''}`} onClick={() => setActiveSheet(i)}>
                {s.name}
              </button>
            ))}
          </div>
        )}
        <div className="ov-page ov-sheet">
          {sheet && sheet.rows.length ? (
            <table>
              <tbody>
                {sheet.rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (ri === 0 ? <th key={ci}>{cell}</th> : <td key={ci}>{cell}</td>))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="ov-empty">这个工作表是空的</div>
          )}
        </div>
        {sheet && sheet.rows.length >= MAX_ROWS && (
          <div className="ov-more">仅预览前 {MAX_ROWS} 行，完整内容请用表格软件打开</div>
        )}
      </div>
    );
  }

  /* pptx：按页给文本大纲 */
  return (
    <div className="ov-stage ov-stage-slides">
      {slides.map((texts, i) => (
        <div className="ov-page ov-slide" key={i}>
          <div className="ov-slide-no">第 {i + 1} 页</div>
          {texts.length ? (
            texts.map((t, ti) => (
              <p key={ti} className={ti === 0 ? 'ov-slide-title' : ''}>
                {t}
              </p>
            ))
          ) : (
            <p className="ov-empty">这一页只有图片/图形，没有文字</p>
          )}
        </div>
      ))}
    </div>
  );
}
