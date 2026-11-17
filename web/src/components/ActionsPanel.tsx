import { useCallback, useEffect, useState } from 'react';
import { api, formatDate, quiet } from '../api';
import type { ActionConditions, ActionDef, ActionPreviewStep, ActionStep } from '../api';
import type { FolderNode } from '../types';
import { IconClose, IconTrash } from './Icons';
import ConditionEditor from './ConditionEditor';
import i18n from '../i18n';

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
      setLog(i18n.t('k19aeb2ab'));
      return;
    }
    setBusy(`run-${a.id}`);
    setLog('');
    try {
      const r = await api.runAction(a.id, ids);
      const firstErr = r.items.find((x) => !x.ok)?.error;
      setLog(
        i18n.t('kd17be0e0', { p0: r.action.name, p1: r.okCount }) +
          `${r.skipped ? `，跳过 ${r.skipped} 张（条件不匹配）` : ''}` +
          `${r.failed ? `，失败 ${r.failed} 张（${firstErr || ''}）` : ''}`
      );
      if (r.okCount) setLastRun({ id: a.id, name: r.action.name });
      onToast?.(i18n.t('kbc73fbdc', { p0: r.okCount, p1: r.total, p2: r.skipped ? i18n.t('k609f9c59', { p0: r.skipped }) : '' }));
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
      setLog(i18n.t('k19aeb2ab'));
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
      setLog(i18n.t('kc935dac8', { p0: r.total - r.skipped, p1: r.skipped }));
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
      setLog(i18n.t('k051ba703', { p0: lastRun?.name || i18n.t('kbbd69f7d'), p1: r.op }));
      onToast?.(i18n.t('k066edc8a'));
      setLastRun(null);
      onRefresh?.();
    } catch (e) {
      setLog(i18n.t('k5b0be54d', { p0: (e as Error).message }));
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    if (!draft.name.trim()) {
      setLog(i18n.t('k632c4e2b'));
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
      setLog(i18n.t('kf8dfedcd'));
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
          <b>{i18n.t('kc500cfab')}</b>
          <span className="tk-title">{ids.length ? i18n.t('k9aeddbd3', { p0: ids.length }) : i18n.t('kbcc9f8b5')}</span>
          <button className="icon-btn" onClick={onClose} title={i18n.t('kb15d9127')}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body tk-body">
          <h4 className="section-title">{i18n.t('kb4411aa8')}</h4>
          {actions.length === 0 && <div className="tk-empty">{i18n.t('k68beae2e')}</div>}
          <div className="tk-actions">
            {actions.map((a) => (
              <div className="tk-action" key={a.id}>
                <div>
                  <b>{a.name}</b>
                  <div className="tk-hint">
                    {a.steps.map((s) => types[s.type]?.label || s.type).join(' → ')}
                    {a.lastRunAt ? i18n.t('k36a36fdb', { p0: formatDate(a.lastRunAt) }) : ''}
                  </div>
                </div>
                <div className="tk-row">
                  <button className="btn sm ghost" disabled={!!busy} onClick={() => dryRun(a)} title={i18n.t('k077cb160')}>
                    {busy === `dry-${a.id}` ? i18n.t('kba434fbf') : i18n.t('kae6769da')}
                  </button>
                  <button className="btn sm" disabled={!!busy} onClick={() => run(a)}>
                    {busy === `run-${a.id}` ? i18n.t('kbef6b130') : i18n.t('k1a6aa24e')}
                  </button>
                  <button
                    className="btn sm ghost"
                    onClick={() => setDraft({ id: a.id, name: a.name, steps: a.steps, conditions: a.conditions || EMPTY_COND })}
                    title={i18n.t('k9ad29bf6')}
                  >
                    {i18n.t('k95b351c8')}
                  </button>
                  <button
                    className="btn sm ghost danger"
                    onClick={async () => {
                      // 以前是 catch(quiet)：删失败了按钮也毫无反应，用户会反复点
                      try {
                        await api.deleteAction(a.id);
                        load();
                      } catch (err) {
                        const msg = i18n.t('kf97bd7bc', { p0: a.name, p1: (err as Error).message });
                        setLog(msg);
                        onToast?.(msg);
                      }
                    }}
                    title={i18n.t('kfaa2858f')}
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
                {busy === 'undo' ? i18n.t('kab341812') : i18n.t('kee1f6522')}
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
            {draft.id ? i18n.t('k9130cd37') : i18n.t('kdc2d2427')}
          </h4>
          <input
            className="input"
            style={{ width: '100%', marginBottom: 8 }}
            placeholder={i18n.t('k7ac52a32')}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />

          {/* 执行条件：与智能文件夹同一套规则语义（评分 / AI 匹配度 / 标签 / 关键词 / 收藏 / 画幅） */}
          <div className="tk-hint" style={{ margin: '6px 0 4px' }}>
            {i18n.t('ka8d3c838')}
          </div>
          <ConditionEditor
            value={draft.conditions}
            onChange={(conditions) => setDraft((d) => ({ ...d, conditions }))}
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
                    <option value="add">{i18n.t('kb58c7549')}</option>
                    <option value="remove">{i18n.t('k86048b4f')}</option>
                    <option value="replace">{i18n.t('ke22c9a05')}</option>
                  </select>
                  <input
                    className="input"
                    placeholder={i18n.t('k9745f021')}
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
                    <option value="append">{i18n.t('k7dc3a574')}</option>
                    <option value="replace">{i18n.t('ke22c9a05')}</option>
                  </select>
                  <input
                    className="input"
                    placeholder={i18n.t('k2f4c8baa')}
                    value={s.text || ''}
                    onChange={(e) => patch(i, { text: e.target.value })}
                  />
                </>
              )}
              {s.type === 'title' && (
                <>
                  <select className="input" value={s.mode || 'template'} onChange={(e) => patch(i, { mode: e.target.value })}>
                    <option value="template">{i18n.t('k59cf15fe')}</option>
                    <option value="prefix">{i18n.t('k4c9bb426')}</option>
                    <option value="suffix">{i18n.t('k242d641e')}</option>
                  </select>
                  <input
                    className="input"
                    placeholder={s.mode === 'template' ? '{keyword}-{index}' : i18n.t('k4b780462')}
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
                  <option value="">{i18n.t('kaaa4b65e')}</option>
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
                  <option value="on">{i18n.t('kae336cd0')}</option>
                  <option value="off">{i18n.t('kf22cec28')}</option>
                </select>
              )}
              {s.type === 'aiPrompt' && (
                <>
                  <input
                    className="input"
                    placeholder={i18n.t('ka33fdea8')}
                    value={s.instruction || ''}
                    onChange={(e) => patch(i, { instruction: e.target.value })}
                  />
                  <select className="input" value={s.target || 'note'} onChange={(e) => patch(i, { target: e.target.value })}>
                    <option value="note">{i18n.t('kac11c31b')}</option>
                    <option value="title">{i18n.t('kc6117b53')}</option>
                    <option value="tags">{i18n.t('k3e370e86')}</option>
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
                title={i18n.t('kd9cf3562')}
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
              {i18n.t('k82478f85')}
            </button>
            <button className="btn sm primary" disabled={busy === 'save'} onClick={save}>
              {draft.id ? i18n.t('kc5575b3f') : i18n.t('k5a56b871')}
            </button>
            {draft.id && (
              <button
                className="btn sm ghost"
                onClick={() => setDraft({ name: '', steps: [{ type: 'tag', mode: 'add', tags: '' }], conditions: EMPTY_COND })}
              >
                {i18n.t('kcbb46593')}
              </button>
            )}
          </div>
          {log && <div className="tk-hint">{log}</div>}
        </div>
      </div>
    </div>
  );
}
