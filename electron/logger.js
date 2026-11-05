/**
 * 日志落盘：console.* 全量重定向到 userData/logs/app-YYYY-MM-DD.log。
 * 打包后窗口看不见，崩溃与异常只有这里能留下线索；单文件超 5MB 轮转为 .old。
 *
 * 性能约束：以前每输出一行就 appendFileSync + statSync，主进程在导入/滚动时
 * 每帧都可能打日志，同步 IO 直接把界面卡住。现在改成内存缓冲 + 定时异步批量写，
 * 只在进程退出时做一次同步兜底（最多丢不到 1 秒的日志，换来界面不卡）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_LOG_SIZE = 5 * 1024 * 1024;
const FLUSH_INTERVAL = 800;
const FLUSH_THRESHOLD = 200;

let logDir = '';
let inited = false;
let buffer = [];
let timer = null;

function currentFile() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(logDir, `app-${day}.log`);
}

function flush(sync = false) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!buffer.length) return;
  const text = buffer.join('');
  buffer = [];
  try {
    if (sync) fs.appendFileSync(currentFile(), text);
    else void fsp.appendFile(currentFile(), text).catch(() => {});
  } catch {
    /* 磁盘满等场景下不能让日志拖垮应用 */
  }
  void rotateIfNeeded();
}

async function rotateIfNeeded() {
  try {
    const file = currentFile();
    const st = await fsp.stat(file);
    if (st.size > MAX_LOG_SIZE) await fsp.rename(file, `${file}.old`);
  } catch {
    /* 文件还没建出来 / 被占用：下次再说 */
  }
}

function append(line) {
  buffer.push(line);
  if (buffer.length >= FLUSH_THRESHOLD) flush();
  else if (!timer) timer = setTimeout(() => flush(), FLUSH_INTERVAL).unref?.();
}

/**
 * 日志打码：Cookie、AI Key、百度翻译 ?appid=&key= 这类东西经常被整条 URL/响应
 * 直接 console.log 出来，日志文件又要发给用户排查，不能带着明文密钥满天飞。
 */
function sanitize(text) {
  return text
    .replace(/(cookie["']?\s*[:=]\s*)([^\s"',;]+)/gi, '$1***')
    .replace(
      /((?:api[-_]?key|access[-_]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)([^\s"',;}]+)/gi,
      '$1***'
    )
    .replace(/([?&](?:key|token|appid|secret|access_token)=)([^&\s]+)/gi, '$1***');
}

function fmt(level, args) {
  const body = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || String(a);
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  return `[${new Date().toISOString()}] [${level}] ${sanitize(body)}\n`;
}

export function initLogger(userDataDir) {
  if (inited) return;
  inited = true;
  logDir = path.join(userDataDir, 'logs');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    /* 拿不到可写目录就只在控制台输出 */
  }
  // info 也要接管：生命周期日志统一走 console.info，console.log 留给真正的临时调试
  // （自定义 lint 把 console.log 记为调试残留，这里不接管就等于是把日志丢进黑洞）
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      if (logDir) append(fmt(level, args));
    };
  }
  // 退出前把缓冲区落盘（此时只能同步写；量很小，不会拖垮退出）
  process.on('exit', () => flush(true));
}

/** 供主进程在 will-quit 里主动刷一次 */
export function flushLogs(sync = true) {
  flush(sync);
}

export function getLogDir() {
  return logDir;
}
