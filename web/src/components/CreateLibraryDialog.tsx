import { useState } from 'react';
import { api, isDesktop, pickFolder } from '../api';
import type { Library } from '../types';
import { IconClose, IconFolder } from './Icons';
import i18n from '../i18n';

/**
 * 新建资源库对话框。
 *
 * 只问两件事：叫什么、图片在哪个文件夹。库数据（gallery.db / thumbs）默认
 * 落在素材文件夹下的隐藏目录 .tuku/ 里 —— 库跟着素材走，用户不用回答
 * 「数据库和图片分别放哪」这个只有实现者才关心的问题（以前要填两个目录）。
 * 想分开存放的走折叠的「高级」。
 */
interface Props {
  onCancel: () => void;
  onDone: (library: Library) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  /** 首次启动复用同一个弹窗：换个欢迎式的头部，跳过 = 完成引导（不再单独维护一套引导页） */
  welcome?: boolean;
}

/** 从路径里取最后一段当默认库名：E:\白底图 → 白底图 */
function baseName(p: string) {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** 默认库数据目录（只用于展示，真正拼接在后端） */
function defaultDataDir(root: string) {
  if (!root) return '';
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}.tuku`;
}

export default function CreateLibraryDialog({ onCancel, onDone, onToast, welcome = false }: Props) {
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false); // 用户手改过名字就不再自动覆盖
  const [rootPath, setRootPath] = useState('');
  const [libFolder, setLibFolder] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  const chooseRoot = async () => {
    const d = await pickFolder();
    if (!d) return;
    setRootPath(d);
    // 名字默认跟文件夹名走：选完文件夹什么都不填就能直接回车
    if (!nameTouched) setName(baseName(d));
  };

  const chooseLibFolder = async () => {
    const d = await pickFolder();
    if (d) setLibFolder(d);
  };

  const submit = async () => {
    if (busy) return;
    const libName = name.trim();
    const root = rootPath.trim();
    const dataDir = advanced ? libFolder.trim() : '';
    if (!libName) {
      onToast(i18n.t('k7ad9df88'));
      return;
    }
    if (!root) {
      onToast(i18n.t('k5fc44333'));
      return;
    }
    setBusy(true);
    try {
      const { id } = await api.createLibrary({
        name: libName,
        rootPath: root,
        libFolder: dataDir || undefined,
      });
      // 创建后立即切换到新库，首屏数据马上可见（素材扫描在后台静默进行）
      const { library } = await api.activateLibrary(id);
      onDone(library);
    } catch (err) {
      onToast((err as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card"
        style={{ maxWidth: 480 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // 回车即创建（只在输入框里生效：焦点在按钮上时回车是点按钮，不是提交表单）
          if (e.key === 'Enter' && !e.shiftKey && (e.target as HTMLElement).tagName === 'INPUT') submit();
        }}
      >
        <div className="modal-head">
          <b>
            <IconFolder /> {welcome ? i18n.t('ka5ecd271') : i18n.t('k8466b68e')}
          </b>
          {!welcome && (
            <button className="btn ghost sm" onClick={onCancel}>
              <IconClose />
            </button>
          )}
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          {welcome && (
            <div style={{ marginBottom: 14, fontSize: 13, lineHeight: 1.7, color: 'var(--muted)' }}>
              {i18n.t('k42619b08')}
            </div>
          )}

          <div className="field">
            <label>{i18n.t('kc19baaac')}</label>
            <input
              className="input"
              style={{ width: '100%' }}
              value={name}
              placeholder={i18n.t('k9b363cf3')}
              autoFocus
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
            />
          </div>

          <div className="field">
            <label>{i18n.t('k250a53c9')}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                value={rootPath}
                placeholder={isDesktop ? i18n.t('k5ade9ca6') : i18n.t('k723e93fb')}
                readOnly={isDesktop}
                onChange={(e) => setRootPath(e.target.value)}
              />
              {isDesktop && (
                <button className="btn" onClick={chooseRoot} disabled={busy}>
                  {i18n.t('k4f05519a')}
                </button>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.6 }}>
              {i18n.t('k96ad28c2')}
            </div>
          </div>

          <div style={{ marginTop: 4 }}>
            <button
              type="button"
              className="btn ghost sm"
              style={{ padding: '2px 6px', fontSize: 12 }}
              onClick={() => setAdvanced((v) => !v)}
            >
              {advanced ? '▾' : '▸'} 数据目录不在此处
            </button>
          </div>

          {advanced && (
            <div className="field" style={{ marginTop: 8 }}>
              <label>{i18n.t('kd88f9681')}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="input"
                  style={{ flex: 1 }}
                  value={libFolder}
                  placeholder={
                    rootPath ? i18n.t('k9c6a9c5e', { p0: defaultDataDir(rootPath) }) : i18n.t('kf3c58bd0')
                  }
                  readOnly={isDesktop}
                  onChange={(e) => setLibFolder(e.target.value)}
                />
                {isDesktop && (
                  <button className="btn" onClick={chooseLibFolder} disabled={busy}>
                    {i18n.t('k4f05519a')}
                  </button>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.6 }}>
                {i18n.t('k094b3405')}
              </div>
            </div>
          )}
        </div>

        <div className="modal-foot">
          {welcome ? (
            <button className="btn ghost" onClick={onCancel} disabled={busy}>
              {i18n.t('k92636e8c')}
            </button>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{i18n.t('k9cbf39d8')}</span>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            {!welcome && (
              <button className="btn" onClick={onCancel}>
                {i18n.t('k625fb26b')}
              </button>
            )}
            <button
              className="btn"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              disabled={busy}
              onClick={submit}
            >
              {busy ? i18n.t('kd156b373') : welcome ? i18n.t('k014b37f4') : i18n.t('k73b3f88e')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
