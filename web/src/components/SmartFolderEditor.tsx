import React, { useEffect, useMemo, useState } from 'react';
import type { SmartFolder } from '../api';
import i18n from '../i18n';

interface Props {
  /** 传入 = 编辑既有智能文件夹；不传 = 新建 */
  initial?: SmartFolder | null;
  onClose: () => void;
  onSubmit: (payload: {
    name: string;
    rules: Record<string, unknown>;
    autoTags: string[];
  }) => Promise<void> | void;
}

/** 一组条件：组内按 op 连接（「UI 或 图标」就是一个 or 组） */
type GroupForm = {
  op: 'and' | 'or';
  tagsInclude: string;
  tagsExclude: string;
  keywords: string;
  minRating: string;
};

type Form = {
  name: string;
  favorite: '' | 'yes' | 'no';
  minRating: string;
  minScore: string;
  minWidth: string;
  orientation: '' | 'landscape' | 'portrait' | 'square';
  tagsInclude: string;
  tagsExclude: string;
  keywords: string;
  aiKeywords: string;
  autoTags: string;
  /** 组与组之间怎么连 */
  combine: 'and' | 'or';
  groups: GroupForm[];
};

const EMPTY: Form = {
  name: '',
  favorite: '',
  minRating: '',
  minScore: '',
  minWidth: '',
  orientation: '',
  tagsInclude: '',
  tagsExclude: '',
  keywords: '',
  aiKeywords: '',
  autoTags: '',
  combine: 'and',
  groups: [],
};

const csv = (s: string) =>
  String(s || '')
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean);

function formOf(f: SmartFolder | null | undefined): Form {
  if (!f) return { ...EMPTY };
  const r = (f.rules || {}) as Record<string, unknown>;
  const num = (v: unknown) => (Number(v) > 0 ? String(Number(v)) : '');
  return {
    name: f.name,
    favorite: r.favorite === 'yes' || r.favorite === 'no' ? r.favorite : '',
    minRating: num(r.minRating),
    minScore: num(r.minScore),
    minWidth: num(r.minWidth),
    orientation:
      r.orientation === 'landscape' || r.orientation === 'portrait' || r.orientation === 'square'
        ? r.orientation
        : '',
    tagsInclude: Array.isArray(r.tagsInclude) ? (r.tagsInclude as string[]).join('，') : '',
    tagsExclude: Array.isArray(r.tagsExclude) ? (r.tagsExclude as string[]).join('，') : '',
    keywords: Array.isArray(r.keywords) ? (r.keywords as string[]).join('，') : '',
    aiKeywords: Array.isArray(r.aiKeywords) ? (r.aiKeywords as string[]).join('，') : '',
    autoTags: (f.autoTags || []).join('，'),
    combine: String(r.combine).toUpperCase() === 'OR' ? 'or' : 'and',
    groups: (Array.isArray(r.groups) ? r.groups : []).map((g) => {
      const gr = ((g as Record<string, unknown>)?.rules || g || {}) as Record<string, unknown>;
      const list = (v: unknown) => (Array.isArray(v) ? (v as string[]).join('，') : '');
      return {
        op: String((g as Record<string, unknown>)?.op).toUpperCase() === 'OR' ? 'or' : 'and',
        tagsInclude: list(gr.tagsInclude),
        tagsExclude: list(gr.tagsExclude),
        keywords: list(gr.keywords),
        minRating: num(gr.minRating),
      };
    }),
  };
}

const GROUP_EMPTY: GroupForm = { op: 'and', tagsInclude: '', tagsExclude: '', keywords: '', minRating: '' };
const groupHasRule = (g: GroupForm) =>
  !!(csv(g.tagsInclude).length || csv(g.tagsExclude).length || csv(g.keywords).length || Number(g.minRating) > 0);

/**
 * 智能文件夹编辑器（对标 Eagle 的条件面板）。
 * 之前只能手写 JSON，等于「建了就改不了」；这里把规则拆成表单，
 * 同时保留原始 rules 里认不出的键，避免保存时把未知条件悄悄丢掉。
 */
