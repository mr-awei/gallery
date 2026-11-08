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
        <Card title="采集源" desc="开关参与采集的图片来源，可多选。">
          {sources.map((s) => (
            <div className="switch-row" key={s.key} title={s.hint}>
              <span>
                {s.label}
                {s.needsCookie && <span className="src-hint">需配置</span>}
                {s.hint && <div className="hint" style={{ marginTop: 2 }}>{s.hint}</div>}
              </span>
              <input type="checkbox" checked={!!settings.sources[s.key]} onChange={() => toggleSource(s.key)} />
            </div>
          ))}
          <div className="field" style={{ marginTop: 14 }}>
            <label>微博 Cookie（可选，填了才能用「微博图片」源）</label>
            {isDesktop && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button className="btn sm" onClick={weiboLogin} disabled={wbLogin}>
                  {wbLogin ? '等待登录…' : '打开内置浏览器登录，自动获取'}
                </button>
              </div>
            )}
            <textarea
              className="input"
              rows={2}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
              value={wbCookieDraft}
              placeholder={settings.hasWeiboCookie ? '已保存登录凭据（不回显）。粘贴新 Cookie 可覆盖' : 'SUB=xxx; SUBP=xxx; SSOLoginState=xxx; …（整段粘贴）'}
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
                  清除已保存的 Cookie
                </button>
              </div>
            )}
          </div>
        </Card>

        <Card title="关键词" desc="采集时按这些关键词逐个抓图，可临时停用某个词。">
          <div className="kw-list">
            {keywords.map((k) => (
              <div className="kw-row" key={k.id}>
                <input type="checkbox" checked={!!k.enabled} onChange={() => toggleKeyword(k)} />
                <span style={{ opacity: k.enabled ? 1 : 0.45 }}>{k.text}</span>
                <button className="del" onClick={() => removeKeyword(k.id)}>
                  <IconTrash />
                </button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="新增关键词…"
              value={newKw}
              onChange={(e) => setNewKw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addKeyword()}
            />
            <button className="btn" onClick={addKeyword}>
              添加
            </button>
          </div>
        </Card>

        <Card title="抓取与质量过滤" desc="控制抓取量与入库门槛，过滤低质与重复图片。">
          <div className="field">
            <label>每个关键词默认页数</label>
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
            <label>并发下载数</label>
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
            <label>Wallhaven API Key（可选）</label>
            <input
              className="input"
              value={settings.wallhavenApiKey}
              placeholder="留空亦可搜索 SFW 内容"
              onChange={(e) => patch({ wallhavenApiKey: e.target.value })}
            />
          </div>
          <div className="settings-subtitle">质量过滤与去重</div>
          <div className="field">
            <label>长边最小像素</label>
            <input
              className="input"
              type="number"
              value={settings.minResolution}
              onChange={(e) => patch({ minResolution: Number(e.target.value) || 0 })}
            />
            <div className="hint">低于该分辨率的图片会被丢弃（默认 800px）</div>
          </div>
          <div className="field">
            <label>最小文件大小（KB）</label>
            <input
              className="input"
              type="number"
              value={settings.minFileSize}
              onChange={(e) => patch({ minFileSize: Number(e.target.value) || 0 })}
            />
            <div className="hint">过滤图标、缩略图等小文件（默认 30KB）</div>
          </div>
          <div className="field">
            <label>pHash 汉明距离阈值</label>
            <input
              className="input"
              type="number"
              min={0}
              max={32}
              value={settings.phashThreshold}
              onChange={(e) => patch({ phashThreshold: Number(e.target.value) || 0 })}
            />
            <div className="hint">≤ 该值判定为重复图片并丢弃（默认 8，越小越宽松）</div>
          </div>
          <div className="field">
            <label>单张最大体积（MB）</label>
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
