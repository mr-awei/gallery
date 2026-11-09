import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { MarketPlugin, PluginMarketView } from '../../types';
import Card from './Card';

interface Props {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

const PERMISSION_DESC: Record<string, string> = {
  'image:read': '读取素材的标题 / 标签 / 尺寸等信息',
  'image:write': '回写标签、备注、评分、收藏（会改库）',
  log: '输出运行日志',
};

/** 插件市场：随包索引 + 自定义索引 + URL 在线安装 + 本地包安装 + 卸载 */
export default function PluginMarket({ onToast }: Props) {
  const [view, setView] = useState<PluginMarketView | null>(null);
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [indexUrl, setIndexUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [detail, setDetail] = useState<MarketPlugin | null>(null);

  const load = async () => {
    try {
      setView(await api.pluginMarket());
    } catch (err) {
      onToast(`读取插件市场失败：${(err as Error).message}`, 'error');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const act = async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
      await load();
      onToast(okMsg);
    } catch (err) {
      onToast(`操作失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const install = (id: string) =>
    void act(`install-${id}`, () => api.installPlugin({ id }), '插件已安装，可到「插件」页试运行');

  const uninstall = (id: string) =>
    void act(`uninstall-${id}`, async () => {
      const r = await api.uninstallPlugin(id);
      onToast(r.restoredBuiltin ? '已卸载用户版本，恢复为随包内置版本' : '插件已卸载，运行态立即失效');
    }, '插件已卸载');

  const installFromUrl = () => {
    if (!url.trim()) return onToast('请先填写插件包地址（.tuku-plugin 或 .zip）', 'error');
    void act('url', () => api.installPlugin({ url: url.trim() }), '插件包已下载并安装');
  };

  const uploadFile = async (file: File) => {
    if (!/\.(tuku-plugin|zip|json)$/i.test(file.name)) {
      return onToast('请选择 .tuku-plugin / .zip / .json 插件包', 'error');
    }
    void act('upload', async () => {
      const buf = await file.arrayBuffer();
      return api.uploadPluginPackage(buf, file.name);
    }, '本地插件包已安装');
  };

  const filtered = (view?.plugins || []).filter((p) =>
    `${p.name} ${p.id} ${p.description} ${p.author} ${p.tags.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())
  );

  return (
    <>
      <Card
        title="插件市场"
        desc="浏览可用插件、查看权限声明，一键安装到用户插件目录；也支持从 URL 在线安装或拖入本地插件包。"
        badge={
          <span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>
            {view?.remote ? '自定义索引' : '随包索引'} · {view?.plugins.length || 0} 个
          </span>
        }
      >
        <div className="hint" style={{ lineHeight: 1.8, marginBottom: 12 }}>
          插件跑在独立进程里，只能返回 patch，是否写库由宿主按<b>声明的权限</b>过滤。
          这<strong>不是</strong> OS 级沙箱：只安装你信任的来源。远程下载只允许 http/https 且经逐跳地址校验（拒绝本机、内网与云元数据）。
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 180 }}
            placeholder="搜索插件名称 / 说明 / 标签"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn sm ghost" onClick={() => void load()}>刷新</button>
        </div>

        <div className="settings-subhead">可用插件</div>
        {!filtered.length && <div className="hint">没有匹配的插件。</div>}
        {filtered.map((p) => (
          <div key={p.id} style={{ borderTop: '1px solid var(--border)', padding: '12px 0' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div>
                  <b>{p.name}</b>{' '}
                  <span className="hint">
                    {p.id} · v{p.version} · {p.author || '未署名'}
                    {p.source === 'remote' ? ' · 自定义索引' : ''}
                  </span>
                </div>
                <div className="hint" style={{ lineHeight: 1.7 }}>{p.description}</div>
                <div className="hint">
                  权限：{p.permissions.length ? p.permissions.join(' / ') : '无（纯只读试算）'} · 动作：{p.actions.join(', ')}
                </div>
                {p.tags.length > 0 && <div className="hint">标签：{p.tags.join(' · ')}</div>}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="btn sm ghost" onClick={() => setDetail(detail?.id === p.id ? null : p)}>
                  权限详情
                </button>
                {p.installed ? (
                  p.installedBuiltin ? (
                    <span className="hint" style={{ alignSelf: 'center' }}>已随包安装 v{p.installedVersion}</span>
                  ) : (
                    <button className="btn sm ghost" disabled={!!busy} onClick={() => uninstall(p.id)}>
                      {busy === `uninstall-${p.id}` ? '卸载中…' : '卸载'}
                    </button>
                  )
                ) : (
                  <button className="btn sm" disabled={!!busy} onClick={() => install(p.id)}>
                    {busy === `install-${p.id}` ? '安装中…' : '一键安装'}
                  </button>
                )}
              </div>
            </div>
            {detail?.id === p.id && (
              <div className="hint" style={{ marginTop: 8, padding: 10, background: 'var(--panel-strong)', borderRadius: 8 }}>
                <b>安装前请确认这些能力</b>
                {p.permissions.map((perm) => (
                  <div key={perm}>· <code>{perm}</code> — {PERMISSION_DESC[perm] || '未说明的能力'}</div>
                ))}
                {!p.permissions.length && <div>· 不申请任何权限，拿不到素材信息也写不了库</div>}
                <div style={{ marginTop: 6 }}>
                  入口：<code>{p.package || p.downloadUrl || '（未提供包地址）'}</code>
                </div>
              </div>
            )}
          </div>
        ))}
      </Card>

      <Card title="在线安装与自定义索引" desc="从任意公开地址安装插件包，或加载自己的市场索引。">
        <div className="settings-subhead">从 URL 安装插件包</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="https://example.com/plugins/my-plugin.tuku-plugin"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="btn sm" disabled={!!busy} onClick={installFromUrl}>
            {busy === 'url' ? '下载中…' : '下载并安装'}
          </button>
        </div>

        <div className="settings-subhead">拖入本地插件包</div>
        <label
          className="btn sm ghost"
          style={{ display: 'inline-flex', cursor: 'pointer' }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (file) void uploadFile(file);
          }}
        >
          {busy === 'upload' ? '安装中…' : '选择 / 拖入 .tuku-plugin 或 .zip'}
          <input
            type="file"
            hidden
            accept=".tuku-plugin,.zip,.json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadFile(file);
              e.target.value = '';
            }}
          />
        </label>
        <div className="hint" style={{ marginTop: 6 }}>
          包格式：<code>{'{ format: "tuku-plugin/1", manifest, files }'}</code> 的 JSON，或含 <code>plugin.json</code> + 入口的 ZIP。
          路径穿越、非法文件类型、超大包与未知权限都会被拒绝。
        </div>

        <div className="settings-subhead">自定义市场索引</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="https://example.com/plugin-market/index.json"
            value={indexUrl}
            onChange={(e) => setIndexUrl(e.target.value)}
          />
          <button
            className="btn sm"
            disabled={!!busy}
            onClick={() =>
              void act('index', () => api.refreshPluginMarket(indexUrl.trim()), '已加载自定义索引')
            }
          >
            加载索引
          </button>
          <button className="btn sm ghost" disabled={!!busy} onClick={() => void act('reset', () => api.resetPluginMarket(), '已恢复随包索引')}>
            恢复随包索引
          </button>
        </div>
        <div className="hint">自定义索引只保存在内存里，重启应用会回到随包索引，不会留下持久的外部地址。</div>
      </Card>
    </>
  );
}
