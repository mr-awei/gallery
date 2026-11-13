import React, { useEffect, useRef, useState } from 'react';
import { formatSize } from '../api';
import type { HardwareFeature, HardwareInfo } from '../types';

const MB = 1048576;
/** 硬件门槛里的内存数字（服务端给的是 MB）走全站唯一的体积格式化 */
const fmtMB = (mb: number) => formatSize(Number(mb) * MB);

/**
 * 应用内对话框（prompt / confirm），替代原生 window.prompt / window.confirm / window.alert：
 * - 风格与 Toast、DeleteReasonDialog 等统一（同一套 modal 样式与主题变量）；
 * - 原生弹窗在 Electron 下是另起的无样式系统窗口，与应用视觉割裂且会打断渲染进程。
 *
 * 用法：在 App 根部挂一次 <DialogHost/>，任意组件直接 await promptDialog(...) / confirmDialog(...)。
 */

interface DialogReq {
  kind: 'prompt' | 'confirm' | 'hardware';
  title: string;
  value: string;
  placeholder: string;
  /** 密码输入：遮字符，避免肩窥 */
  password?: boolean;
  /** 补充说明（如「密码忘了就只能从磁盘上解锁」） */
  hint?: string;
  /** 明细清单（如「具体删哪几个文件」），按换行原样渲染 */
  detail?: string;
  /** 硬件门槛提示：不达标的功能 + 本机硬件 */
  feature?: HardwareFeature;
  hardware?: HardwareInfo;
  // 三种对话框的返回类型不同（string|null / boolean），由调用方各自的 Promise 决定
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

/**
 * 硬件门槛提示：把「最低要求」和「你这台」摆在同一张表里，并附上门槛的依据。
 *
 * 返回 true 只可能是 `canProceedAnyway`（配置偏低但能试）时用户点了「仍然继续」；
 * 硬性不可用（没有 Vulkan 显卡 / 系统不对）只给「知道了」，避免用户白等一次注定失败的任务。
 */
export function hardwareGate(feature: HardwareFeature, hardware: HardwareInfo): Promise<boolean> {
  return new Promise((resolve) => {
    if (pushDialog) {
      pushDialog({ kind: 'hardware', title: feature.label, value: '', placeholder: '', feature, hardware, resolve });
    } else {
      resolve(false);
    }
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

  const isPrompt = req.kind === 'prompt';
  const isHardware = req.kind === 'hardware';
  // 点遮罩 / Esc 的语义：输入框 = 取消（null），确认类 = 否（false）
  const dismiss = isPrompt ? null : false;
  const feature = req.feature;
  const hw = req.hardware;
  // 配置偏低但能试时，主按钮才是「仍然继续」；硬性不可用时只给「知道了」
  const primaryLabel = isHardware ? (feature?.canProceedAnyway ? '仍然继续' : '知道了') : '确定';
  const primaryValue = isHardware ? Boolean(feature?.canProceedAnyway) : isPrompt ? val.trim() : true;

  const gpuNames = (hw?.gpu?.devices || []).map((d) => (d.vramMB ? `${d.name}（${fmtMB(d.vramMB)}）` : d.name));

  return (
    <div
      className="modal-backdrop"
      onClick={() => close(dismiss)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close(dismiss);
        // 硬件门槛不用回车做「仍然继续」：那是用户不想要的默认动作
        if (e.key === 'Enter') {
          e.preventDefault();
          if (isHardware) close(dismiss);
          else close(isPrompt ? val.trim() : true);
        }
      }}
    >
      <div
        // 硬件门槛内容较长：卡片要成列式（body 滚动、footer 固定在底部），
        // 否则按钮会被 max-height 裁到看不见
        className={isHardware ? 'modal-card modal-card-hw' : 'modal-card'}
        style={{ maxWidth: isHardware ? 560 : 380 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-body" style={{ display: 'block' }}>
          <div style={{ fontWeight: 600, lineHeight: 1.6 }}>
            {isHardware ? `这台机器可能跑不动「${req.title}」` : req.title}
          </div>
          {isPrompt && (
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
          {isHardware && feature && (
            <div className="hw-gate">
              <div className="hint">引擎：{feature.engine}</div>
              <table className="hw-table">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th>最低要求</th>
                    <th>你这台</th>
                  </tr>
                </thead>
                <tbody>
                  {feature.checks.map((c) => (
                    <tr key={c.id} className={c.ok ? 'ok' : c.hard ? 'bad' : 'warn'}>
                      <td>{c.label}</td>
                      <td>{c.need}</td>
                      <td>
                        {c.have}
                        {!c.ok && c.note ? <span className="hw-note">{c.note}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {hw && (
                <div className="hint" style={{ marginTop: 8 }}>
                  本机：{hw.cpu.model}（{hw.cpu.cores} 核）· 内存 {fmtMB(hw.ram.totalMB)}
                  ，可用 {fmtMB(hw.ram.freeMB)} ·{' '}
                  {gpuNames.length ? `显卡 ${gpuNames.join(' / ')}` : '显卡 未读到'}
                </div>
              )}
              {feature.basis.length > 0 && (
                <div className="hw-basis">
                  <strong>门槛依据</strong>
                  {feature.basis.map((b) => (
                    <div key={b}>· {b}</div>
                  ))}
                </div>
              )}
              <div className="hint" style={{ marginTop: 8 }}>
                {feature.canProceedAnyway
                  ? '低于最低配置不是不能跑，但可能很慢、占满内存，甚至中途失败。'
                  : '这一档在当前机器上点了也跑不起来，先换用不需要 GPU 的方式（比如内置插值放大）。'}
              </div>
            </div>
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
            <button className="btn" onClick={() => close(dismiss)}>
              {isHardware && !feature?.canProceedAnyway ? '关闭' : '取消'}
            </button>
            <button
              className="btn"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              onClick={() => close(primaryValue)}
            >
              {primaryLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
