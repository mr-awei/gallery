import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import Card from './Card';
import i18n from '../../i18n';

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
      onToast(i18n.t('k0ee4020f'), 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await api.setTagAlias(a, t);
      setAliases(r.aliases);
      setAlias('');
      onToast(i18n.t('k146cd5e5', { p0: a, p1: t }));
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
      onToast(i18n.t('ke9331623', { p0: a }));
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };

  return (
    <Card
      title={i18n.t('k7c0d5b34')}
      desc={i18n.t('k54f313e6')}
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="input"
          placeholder={i18n.t('ka2d2419d')}
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          style={{ width: 160 }}
        />
        <span style={{ color: 'var(--muted)' }}>→</span>
        <input
          className="input"
          list="alias-tag-options"
          placeholder={i18n.t('k62624bdd')}
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
          {busy ? i18n.t('k9b5d32d1') : i18n.t('kb58c7549')}
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
                  title={i18n.t('kc7119e36')}
                >
                  {i18n.t('k2f4aaddd')}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="settings-desc" style={{ margin: 0 }}>
            {i18n.t('k63bbd6ed')}
          </div>
        )}
      </div>
    </Card>
  );
}
