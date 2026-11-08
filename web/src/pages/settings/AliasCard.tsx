import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import Card from './Card';

/**
 * 标签别名 / 同义词。
 *
 * 只做「查询展开」：搜「写真」时把绑定到「人像」的别名一并展开，图片本身的 tags 不会被改写。
 * 因此删别名是零风险的（不像改标签名要迁移所有图片），改标签名/合并/删除时后端会自动迁移别名。
 */
export default function AliasCard({ onToast }: { onToast: (msg: string, kind?: 'info' | 'error') => void }) {
  const [aliases, setAliases] = useState<{ alias: string; tag: string }[]>([]);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [alias, setAlias] = useState('');
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      // 别名下拉只需要候选标签，不必把整棵标签树（大库几千条）拉回来
      const [a, t] = await Promise.all([api.tagAliases(), api.tags({ limit: 200 })]);
      setAliases(a.aliases);
      setTags(t.tags.map((x) => ({ tag: x.tag, count: x.count })));
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  }, [onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    const a = alias.trim();
    const t = tag.trim();
    if (!a || !t) {
      onToast('别名和目标标签都要填', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await api.setTagAlias(a, t);
      setAliases(r.aliases);
      setAlias('');
      onToast(`已把「${a}」设为「${t}」的同义词`);
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: string) => {
    try {
      const r = await api.deleteTagAlias(a);
      setAliases(r.aliases);
      onToast(`已删除同义词「${a}」`);
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };

  return (
    <Card
      title="标签别名 / 同义词"
      desc="搜「写真」也能搜到标了「人像」的素材。别名只影响搜索，不改动图片上的标签。"
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="input"
          placeholder="别名，如：写真"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          style={{ width: 160 }}
        />
        <span style={{ color: 'var(--muted)' }}>→</span>
        <input
          className="input"
          list="alias-tag-options"
          placeholder="目标标签，如：人像"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          style={{ width: 180 }}
        />
        <datalist id="alias-tag-options">
          {tags.map((t) => (
            <option key={t.tag} value={t.tag}>
              {t.tag}（{t.count}）
            </option>
          ))}
        </datalist>
        <button className="btn primary" onClick={submit} disabled={busy}>
          {busy ? '保存中…' : '添加'}
        </button>
      </div>

      <div style={{ marginTop: 14 }}>
        {aliases.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {aliases.map((a) => (
              <div
                key={a.alias}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                }}
              >
                <code style={{ fontSize: 12.5 }}>{a.alias}</code>
                <span style={{ color: 'var(--muted)' }}>→</span>
                <b style={{ fontWeight: 500 }}>{a.tag}</b>
                <button
                  className="btn sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => void remove(a.alias)}
                  title="删除这个同义词（图片上的标签不受影响）"
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="settings-desc" style={{ margin: 0 }}>
            还没有同义词。适合放「英文/中文」「俗称/正名」这类成对说法。
          </div>
        )}
      </div>
    </Card>
  );
}
