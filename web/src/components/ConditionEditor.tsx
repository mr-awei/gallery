import { useEffect, useState } from 'react';
import type { ActionConditions } from '../api';
import i18n from '../i18n';

type Rules = ActionConditions['rules'];
type ListKey = 'tagsInclude' | 'tagsExclude' | 'keywords' | 'aiKeywords';
type NumKey = 'minRating' | 'minScore' | 'minWidth';

const LISTS: { key: ListKey; placeholder: string }[] = [
  { key: 'tagsInclude', placeholder: i18n.t('k0b0d3ba0') },
  { key: 'tagsExclude', placeholder: i18n.t('k8807c44d') },
  { key: 'keywords', placeholder: i18n.t('k3d8c72cb') },
  { key: 'aiKeywords', placeholder: i18n.t('kd4f03624') },
];

const NUMS: { key: NumKey; placeholder: string; width: number }[] = [
  { key: 'minRating', placeholder: i18n.t('k420e3742'), width: 96 },
  { key: 'minScore', placeholder: i18n.t('k71907238'), width: 106 },
  { key: 'minWidth', placeholder: i18n.t('kac953386'), width: 110 },
];

/** 与后端同语义：中英文逗号都算分隔符 */
export const splitConditionList = (s: string) =>
  String(s || '')
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean);

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * 列表条件输入框。
 * 受控值若直接写 `value.join(',')`，用户敲下的逗号会被 split→filter→join 立刻抹掉，
 * 「旅行, 海边」根本打不出来（只能整段粘贴）。这里保留原始文本，只在外部重置时回填。
 */
function ListInput({
  placeholder,
  value,
  onChange,
}: {
  placeholder: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [text, setText] = useState(() => value.join(','));
  useEffect(() => {
    setText((cur) => (sameList(splitConditionList(cur), value) ? cur : value.join(',')));
  }, [value]);
  return (
    <input
      className="input"
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(splitConditionList(e.target.value));
      }}
      onBlur={() => setText(splitConditionList(text).join(', '))}
    />
  );
}

/**
 * 动作/智能文件夹共用的执行条件行。
 * 字段与后端 server/lib/actions.js 的 normalizeRules 白名单一一对应：
 * 少一个字段，用户就只能建出「永远跳过一半素材」的宏，且界面上看不出来。
 */
export default function ConditionEditor({
  value,
  onChange,
}: {
  value: ActionConditions;
  onChange: (v: ActionConditions) => void;
}) {
  const rules = value.rules;
  const setRule = <K extends keyof Rules>(key: K, v: Rules[K]) =>
    onChange({ ...value, rules: { ...rules, [key]: v } });
  const setNum = (key: NumKey, raw: string) => {
    const n = Number(raw) > 0 ? Number(raw) : undefined;
    onChange({ ...value, rules: { ...rules, [key]: n } });
  };

  return (
    <>
      <div className="tk-row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <select
          className="input"
          value={value.combine}
          onChange={(e) => onChange({ ...value, combine: e.target.value === 'or' ? 'or' : 'and' })}
          title={i18n.t('k999d46b2')}
        >
          <option value="and">{i18n.t('kd6cd3f42')}</option>
          <option value="or">{i18n.t('k4f0f980f')}</option>
        </select>
        <select
          className="input"
          value={rules.favorite || ''}
          onChange={(e) => setRule('favorite', (e.target.value || undefined) as Rules['favorite'])}
        >
          <option value="">{i18n.t('k326c052e')}</option>
          <option value="yes">{i18n.t('keb0ee242')}</option>
          <option value="no">{i18n.t('k9471ac48')}</option>
        </select>
        {NUMS.map((f) => (
          <input
            key={f.key}
            className="input"
            type="number"
            min={0}
            max={f.key === 'minRating' ? 5 : undefined}
            style={{ width: f.width }}
            placeholder={f.placeholder}
            value={rules[f.key] || ''}
            onChange={(e) => setNum(f.key, e.target.value)}
          />
        ))}
        <select
          className="input"
          value={rules.orientation || ''}
          onChange={(e) => setRule('orientation', (e.target.value || undefined) as Rules['orientation'])}
        >
          <option value="">{i18n.t('kc587a1fd')}</option>
          <option value="landscape">{i18n.t('kaffd00f2')}</option>
          <option value="portrait">{i18n.t('k1d4b5f79')}</option>
          <option value="square">{i18n.t('k5c036336')}</option>
        </select>
        {LISTS.map((f) => (
          <ListInput
            key={f.key}
            placeholder={f.placeholder}
            value={rules[f.key] || []}
            onChange={(v) => setRule(f.key, v)}
          />
        ))}
      </div>
    </>
  );
}
