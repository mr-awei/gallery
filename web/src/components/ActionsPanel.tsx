import { useCallback, useEffect, useState } from 'react';
import { api, formatDate, quiet } from '../api';
import type { ActionConditions, ActionDef, ActionPreviewStep, ActionStep } from '../api';
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
  /** 条件草稿与步骤一起编辑：条件决定「对哪些图生效」，不该等到执行时才发现跳过了大半 */
  const EMPTY_COND: ActionConditions = { combine: 'and', rules: {} };
  const [draft, setDraft] = useState<{ id?: number; name: string; steps: ActionStep[]; conditions: ActionConditions }>({
    name: '',
    steps: [{ type: 'tag', mode: 'add', tags: '' }],
    conditions: EMPTY_COND,
  });
  /** 预演结果（dryRun）：只算不写 */
  const [preview, setPreview] = useState<{ name: string; items: { id: number; skipped?: string; preview?: ActionPreviewStep[] }[]; skipped: number } | null>(null);
  /** 刚执行过的动作，用于一键撤销 */
  const [lastRun, setLastRun] = useState<{ id: number; name: string } | null>(null);

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
        `「${r.action.name}」：成功 ${r.okCount} 张` +
          `${r.skipped ? `，跳过 ${r.skipped} 张（条件不匹配）` : ''}` +
          `${r.failed ? `，失败 ${r.failed} 张（${firstErr || ''}）` : ''}`
      );
      if (r.okCount) setLastRun({ id: a.id, name: r.action.name });
      onToast?.(`动作完成：${r.okCount} / ${r.total}${r.skipped ? `（跳过 ${r.skipped}）` : ''}`);
      onRefresh?.();
      load();
    } catch (e) {
      setLog((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  /** 预演：把每张图将改什么列出来，AI / OCR / 插件步骤会如实标注「无法预演」 */
  const dryRun = async (a: ActionDef) => {
    if (!ids.length) {
      setLog('先在图上选中要处理的素材');
      return;
    }
    setBusy(`dry-${a.id}`);
    setLog('');
    try {
      const r = await api.runAction(a.id, ids, { dryRun: true });
      setPreview({
        name: r.action.name,
        skipped: r.skipped,
        items: r.items.map((x) => ({ id: x.id, skipped: x.skipped, preview: x.preview })),
      });
      setLog(`预演完成：将影响 ${r.total - r.skipped} 张，跳过 ${r.skipped} 张（未写库）`);
    } catch (e) {
      setLog((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  /** 撤销刚执行的动作（走统一操作日志，按快照恢复字段与文件夹归属） */
  const undoLastRun = async () => {
    setBusy('undo');
    try {
      const r = await api.undoLastOp();
      setLog(`已撤销「${lastRun?.name || '上次操作'}」（${r.op}）`);
      onToast?.('已撤销这次动作');
      setLastRun(null);
      onRefresh?.();
    } catch (e) {
      setLog(`撤销失败：${(e as Error).message}`);
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
      await api.saveAction({
        id: draft.id,
        name: draft.name.trim(),
        steps: draft.steps,
        conditions: draft.conditions,
      });
      setLog('已保存');
      setDraft({ name: '', steps: [{ type: 'tag', mode: 'add', tags: '' }], conditions: EMPTY_COND });
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
                  <button className="btn sm ghost" disabled={!!busy} onClick={() => dryRun(a)} title="只算出会改什么，不写库">
                    {busy === `dry-${a.id}` ? '预演中…' : '预演'}
                  </button>
                  <button className="btn sm" disabled={!!busy} onClick={() => run(a)}>
                    {busy === `run-${a.id}` ? '执行中…' : '执行'}
                  </button>
                  <button
                    className="btn sm ghost"
                    onClick={() => setDraft({ id: a.id, name: a.name, steps: a.steps, conditions: a.conditions || EMPTY_COND })}
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

          {lastRun && (
            <div className="tk-row" style={{ marginTop: 10 }}>
              <span className="tk-hint">刚执行：「{lastRun.name}」</span>
              <button className="btn sm" disabled={!!busy} onClick={() => void undoLastRun()}>
                {busy === 'undo' ? '撤销中…' : '撤销这次动作'}
              </button>
            </div>
          )}

          {preview && (
            <div style={{ marginTop: 12 }}>
              <h4 className="section-title">预演结果 · {preview.name}</h4>
              <div className="tk-hint" style={{ marginBottom: 6 }}>
                只计算、不写库。跳过 {preview.skipped} 张（条件不匹配）。
              </div>
              <div style={{ maxHeight: 220, overflow: 'auto', fontSize: 12.5 }}>
                {preview.items.slice(0, 40).map((it) => (
                  <div key={it.id} style={{ padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
                    <b>#{it.id}</b>{' '}
                    {it.skipped ? (
                      <span style={{ color: 'var(--warn)' }}>{it.skipped}</span>
                    ) : (
                      (it.preview || []).map((s, si) => (
                        <div key={si} style={{ marginLeft: 10 }}>
                          <span className="tk-hint">{s.label}：</span>
                          {s.willSkip ? (
                            <span style={{ color: 'var(--warn)' }}>将跳过（{s.willSkip}）</span>
                          ) : s.unknown ? (
                            <span style={{ color: 'var(--muted)' }}>{s.unknown}</span>
                          ) : (
                            s.diffs.map((d, di) => (
                              <span key={di} style={{ marginRight: 10 }}>
                                {d.field}：<span style={{ color: 'var(--muted)' }}>{d.before}</span> → {d.after}
                              </span>
                            ))
                          )}
                        </div>
                      ))
                    )}
                  </div>
                ))}
              </div>
              {preview.items.length > 40 && (
                <div className="tk-hint" style={{ marginTop: 6 }}>
                  预览只列出前 40 项（共 {preview.items.length} 项），避免长列表卡住界面
                </div>
              )}
            </div>
          )}

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

          {/* 执行条件：与智能文件夹同一套规则语义（评分 / 标签 / 关键词 / 收藏 / 画幅） */}
          <div className="tk-hint" style={{ margin: '6px 0 4px' }}>
            执行条件（可选，不命中的素材会被跳过）
          </div>
          <div className="tk-row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <select
              className="input"
              value={draft.conditions.combine}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  conditions: { ...d.conditions, combine: e.target.value === 'or' ? 'or' : 'and' },
                }))
              }
              title="多个条件之间怎么组合"
            >
              <option value="and">全部满足（AND）</option>
              <option value="or">满足任一（OR）</option>
            </select>
            <select
              className="input"
              value={draft.conditions.rules.favorite || ''}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  conditions: {
                    ...d.conditions,
                    rules: { ...d.conditions.rules, favorite: (e.target.value || undefined) as 'yes' | 'no' | undefined },
                  },
                }))
              }
            >
              <option value="">收藏：不限</option>
              <option value="yes">只处理已收藏</option>
              <option value="no">只处理未收藏</option>
            </select>
            <input
              className="input"
              type="number"
              min={0}
              max={5}
              style={{ width: 96 }}
              placeholder="评分≥"
              value={draft.conditions.rules.minRating || ''}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  conditions: {
                    ...d.conditions,
                    rules: { ...d.conditions.rules, minRating: Number(e.target.value) || undefined },
                  },
                }))
              }
            />
            <input
              className="input"
              type="number"
              min={0}
              style={{ width: 110 }}
              placeholder="长边≥px"
              value={draft.conditions.rules.minWidth || ''}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  conditions: {
                    ...d.conditions,
                    rules: { ...d.conditions.rules, minWidth: Number(e.target.value) || undefined },
                  },
                }))
              }
            />
            <select
              className="input"
              value={draft.conditions.rules.orientation || ''}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  conditions: {
                    ...d.conditions,
                    rules: {
                      ...d.conditions.rules,
                      orientation: (e.target.value || undefined) as 'landscape' | 'portrait' | 'square' | undefined,
                    },
                  },
                }))
              }
            >
              <option value="">画幅：不限</option>
              <option value="landscape">横图</option>
              <option value="portrait">竖图</option>
              <option value="square">方图</option>
            </select>
            <input
              className="input"
              placeholder="标签包含，逗号分隔"
              value={(draft.conditions.rules.tagsInclude || []).join(',')}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  conditions: {
                    ...d.conditions,
                    rules: { ...d.conditions.rules, tagsInclude: e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) },
                  },
                }))
              }
            />
            <input
              className="input"
              placeholder="标签排除"
              value={(draft.conditions.rules.tagsExclude || []).join(',')}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  conditions: {
                    ...d.conditions,
                    rules: { ...d.conditions.rules, tagsExclude: e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) },
                  },
                }))
              }
            />
            <input
              className="input"
              placeholder="关键词（标题/标签/备注）"
              value={(draft.conditions.rules.keywords || []).join(',')}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  conditions: {
                    ...d.conditions,
                    rules: { ...d.conditions.rules, keywords: e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) },
                  },
                }))
              }
            />
          </div>
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
                onClick={() => setDraft({ name: '', steps: [{ type: 'tag', mode: 'add', tags: '' }], conditions: EMPTY_COND })}
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
