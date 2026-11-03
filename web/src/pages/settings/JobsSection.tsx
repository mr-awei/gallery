import React, { useCallback, useEffect, useState } from 'react';
import { api, quiet } from '../../api';
import type { JobItem, OpLogItem } from '../../api';
import Card from './Card';

interface Props {
  onToast: (msg: string) => void;
}

const KIND_LABEL: Record<string, string> = {
  crawl: '采集',
  edit: '批量编辑',
  enhance: '画质增强',
  'model-install': '模型下载',
};

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
  interrupted: '中断（进程退出）',
};

function statusColor(status: string) {
  if (status === 'done') return 'var(--ok)';
  if (status === 'running') return 'var(--accent, #4f8cff)';
  if (status === 'failed') return 'var(--warn)';
  return 'var(--muted)';
}

function fmtTime(iso: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 任务历史 + 操作撤销。
 *
 * 之前这些状态全在内存里：进程一退，采集/批量编辑/增强跑过什么全没了，
 * 界面也只能看「当前任务」，既不能重试也没法取消已经卡住的那次。
 * 撤销同理，只有编辑类能回滚，打标/移动/删除/导入都只能人肉复原。
 */
export default function JobsSection({ onToast }: Props) {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [ops, setOps] = useState<OpLogItem[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.jobs('', 20).then(setJobs).catch(quiet);
    api.ops(20).then(setOps).catch(quiet);
  }, []);

  useEffect(() => {
    refresh();
    // 任务进度靠 SSE 里的 library 事件间接触发刷新，这里再兜一层 5s 轮询（只在设置页可见时）
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const cancel = async (job: JobItem) => {
    setBusy(true);
    try {
      const r = await api.cancelJob(job.id);
      onToast(r.message || (r.ok ? '已请求停止' : '无法停止'));
      refresh();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const retry = async (job: JobItem) => {
    setBusy(true);
    try {
      await api.retryJob(job.id);
      onToast('已重新入队');
      refresh();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const undo = async (op: OpLogItem) => {
    setBusy(true);
    try {
      const r = await api.undoOp(op.id);
      const info = r.info || {};
      const detail = Object.entries(info)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      onToast(`已撤销：${op.summary}${detail ? `（${detail}）` : ''}`);
      refresh();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title="任务历史" desc="采集、批量编辑、画质增强、模型下载都会留档，中断或失败的任务可以直接重试。">
        {jobs.length === 0 && <div className="hint">暂无任务记录</div>}
        {jobs.map((j) => {
          const live = j.status === 'running' || j.status === 'queued';
          return (
            <div
              key={j.id}
              style={{
                borderBottom: '1px solid var(--line, rgba(255,255,255,.08))',
                padding: '8px 0',
                display: 'flex',
                gap: 10,
                alignItems: 'center',
              }}
            >
              <span style={{ fontSize: 11.5, color: 'var(--muted)', minWidth: 72 }}>{fmtTime(j.createdAt)}</span>
              <span style={{ fontSize: 11.5, color: 'var(--muted)', minWidth: 56 }}>
                {KIND_LABEL[j.kind] || j.kind}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {j.title || j.message || j.kind}
                {live && j.total > 0 && (
                  <span style={{ color: 'var(--muted)' }}>
                    {' '}
                    {j.done + j.failed}/{j.total}
                  </span>
                )}
              </span>
              <span style={{ fontSize: 11.5, color: statusColor(j.status), minWidth: 76 }} title={j.error || ''}>
                {STATUS_LABEL[j.status] || j.status}
              </span>
              {live && (
                <button className="btn sm" disabled={busy} onClick={() => void cancel(j)}>
                  停止
                </button>
              )}
              {!live && j.kind !== 'model-install' && (j.status === 'failed' || j.status === 'interrupted' || j.status === 'canceled') && (
                <button className="btn sm" disabled={busy} onClick={() => void retry(j)}>
                  重试
                </button>
              )}
            </div>
          );
        })}
      </Card>

      <Card
        title="最近操作"
        desc="打标、收藏、移动文件夹、删除、回收站恢复、批量导入、批量重命名、重复清理都能撤销一步（撤销删除走回收站，不会真删文件）。"
      >
        {ops.length === 0 && <div className="hint">暂无操作记录</div>}
        {ops.map((o) => (
          <div
            key={o.id}
            style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0' }}
          >
            <span style={{ fontSize: 11.5, color: 'var(--muted)', minWidth: 72 }}>{fmtTime(o.createdAt)}</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {o.summary}
            </span>
            {o.undone ? (
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>已撤销</span>
            ) : o.undoable ? (
              <button className="btn sm" disabled={busy} onClick={() => void undo(o)}>
                撤销
              </button>
            ) : (
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>不可撤销</span>
            )}
          </div>
        ))}
      </Card>
    </>
  );
}