export default function SmartFolderEditor({ initial, onClose, onSubmit }: Props) {
  const [form, setForm] = useState<Form>(() => formOf(initial));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setForm(formOf(initial));
    setErr('');
  }, [initial]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((p) => ({ ...p, [k]: v }));

  /** 汇总成规则对象：只写用户真正填了的条件 */
  const rules = useMemo(() => {
    const base: Record<string, unknown> = { ...((initial?.rules || {}) as Record<string, unknown>) };
    const put = (key: string, val: unknown) => {
      if (val === '' || val == null || (Array.isArray(val) && !val.length)) delete base[key];
      else base[key] = val;
    };
    put('favorite', form.favorite || '');
    put('minRating', Number(form.minRating) > 0 ? Number(form.minRating) : 0);
    put('minScore', Number(form.minScore) > 0 ? Number(form.minScore) : 0);
    put('minWidth', Number(form.minWidth) > 0 ? Number(form.minWidth) : 0);
    put('orientation', form.orientation || '');
    put('tagsInclude', csv(form.tagsInclude));
    put('tagsExclude', csv(form.tagsExclude));
    put('keywords', csv(form.keywords));
    put('aiKeywords', csv(form.aiKeywords));
    // 分组：只写有内容的分组，空组会污染 OR 组合（会命中全库）
    const groups = form.groups.filter(groupHasRule).map((g) => {
      const rulesOfGroup: Record<string, unknown> = {};
      if (csv(g.tagsInclude).length) rulesOfGroup.tagsInclude = csv(g.tagsInclude);
      if (csv(g.tagsExclude).length) rulesOfGroup.tagsExclude = csv(g.tagsExclude);
      if (csv(g.keywords).length) rulesOfGroup.keywords = csv(g.keywords);
      if (Number(g.minRating) > 0) rulesOfGroup.minRating = Number(g.minRating);
      return { op: g.op, rules: rulesOfGroup };
    });
    if (groups.length) {
      base.groups = groups;
      base.combine = form.combine;
    } else {
      delete base.groups;
      delete base.combine;
    }
    return base;
  }, [form, initial]);

  const condCount = Object.keys(rules).filter((k) => k !== 'groups' && k !== 'combine').length +
    (Array.isArray(rules.groups) ? rules.groups.length : 0);

  const setGroup = (i: number, patch: Partial<GroupForm>) =>
    setForm((p) => ({ ...p, groups: p.groups.map((g, idx) => (idx === i ? { ...g, ...patch } : g)) }));

  const submit = async () => {
    if (!form.name.trim()) {
      setErr(i18n.t('k856d0df5'));
      return;
    }
    // 没有条件就不是「全库」而是「什么都没配」：后端会直接拒绝，这里先说清楚
    if (condCount === 0) {
      setErr(i18n.t('kd384dc66'));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await onSubmit({
        name: form.name.trim(),
        rules,
        autoTags: csv(form.autoTags),
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{initial ? i18n.t('k607a8da0') : i18n.t('k1bc362a1')}</b>
          <button className="btn ghost sm" onClick={onClose}>
            {i18n.t('kb15d9127')}
          </button>
        </div>
        <div className="modal-body" style={{ display: 'block' }}>
          <div className="field">
            <label>{i18n.t('kd7ec2d3f')}</label>
            <input
              className="input"
              value={form.name}
              placeholder={i18n.t('k33f77c3b')}
              onChange={(e) => set('name', e.target.value)}
            />
          </div>

          <div className="sf-grid">
            <div className="field">
              <label>{i18n.t('kdd53170d')}</label>
              <select
                className="input"
                value={form.favorite}
                onChange={(e) => set('favorite', e.target.value as Form['favorite'])}
              >
                <option value="">{i18n.t('k8441b348')}</option>
                <option value="yes">{i18n.t('k9dd8a82d')}</option>
                <option value="no">{i18n.t('k1a994188')}</option>
              </select>
            </div>
            <div className="field">
              <label>{i18n.t('ka465db53')}</label>
              <select
                className="input"
                value={form.orientation}
                onChange={(e) => set('orientation', e.target.value as Form['orientation'])}
              >
                <option value="">{i18n.t('k8441b348')}</option>
                <option value="landscape">{i18n.t('kaffd00f2')}</option>
                <option value="portrait">{i18n.t('k1d4b5f79')}</option>
                <option value="square">{i18n.t('k5c036336')}</option>
              </select>
            </div>
            <div className="field">
              <label>{i18n.t('keec808f1')}</label>
              <input
                className="input"
                type="number"
                min={0}
                max={5}
                value={form.minRating}
                onChange={(e) => set('minRating', e.target.value)}
              />
            </div>
            <div className="field">
              <label>{i18n.t('kfd9ee7dd')}</label>
              <input
                className="input"
                type="number"
                min={0}
                max={100}
                value={form.minScore}
                onChange={(e) => set('minScore', e.target.value)}
              />
            </div>
            <div className="field">
              <label>{i18n.t('k0adbf68e')}</label>
              <input
                className="input"
                type="number"
                min={0}
                value={form.minWidth}
                onChange={(e) => set('minWidth', e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label>{i18n.t('ke0cf3b39')}</label>
            <input
              className="input"
              value={form.tagsInclude}
              placeholder={i18n.t('k860c201e')}
              onChange={(e) => set('tagsInclude', e.target.value)}
            />
          </div>
          <div className="field">
            <label>{i18n.t('k86ba5e32')}</label>
            <input
              className="input"
              value={form.tagsExclude}
              placeholder={i18n.t('k3ec735a7')}
              onChange={(e) => set('tagsExclude', e.target.value)}
            />
          </div>
          <div className="field">
            <label>{i18n.t('k0dcd0044')}</label>
            <input
              className="input"
              value={form.keywords}
              placeholder={i18n.t('k6ba6853a')}
              onChange={(e) => set('keywords', e.target.value)}
            />
          </div>
          <div className="field">
            <label>{i18n.t('k569ab0f2')}</label>
            <input
              className="input"
              value={form.aiKeywords}
              placeholder={i18n.t('k4d008f56')}
              onChange={(e) => set('aiKeywords', e.target.value)}
            />
          </div>
          <div className="field">
            <label>
              条件分组（可选，用于 AND/OR 嵌套）
              {form.groups.length > 0 && (
                <select
                  className="input"
                  style={{ width: 110, display: 'inline-block', marginLeft: 8 }}
                  value={form.combine}
                  onChange={(e) => set('combine', e.target.value as Form['combine'])}
                >
                  <option value="and">{i18n.t('k462da310')}</option>
                  <option value="or">{i18n.t('k73187dea')}</option>
                </select>
              )}
            </label>
            <p className="muted small" style={{ margin: '2px 0 6px' }}>
              {i18n.t('k9826b041')}
            </p>
            {form.groups.map((g, i) => (
              <div key={i} className="sf-grid" style={{ marginBottom: 6 }}>
                <select
                  className="input"
                  value={g.op}
                  onChange={(e) => setGroup(i, { op: e.target.value as GroupForm['op'] })}
                >
                  <option value="and">{i18n.t('k5f6ec1c3')}</option>
                  <option value="or">{i18n.t('k52bf3bbf')}</option>
                </select>
                <input
                  className="input"
                  value={g.tagsInclude}
                  placeholder={i18n.t('kcbf2934d')}
                  onChange={(e) => setGroup(i, { tagsInclude: e.target.value })}
                />
                <input
                  className="input"
                  value={g.tagsExclude}
                  placeholder={i18n.t('ke8d7cd76')}
                  onChange={(e) => setGroup(i, { tagsExclude: e.target.value })}
                />
                <input
                  className="input"
                  value={g.keywords}
                  placeholder={i18n.t('k9699a50e')}
                  onChange={(e) => setGroup(i, { keywords: e.target.value })}
                />
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={5}
                  value={g.minRating}
                  placeholder={i18n.t('k23db77cb')}
                  onChange={(e) => setGroup(i, { minRating: e.target.value })}
                />
                <button
                  className="btn ghost sm"
                  onClick={() => setForm((p) => ({ ...p, groups: p.groups.filter((_, idx) => idx !== i) }))}
                >
                  {i18n.t('k2f4aaddd')}
                </button>
              </div>
            ))}
            <button
              className="btn ghost sm"
              onClick={() => setForm((p) => ({ ...p, groups: [...p.groups, { ...GROUP_EMPTY }] }))}
            >
              {i18n.t('kbbb7bb51')}
            </button>
          </div>
          <div className="field">
            <label>{i18n.t('k09ea41e2')}</label>
            <input
              className="input"
              value={form.autoTags}
              placeholder={i18n.t('k860c201e')}
              onChange={(e) => set('autoTags', e.target.value)}
            />
          </div>

          <p className="muted small">
            共 {condCount} 个条件{condCount === 0 ? i18n.t('k40399d8d') : ''}
          </p>
          {err && <p className="danger small">{err}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            {i18n.t('k625fb26b')}
          </button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            {busy ? i18n.t('k9b5d32d1') : initial ? i18n.t('kc5575b3f') : i18n.t('kd9ac9228')}
          </button>
        </div>
      </div>
    </div>
  );
}
