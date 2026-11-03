import React, { useEffect, useMemo, useState } from 'react';
import type { SmartFolder } from '../api';

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
  };
}

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
    return base;
  }, [form, initial]);

  const condCount = Object.keys(rules).length;

  const submit = async () => {
    if (!form.name.trim()) {
      setErr('请填写名称');
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
          <b>{initial ? '编辑智能文件夹' : '新建智能文件夹'}</b>
          <button className="btn ghost sm" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="modal-body" style={{ display: 'block' }}>
          <div className="field">
            <label>名称</label>
            <input
              className="input"
              value={form.name}
              placeholder="如「高清演唱会」"
              onChange={(e) => set('name', e.target.value)}
            />
          </div>

          <div className="sf-grid">
            <div className="field">
              <label>收藏状态</label>
              <select
                className="input"
                value={form.favorite}
                onChange={(e) => set('favorite', e.target.value as Form['favorite'])}
              >
                <option value="">不限</option>
                <option value="yes">仅收藏</option>
                <option value="no">未收藏</option>
              </select>
            </div>
            <div className="field">
              <label>方向</label>
              <select
                className="input"
                value={form.orientation}
                onChange={(e) => set('orientation', e.target.value as Form['orientation'])}
              >
                <option value="">不限</option>
                <option value="landscape">横图</option>
                <option value="portrait">竖图</option>
                <option value="square">方图</option>
              </select>
            </div>
            <div className="field">
              <label>最低星级（0-5）</label>
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
              <label>最低评分（0-100）</label>
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
              <label>最短边不小于（px）</label>
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
            <label>包含标签（逗号分隔，需全部命中）</label>
            <input
              className="input"
              value={form.tagsInclude}
              placeholder="演唱会，live"
              onChange={(e) => set('tagsInclude', e.target.value)}
            />
          </div>
          <div className="field">
            <label>排除标签（含任意一个即排除）</label>
            <input
              className="input"
              value={form.tagsExclude}
              placeholder="截图，表情包"
              onChange={(e) => set('tagsExclude', e.target.value)}
            />
          </div>
          <div className="field">
            <label>关键词（标题 / 标签 / 备注里包含）</label>
            <input
              className="input"
              value={form.keywords}
              placeholder="邓紫棋"
              onChange={(e) => set('keywords', e.target.value)}
            />
          </div>
          <div className="field">
            <label>AI 描述关键词</label>
            <input
              className="input"
              value={form.aiKeywords}
              placeholder="舞台 / 灯光"
              onChange={(e) => set('aiKeywords', e.target.value)}
            />
          </div>
          <div className="field">
            <label>自动标签（命中的图片可一键继承这些标签）</label>
            <input
              className="input"
              value={form.autoTags}
              placeholder="演唱会，live"
              onChange={(e) => set('autoTags', e.target.value)}
            />
          </div>

          <p className="muted small">
            共 {condCount} 个条件{condCount === 0 ? '（无条件 = 命中全部图片，建议至少加一条）' : ''}
          </p>
          {err && <p className="danger small">{err}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            {busy ? '保存中…' : initial ? '保存修改' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
