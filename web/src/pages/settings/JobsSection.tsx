import React, { useCallback, useEffect, useState } from 'react';
import { api, quiet } from '../../api';
import type { JobItem, OpLogItem } from '../../api';
import Card from './Card';
import { usePollWhenVisible } from '../../hooks/usePollWhenVisible';
import { subscribeEvents } from '../../events';
import i18n from '../../i18n';

interface Props {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

/** 状态文案 map：模块级不能调 t，改成按调用点传 t 的取词函数 */
const KIND_LABEL = (): Record<string, string> => ({
  crawl: i18n.t('ke8bc2616'),
  edit: i18n.t('ke73cefac'),
  enhance: i18n.t('kfd5e4c21'),
  'model-install': i18n.t('k02b71a79'),
  'eagle-export': i18n.t('kb3a4d282'),
});

const STATUS_LABEL = (): Record<string, string> => ({
  queued: i18n.t('ke5ac1d20'),
  running: i18n.t('kfb852fc6'),
  done: i18n.t('kfad5222c'),
  failed: i18n.t('kacd5cb84'),
  canceled: i18n.t('k2111ccbb'),
  interrupted: i18n.t('kc6a78bd9'),
});

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
  const kindLabel = KIND_LABEL();
  const statusLabel = STATUS_LABEL();
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [ops, setOps] = useState<OpLogItem[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.jobs('', 20).then(setJobs).catch(quiet);
    api.ops(20).then(setOps).catch(quiet);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  // 任务态变化走已有 job SSE（快照含批量编辑/采集/增强），合并 400ms 内多次变化只拉一次；
  // 轮询退化成「连续收不到推送」时的兜底，页面隐藏时 0 请求。
  useEffect(() => {
    let timer: number | undefined;
    const off = subscribeEvents('job', () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 400);
    });
    return () => {
      off();
      if (timer) window.clearTimeout(timer);
    };
  }, [refresh]);
  usePollWhenVisible(refresh, 15000);

  const cancel = async (job: JobItem) => {
    setBusy(true);
    try {
      const r = await api.cancelJob(job.id);
      onToast(r.message || (r.ok ? i18n.t('k2530fb3f') : i18n.t('ka96ed6db')));
      refresh();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const retry = async (job: JobItem) => {
    setBusy(true);
    try {
      await api.retryJob(job.id);
      onToast(i18n.t('k60c37f5c'));
      refresh();
    } catch (err) {
      onToast((err as Error).message, 'error');
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
      onToast(
        i18n.t('ke4e1c25f', { p0: op.summary, p1: detail ? `（${detail}）` : '' }),
      );
      refresh();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card
        title={i18n.t('k8ac876fb')}
        desc={i18n.t('keb225fe4')}
      >
        {jobs.length === 0 && <div className="hint">{i18n.t('k617432fa')}</div>}
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
                {kindLabel[j.kind] || j.kind}
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
                {statusLabel[j.status] || j.status}
              </span>
              {live && (
                <button className="btn sm" disabled={busy} onClick={() => void cancel(j)}>
                  {i18n.t('k095e938e')}
                </button>
              )}
              {!live && j.kind !== 'model-install' && (j.status === 'failed' || j.status === 'interrupted' || j.status === 'canceled') && (
                <button className="btn sm" disabled={busy} onClick={() => void retry(j)}>
                  {i18n.t('k132c5cdc')}
                </button>
              )}
            </div>
          );
        })}
      </Card>

      <Card
        title={i18n.t('k004f1d61')}
        desc={i18n.t('k6aa47ed1')}
      >
        {ops.length === 0 && <div className="hint">{i18n.t('keaa7b798')}</div>}
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
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{i18n.t('k50239f4f')}</span>
            ) : o.undoable ? (
              <button className="btn sm" disabled={busy} onClick={() => void undo(o)}>
                {i18n.t('kbd9fcf46')}
              </button>
            ) : (
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{i18n.t('k8826dd60')}</span>
            )}
          </div>
        ))}
      </Card>
    </>
  );
}
