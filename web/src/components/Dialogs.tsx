import React, { useEffect, useRef, useState } from 'react';

/**
 * 应用内对话框（prompt / confirm），替代原生 window.prompt / window.confirm / window.alert：
 * - 风格与 Toast、DeleteReasonDialog 等统一（同一套 modal 样式与主题变量）；
 * - 原生弹窗在 Electron 下是另起的无样式系统窗口，与应用视觉割裂且会打断渲染进程。
 *
 * 用法：在 App 根部挂一次 <DialogHost/>，任意组件直接 await promptDialog(...) / confirmDialog(...)。
 */

interface DialogReq {
  kind: 'prompt' | 'confirm';
  title: string;
  value: string;
  placeholder: string;
  /** 密码输入：遮字符，避免肩窥 */
  password?: boolean;
  /** 补充说明（如「密码忘了就只能从磁盘上解锁」） */
  hint?: string;
  /** 明细清单（如「具体删哪几个文件」），按换行原样渲染 */
  detail?: string;
  // 两种对话框的返回类型不同（string|null / boolean），由调用方各自的 Promise 决定
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: (v: any) => void;
}

let pushDialog: ((r: DialogReq) => void) | null = null;

/** 输入对话框：确认返回输入值（trim 后，可为空串），取消/Esc 返回 null */
export function promptDialog(
  title: string,
  value = '',
  placeholder = '',
  opts: { password?: boolean; hint?: string } = {}
): Promise<string | null> {
  return new Promise((resolve) => {
    if (pushDialog) pushDialog({ kind: 'prompt', title, value, placeholder, ...opts, resolve });
    else resolve(null);
  });
}

/** 确认对话框：确认返回 true，取消/Esc 返回 false；detail 用于列出「具体是哪几个」 */
export function confirmDialog(title: string, opts: { detail?: string } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (pushDialog) pushDialog({ kind: 'confirm', title, value: '', placeholder: '', ...opts, resolve });
    else resolve(false);
  });
}

export default function DialogHost() {
  const [req, setReq] = useState<DialogReq | null>(null);
  const [val, setVal] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    pushDialog = (r) => {
      setReq(r);
      setVal(r.value);
    };
    return () => {
      pushDialog = null;
    };
  }, []);

  useEffect(() => {
    if (req?.kind === 'prompt') {
      // 等输入框渲染完再全选，方便直接覆盖输入
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [req]);

  if (!req) return null;

  const close = (v: string | boolean | null) => {
    req.resolve(v);
    setReq(null);
  };

  return (
    <div
      className="modal-backdrop"
      onClick={() => close(req.kind === 'confirm' ? false : null)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close(req.kind === 'confirm' ? false : null);
        if (e.key === 'Enter') {
          e.preventDefault();
          close(req.kind === 'confirm' ? true : val.trim());
        }
      }}
    >
      <div className="modal-card" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-body" style={{ display: 'block' }}>
          <div style={{ fontWeight: 600, lineHeight: 1.6 }}>{req.title}</div>
          {req.kind === 'prompt' && (
            <input
              ref={inputRef}
              className="input"
              type={req.password ? 'password' : 'text'}
              autoComplete={req.password ? 'new-password' : 'off'}
              style={{ width: '100%', marginTop: 12 }}
              value={val}
              placeholder={req.placeholder}
              autoFocus
              onChange={(e) => setVal(e.target.value)}
            />
          )}
          {req.hint && <div className="hint" style={{ marginTop: 8 }}>{req.hint}</div>}
          {req.detail && (
            <div
              className="hint"
              style={{
                marginTop: 8,
                whiteSpace: 'pre-line',
                wordBreak: 'break-all',
                maxHeight: 200,
                overflow: 'auto',
                padding: '6px 8px',
                background: 'var(--panel-strong)',
                borderRadius: 6,
              }}
            >
              {req.detail}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <div />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => close(req.kind === 'confirm' ? false : null)}>
              取消
            </button>
            <button
              className="btn"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              onClick={() => close(req.kind === 'confirm' ? true : val.trim())}
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
