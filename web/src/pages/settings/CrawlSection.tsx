/**
 * 采集设置：采集源开关 / 微博登录凭据 / 关键词管理 / 抓取量与质量过滤。
 *
 * 从 Settings.tsx 拆出（原文件 860 行、单页塞了 6 个区块）。
 * 纯受控组件：所有状态仍在 Settings，避免拆分改变原有保存/校验行为。
 */
import type { SourceInfo } from '../../api';
import { IconTrash } from '../../components/Icons';
import type { Keyword, Settings as SettingsType } from '../../types';
import Card from './Card';
import i18n from '../../i18n';

interface Props {
  settings: SettingsType;
  patch: (p: Partial<SettingsType>) => void;
  isDesktop: boolean;
  /** 采集源（由 /api/sources 下发，前端不再维护副本） */
  sources: SourceInfo[];
  toggleSource: (key: string) => void;
  wbLogin: boolean;
  weiboLogin: () => void;
  wbCookieDraft: string;
  setWbCookieDraft: (v: string) => void;
  clearWeiboCookie: () => void;
  keywords: Keyword[];
  toggleKeyword: (k: Keyword) => void;
  removeKeyword: (id: number) => void;
  newKw: string;
  setNewKw: (v: string) => void;
  addKeyword: () => void;
}

export default function CrawlSection({
  settings,
  patch,
  isDesktop,
  sources,
  toggleSource,
  wbLogin,
  weiboLogin,
  wbCookieDraft,
  setWbCookieDraft,
  clearWeiboCookie,
  keywords,
  toggleKeyword,
  removeKeyword,
  newKw,
  setNewKw,
  addKeyword,
}: Props) {
  return (
    <>
        <Card title={i18n.t('kad00783c')} desc={i18n.t('k7200cdb3')}>
          {sources.map((s) => (
            <div className="switch-row" key={s.key} title={s.hint}>
              <span>
                {s.label}
                {s.needsCookie && <span className="src-hint">{i18n.t('k47d2f2f9')}</span>}
                {s.hint && <div className="hint" style={{ marginTop: 2 }}>{s.hint}</div>}
              </span>
              <input type="checkbox" checked={!!settings.sources[s.key]} onChange={() => toggleSource(s.key)} />
            </div>
          ))}
          <div className="field" style={{ marginTop: 14 }}>
            <label>{i18n.t('ke04832f9')}</label>
            {isDesktop && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button className="btn sm" onClick={weiboLogin} disabled={wbLogin}>
                  {wbLogin ? i18n.t('k826ffd8e') : i18n.t('kdf00f559')}
                </button>
              </div>
            )}
            <textarea
              className="input"
              rows={2}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
              value={wbCookieDraft}
              placeholder={settings.hasWeiboCookie ? i18n.t('ka43bac7b') : i18n.t('kd7b9a929')}
              onChange={(e) => setWbCookieDraft(e.target.value)}
            />
            <div className="hint">
              推荐用上面的「打开内置浏览器登录」：登录成功后自动抓取并保存，无需手动复制。
              也可以手动获取：浏览器登录 weibo.com → 按 F12 → Network 面板随便点一个请求 →
              复制请求头里的 Cookie 整段粘到这里。Cookie 只存在本机且加密保存，
              不再回显到界面（此框留空保存 = 保持不变），仅用于让微博源以你的账号身份请求图片。
            </div>
            {settings.hasWeiboCookie && (
              <div style={{ marginTop: 6 }}>
                <button className="btn sm" onClick={clearWeiboCookie}>
                  {i18n.t('k0bcaffe2')}
                </button>
              </div>
            )}
          </div>
        </Card>

        <Card title={i18n.t('k9699a50e')} desc={i18n.t('k42806718')}>
          <div className="kw-list">
            {keywords.map((k) => (
              <div className="kw-row" key={k.id}>
                <input type="checkbox" checked={!!k.enabled} onChange={() => toggleKeyword(k)} />
                <span style={{ opacity: k.enabled ? 1 : 0.45 }}>{k.text}</span>
                <button className="del" onClick={() => removeKeyword(k.id)} aria-label={i18n.t('kb8cbac7b', { p0: k.text })}>
                  <IconTrash />
                </button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder={i18n.t('k9715b09d')}
              value={newKw}
              onChange={(e) => setNewKw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addKeyword()}
            />
            <button className="btn" onClick={addKeyword}>
              {i18n.t('kb58c7549')}
            </button>
          </div>
        </Card>

        <Card title={i18n.t('ke3a573fb')} desc={i18n.t('k15da038a')}>
          <div className="field">
            <label>{i18n.t('k0e7bf5d0')}</label>
            <input
              className="input"
              type="number"
              min={1}
              max={20}
              value={settings.pagesPerKeyword}
              onChange={(e) => patch({ pagesPerKeyword: Number(e.target.value) || 1 })}
            />
          </div>
          <div className="field">
            <label>{i18n.t('kd0e268cb')}</label>
            <input
              className="input"
              type="number"
              min={1}
              max={12}
              value={settings.concurrency}
              onChange={(e) => patch({ concurrency: Number(e.target.value) || 1 })}
            />
          </div>
          <div className="field">
            <label>{i18n.t('k60836be4')}</label>
            <input
              className="input"
              value={settings.wallhavenApiKey}
              placeholder={i18n.t('k6398ac13')}
              onChange={(e) => patch({ wallhavenApiKey: e.target.value })}
            />
          </div>
          <div className="settings-subtitle">{i18n.t('k85c2998b')}</div>
          <div className="field">
            <label>{i18n.t('k0f1cedfd')}</label>
            <input
              className="input"
              type="number"
              value={settings.minResolution}
              onChange={(e) => patch({ minResolution: Number(e.target.value) || 0 })}
            />
            <div className="hint">{i18n.t('k2d7c1c85')}</div>
          </div>
          <div className="field">
            <label>{i18n.t('ka660c2bf')}</label>
            <input
              className="input"
              type="number"
              value={settings.minFileSize}
              onChange={(e) => patch({ minFileSize: Number(e.target.value) || 0 })}
            />
            <div className="hint">{i18n.t('k0bd2372a')}</div>
          </div>
          <div className="field">
            <label>{i18n.t('k7e86ee5c')}</label>
            <input
              className="input"
              type="number"
              min={0}
              max={32}
              value={settings.phashThreshold}
              onChange={(e) => patch({ phashThreshold: Number(e.target.value) || 0 })}
            />
            <div className="hint">{i18n.t('k634a5d8f')}</div>
          </div>
          <div className="field">
            <label>{i18n.t('k46d4ba7b')}</label>
            <input
              className="input"
              type="number"
              value={settings.maxFileSize}
              onChange={(e) => patch({ maxFileSize: Number(e.target.value) || 1 })}
            />
          </div>
        </Card>
    </>
  );
}
