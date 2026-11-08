/**
 * 服务子进程的跨崩溃回收（T-11）。
 *
 * Electron 没有暴露 Windows Job Object 绑定，utilityProcess 也不是普通 ChildProcess，
 * 引入原生模块去 AssignProcessToJobObject 的代价/风险都远大于收益。这里给出等效保障：
 *   1. fork 之后把 { pid, startedAt, entry } 落到 userData/server.pid；
 *   2. 正常退出删掉记录；主进程被任务管理器强杀时记录必然残留；
 *   3. 下次启动 fork 之前读记录，查询该 PID 的**创建时间 + 命令行**双重确认
 *      （防 PID 复用误杀别的应用），确认是上一次本服务的孤儿就用 taskkill /T 连进程树回收；
 *   4. 非 Windows 走 SIGTERM + 进程组。
 * 所有判断都是纯函数，单测直接覆盖；任何一步失败只记日志、绝不阻断启动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const PID_FILE = 'server.pid';
const AUDIT_TOLERANCE_MS = 15_000;

/** @typedef {{pid:number, startedAt:string, entry:string, userDataDir:string}} PidRecord */
/** @typedef {{pid:number, startedAt:string, commandLine:string}} ProcessAudit */

/** @param {unknown} raw */
export function parsePidRecord(raw) {
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || typeof data !== 'object') return null;
    const pid = Number(data.pid);
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return null;
    if (typeof data.startedAt !== 'string' || !Number.isFinite(Date.parse(data.startedAt))) return null;
    if (typeof data.entry !== 'string' || !data.entry) return null;
    return {
      pid,
      startedAt: data.startedAt,
      entry: data.entry,
      userDataDir: typeof data.userDataDir === 'string' ? data.userDataDir : '',
    };
  } catch {
    return null;
  }
}

/** 命令行归一化后再匹配：Windows 路径大小写/斜杠差异都不能让判定失效 */
export function isServiceCommandLine(commandLine, entry) {
  if (typeof commandLine !== 'string' || !commandLine.trim()) return false;
  const name = path.basename(String(entry || 'standalone.js')).toLowerCase();
  const cmd = commandLine.replace(/\\/g, '/').toLowerCase();
  return cmd.includes(name) && cmd.includes('server/');
}

/** PowerShell 的 WMI CreationDate 可能是 /Date(ms)/、ISO 或本地时间字符串 */
export function normalizeStartedAt(raw) {
  if (raw == null) return '';
  if (typeof raw === 'number') return new Date(raw).toISOString();
  const s = String(raw).trim();
  const wmi = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(s);
  const ms = wmi ? Number(wmi[1]) : Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : s;
}

/** @param {unknown} raw ConvertTo-Json 的输出（单对象或数组） */
export function parseProcessAudit(raw) {
  let data = raw;
  if (typeof data === 'string') {
    if (!data.trim()) return null;
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const one = Array.isArray(data) ? data[0] : data;
  if (!one || typeof one !== 'object') return null;
  const pid = Number(one.ProcessId ?? one.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    startedAt: normalizeStartedAt(one.CreationDate ?? one.startedAt),
    commandLine: String(one.CommandLine ?? one.commandLine ?? ''),
  };
}

/**
 * 是否该把这个进程当成「上一次本应用的孤儿服务」回收。
 * @param {PidRecord|null} record
 * @param {ProcessAudit|null} audit
 * @param {number} selfPid
 * @returns {{kill:boolean, reason:string}}
 */
export function shouldKillStale(record, audit, selfPid) {
  if (!record) return { kill: false, reason: '无残留记录' };
  if (record.pid === selfPid) return { kill: false, reason: '记录指向自身' };
  if (!audit || audit.pid !== record.pid) return { kill: false, reason: '进程已退出' };
  if (!isServiceCommandLine(audit.commandLine, record.entry)) {
    return { kill: false, reason: 'PID 已被其它进程复用' };
  }
  // Unix 的 ps 拿不到可靠的创建时间：此时只靠命令行特征（已能挡住 PID 复用）
  if (audit.startedAt) {
    const delta = Math.abs(Date.parse(audit.startedAt) - Date.parse(record.startedAt));
    if (!Number.isFinite(delta) || delta > AUDIT_TOLERANCE_MS) {
      return { kill: false, reason: '创建时间不匹配（PID 复用）' };
    }
  }
  return { kill: true, reason: '上次强杀留下的孤儿服务' };
}

/** @param {string} userDataDir */
const pidPath = (userDataDir) => path.join(userDataDir, PID_FILE);

/** @param {string} userDataDir @returns {PidRecord|null} */
export function readPidRecord(userDataDir) {
  if (!userDataDir) return null;
  try {
    return parsePidRecord(fs.readFileSync(pidPath(userDataDir), 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string} userDataDir @param {PidRecord} record */
export function writePidRecord(userDataDir, record) {
  if (!userDataDir) return;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(pidPath(userDataDir), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    console.warn('[api] 服务进程记录写入失败：', err?.message || err);
  }
}

/** @param {string} userDataDir */
export function removePidRecord(userDataDir) {
  if (!userDataDir) return;
  try {
    fs.rmSync(pidPath(userDataDir), { force: true });
  } catch {
    /* 只删文件，失败不影响退出 */
  }
}

/** @param {number} pid @returns {Promise<ProcessAudit|null>} */
export async function queryProcessAudit(pid) {
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'powershell.exe' : 'ps';
  const args = isWin
    ? [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress -Depth 3`,
      ]
    : ['-p', String(pid), '-o', 'pid=,args='];
  try {
    const { stdout } = await execFileAsync(exe, args, { timeout: 6000, windowsHide: true });
    if (isWin) return parseProcessAudit(stdout);
    // ps 输出： " 1234 /path/node server/standalone.js"
    const line = String(stdout).trim().split('\n')[0] || '';
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) return null;
    return { pid: Number(m[1]), startedAt: '', commandLine: m[2] };
  } catch {
    return null;
  }
}

/** @param {number} pid */
export async function killProcessTree(pid) {
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 6000, windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM'); // 负 pid = 整个进程组
  } catch {
    process.kill(pid, 'SIGTERM');
  }
}

/**
 * 启动前清理。覆盖「初次启动 / 崩溃重启 / 托盘重启 / 换端口兜底 / 安装失败恢复」全部路径。
 * @param {{userDataDir:string, entry:string, selfPid?:number, log?:(msg:string)=>void}} opts
 * @returns {Promise<{killed:boolean, reason:string}>}
 */
export async function cleanupStaleService({ userDataDir, entry, selfPid = process.pid, log = () => {} }) {
  const record = readPidRecord(userDataDir);
  if (!record) return { killed: false, reason: '无残留记录' };
  const audit = await queryProcessAudit(record.pid);
  const verdict = shouldKillStale(record, audit, selfPid);
  if (!verdict.kill) {
    removePidRecord(userDataDir);
    return { killed: false, reason: verdict.reason };
  }
  try {
    await killProcessTree(record.pid);
    log(`已回收上次残留的服务进程树 pid=${record.pid}（${verdict.reason}）`);
  } catch (err) {
    log(`回收残留服务进程失败 pid=${record.pid}：${err?.message || err}`);
  }
  removePidRecord(userDataDir);
  return { killed: true, reason: verdict.reason };
}
