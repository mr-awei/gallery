import { useState } from 'react';
import { api, isDesktop, pickFolder } from '../api';
import type { Library } from '../types';
import { IconClose, IconFolder } from './Icons';

/**
 * 新建资源库对话框：收集「库名称 + 库目录 + 素材根目录」后创建并切换。
 * - 库目录（libFolder）：自包含目录，内含 gallery.db / thumbs/
 * - 素材根目录（rootPath）：库挂载的图片文件夹，可留空（之后在设置页补）
 * - 桌面端用系统目录选择框，网页端退化为手填路径
 */
interface Props {
  onCancel: () => void;
  onDone: (library: Library) => void;
  onToast: (msg: string) => void;
}

export default function CreateLibraryDialog({ onCancel, onDone, onToast }: Props) {
  const [name, setName] = useState('');
  const [libFolder, setLibFolder] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [busy, setBusy] = useState(false);

  const chooseLibFolder = async () => {
    const d = await pickFolder();
    if (d) setLibFolder(d);
  };

  const chooseRoot = async () => {
    const d = await pickFolder();
    if (d) setRootPath(d);
  };

  const submit = async () => {
    if (busy) return;
    const libName = name.trim();
    const libDir = libFolder.trim();
    if (!libName) {
      onToast('请填写资源库名称');
      return;
    }
    if (!libDir) {
      onToast('请选择资源库位置');
      return;
    }
    setBusy(true);
    try {
      const { id } = await api.createLibrary({ name: libName, libFolder: libDir, rootPath: rootPath.trim() || undefined });
      // 创建后立即切换到新库，触发素材扫描与列表刷新
      const { library } = await api.activateLibrary(id);
      onDone(library);
    } catch (err) {
      onToast((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>
            <IconFolder /> 新建资源库
          </b>
          <button className="btn ghost sm" onClick={onCancel}>
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div className="field">
            <label>资源库名称</label>
            <input
              className="input"
              style={{ width: '100%' }}
              value={name}
              placeholder="例如：白底图 / 舞台 / 2025 精选"
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="field">
            <label>资源库位置（自动在其下创建独立的库数据目录）</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                value={libFolder}
                placeholder={isDesktop ? '' : '例如 D:\\图库（选盘符根也可以）'}
                readOnly={isDesktop}
                onChange={(e) => setLibFolder(e.target.value)}
              />
              {isDesktop && (
                <button className="btn" onClick={chooseLibFolder} disabled={busy}>
                  选择…
                </button>
              )}
            </div>
          </div>

          <div className="field">
            <label>素材根目录（可选，之后可在设置页更改）</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                value={rootPath}
                placeholder={isDesktop ? '' : '例如 E:\\白底图'}
                readOnly={isDesktop}
                onChange={(e) => setRootPath(e.target.value)}
              />
              {isDesktop && (
                <button className="btn" onClick={chooseRoot} disabled={busy}>
                  选择…
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            新建后会自动切换到该库并扫描素材目录
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onCancel}>
              取消
            </button>
            <button
              className="btn"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              disabled={busy}
              onClick={submit}
            >
              {busy ? '创建中…' : '创建并切换'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
