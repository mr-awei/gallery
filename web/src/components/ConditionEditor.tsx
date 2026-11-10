import { useEffect, useState } from 'react';
import type { ActionConditions } from '../api';

type Rules = ActionConditions['rules'];
type ListKey = 'tagsInclude' | 'tagsExclude' | 'keywords' | 'aiKeywords';
type NumKey = 'minRating' | 'minScore' | 'minWidth';

const LISTS: { key: ListKey; placeholder: string }[] = [
  { key: 'tagsInclude', placeholder: '标签包含，逗号分隔' },
  { key: 'tagsExclude', placeholder: '标签排除' },
  { key: 'keywords', placeholder: '关键词（标题/标签/备注）' },
  { key: 'aiKeywords', placeholder: 'AI 关键词（语义命中，如「海边日落」）' },
];

const NUMS: { key: NumKey; placeholder: string; width: number }[] = [
  { key: 'minRating', placeholder: '评分≥', width: 96 },
  { key: 'minScore', placeholder: '匹配度≥', width: 106 },
  { key: 'minWidth', placeholder: '长边≥px', width: 110 },
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
          title="多个条件之间怎么组合"
        >
          <option value="and">全部满足（AND）</option>
          <option value="or">满足任一（OR）</option>
        </select>
        <select
          className="input"
          value={rules.favorite || ''}
          onChange={(e) => setRule('favorite', (e.target.value || undefined) as Rules['favorite'])}
        >
          <option value="">收藏：不限</option>
          <option value="yes">只处理已收藏</option>
          <option value="no">只处理未收藏</option>
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
          <option value="">画幅：不限</option>
          <option value="landscape">横图</option>
          <option value="portrait">竖图</option>
          <option value="square">方图</option>
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
