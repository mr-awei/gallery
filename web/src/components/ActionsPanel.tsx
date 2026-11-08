import { useCallback, useEffect, useState } from 'react';
import { api, formatDate, quiet } from '../api';
import type { ActionDef, ActionStep } from '../api';
import type { FolderNode } from '../types';
import { IconClose, IconTrash } from './Icons';

/**
 * 动作（Actions）：把一串固定步骤存成宏，对选区一键重放。
 * 与 Eagle 4 对齐；AI 步骤在没配模型时明确失败，不伪造结果。
 */
export default function ActionsPanel({
  open,
  ids,
  onClose,
  onToast,
  onRefresh,
}: {
  open: boolean;
  ids: number[];
  onClose: () => void;
  onToast?: (m: string, kind?: 'info' | 'error') => void;
  onRefresh?: () => void;
}) {
  const [types, setTypes] = useState<Record<string, { label: string; desc: string }>>({});
  const [actions, setActions] = useState<ActionDef[]>([]);
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState('');
  const [draft, setDraft] = useState<{ id?: number; name: string; steps: ActionStep[] }>({
    name: '',
    steps: [{ type: 'tag', mode: 'add', tags: '' }],
  });

  const load = useCallback(() => {
    api
      .actions()
      .then((r) => {
        setTypes(r.types);
        setActions(r.actions);
      })
      .catch((e) => setLog((e as Error).message));
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
    api.folders().then((r) => setFolders(r.folders)).catch(quiet);
  }, [open, load]);

  if (!open) return null;

  const run = async (a: ActionDef) => {
    if (!ids.length) {
      setLog('先在图上选中要处理的素材');
      return;
    }
    setBusy(`run-${a.id}`);
    setLog('');
    try {
      const r = await api.runAction(a.id, ids);
      const firstErr = r.items.find((x) => !x.ok)?.error;
      setLog(
        `「${r.action.name}」：成功 ${r.okCount} 张${r.failed ? `，失败 ${r.failed} 张（${firstErr || ''}）` : ''}`
      );
      onToast?.(`动作完成：${r.okCount} / ${r.total}`);
      onRefresh?.();
      load();
    } catch (e) {
      setLog((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    if (!draft.name.trim()) {
      setLog('给动作起个名字');
      return;
    }
    setBusy('save');
    try {
      await api.saveAction({ id: draft.id, name: draft.name.trim(), steps: draft.steps });
      setLog('已保存');
      setDraft({ name: '', steps: [{ type: 'tag', mode: 'add', tags: '' }] });
      load();
    } catch (e) {
      setLog((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const patch = (i: number, next: Partial<ActionStep>) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...next } : s)) }));

  return (
    <div className="modal-backdrop tk-backdrop" onClick={onClose}>
      <div className="modal-card tk-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>动作</b>
          <span className="tk-title">{ids.length ? `将对 ${ids.length} 张执行` : '请先在图上选中素材'}</span>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>
        <div className="modal-body tk-body">
          <h4 className="section-title">已保存的动作</h4>
          {actions.length === 0 && <div className="tk-empty">还没有动作。下面新建一个，把常用操作串起来。</div>}
          <div className="tk-actions">
            {actions.map((a) => (
              <div className="tk-action" key={a.id}>
                <div>
                  <b>{a.name}</b>
                  <div className="tk-hint">
                    {a.steps.map((s) => types[s.type]?.label || s.type).join(' → ')}
                    {a.lastRunAt ? ` · 上次 ${formatDate(a.lastRunAt)}` : ''}
                  </div>
                </div>
                <div className="tk-row">
                  <button className="btn sm" disabled={!!busy} onClick={() => run(a)}>
                    {busy === `run-${a.id}` ? '执行中…' : '执行'}
                  </button>
                  <button
                    className="btn sm ghost"
                    onClick={() => setDraft({ id: a.id, name: a.name, steps: a.steps })}
                    title="载入到下方编辑器"
                  >
                    编辑
                  </button>
                  <button
                    className="btn sm ghost danger"
                    onClick={async () => {
                      // 以前是 catch(quiet)：删失败了按钮也毫无反应，用户会反复点
                      try {
                        await api.deleteAction(a.id);
                        load();
                      } catch (err) {
                        const msg = `删除动作「${a.name}」失败：${(err as Error).message}`;
                        setLog(msg);
                        onToast?.(msg);
                      }
                    }}
                    title="删除这个动作"
                  >
                    <IconTrash />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <h4 className="section-title" style={{ marginTop: 16 }}>
            {draft.id ? '编辑动作' : '新建动作'}
          </h4>
          <input
            className="input"
            style={{ width: '100%', marginBottom: 8 }}
            placeholder="动作名称，例如「微博图打包」"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          {draft.steps.map((s, i) => (
            <div className="tk-step" key={i}>
              <select
                className="input"
                value={s.type}
                onChange={(e) => patch(i, { type: e.target.value })}
                style={{ width: 110 }}
              >
                {Object.entries(types).map(([k, v]) => (
                  <option key={k} value={k} title={v.desc}>
                    {v.label}
                  </option>
                ))}
              </select>
              {s.type === 'tag' && (
                <>
                  <select className="input" value={s.mode || 'add'} onChange={(e) => patch(i, { mode: e.target.value })}>
                    <option value="add">添加</option>
                    <option value="remove">移除</option>
                    <option value="replace">替换</option>
                  </select>
                  <input
                    className="input"
                    placeholder="标签，逗号分隔"
                    value={s.tags || ''}
                    onChange={(e) => patch(i, { tags: e.target.value })}
                  />
                </>
              )}
              {s.type === 'rate' && (
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={5}
                  value={s.rating ?? 5}
                  onChange={(e) => patch(i, { rating: Number(e.target.value) })}
                />
              )}
              {s.type === 'note' && (
                <>
                  <select className="input" value={s.mode || 'append'} onChange={(e) => patch(i, { mode: e.target.value })}>
                    <option value="append">追加</option>
                    <option value="replace">替换</option>
                  </select>
                  <input
                    className="input"
                    placeholder="备注内容"
                    value={s.text || ''}
                    onChange={(e) => patch(i, { text: e.target.value })}
                  />
                </>
              )}
              {s.type === 'title' && (
                <>
                  <select className="input" value={s.mode || 'template'} onChange={(e) => patch(i, { mode: e.target.value })}>
                    <option value="template">模板</option>
                    <option value="prefix">前缀</option>
                    <option value="suffix">后缀</option>
                  </select>
                  <input
                    className="input"
                    placeholder={s.mode === 'template' ? '{keyword}-{index}' : '要加的文字'}
                    value={(s.mode === 'template' ? s.template : s.text) || ''}
                    onChange={(e) =>
                      patch(i, s.mode === 'template' ? { template: e.target.value } : { text: e.target.value })
                    }
                  />
                </>
              )}
              {s.type === 'folder' && (
                <select
                  className="input"
                  value={s.folderId ?? ''}
                  onChange={(e) => patch(i, { folderId: Number(e.target.value) })}
                >
                  <option value="">选择文件夹</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              )}
              {s.type === 'favorite' && (
                <select
                  className="input"
                  value={s.value === false ? 'off' : 'on'}
                  onChange={(e) => patch(i, { value: e.target.value === 'on' })}
                >
                  <option value="on">收藏</option>
                  <option value="off">取消收藏</option>
                </select>
              )}
              {s.type === 'aiPrompt' && (
                <>
                  <input
                    className="input"
                    placeholder="AI 指令，如「写一句适合小红书的标题」"
                    value={s.instruction || ''}
                    onChange={(e) => patch(i, { instruction: e.target.value })}
                  />
                  <select className="input" value={s.target || 'note'} onChange={(e) => patch(i, { target: e.target.value })}>
                    <option value="note">写入备注</option>
                    <option value="title">写入标题</option>
                    <option value="tags">写入标签</option>
                  </select>
                </>
              )}
              {(s.type === 'ocr' || s.type === 'aiDescribe') && (
                <span className="tk-hint">{types[s.type]?.desc}</span>
              )}
              <button
                className="btn sm ghost danger"
                disabled={draft.steps.length <= 1}
                onClick={() => setDraft((d) => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }))}
                title="删除这一步"
              >
                <IconTrash />
              </button>
            </div>
          ))}
          <div className="tk-row" style={{ marginTop: 10 }}>
            <button
              className="btn sm"
              onClick={() => setDraft((d) => ({ ...d, steps: [...d.steps, { type: 'tag', mode: 'add', tags: '' }] }))}
            >
              + 加一步
            </button>
            <button className="btn sm primary" disabled={busy === 'save'} onClick={save}>
              {draft.id ? '保存修改' : '保存为动作'}
            </button>
            {draft.id && (
              <button
                className="btn sm ghost"
                onClick={() => setDraft({ name: '', steps: [{ type: 'tag', mode: 'add', tags: '' }] })}
              >
                取消编辑
              </button>
            )}
          </div>
          {log && <div className="tk-hint">{log}</div>}
        </div>
      </div>
    </div>
  );
}
