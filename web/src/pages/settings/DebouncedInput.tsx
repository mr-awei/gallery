import React, { useEffect, useRef, useState } from 'react';

/**
 * 受控输入框：本地态即时显示打字内容，避免受父级 state 抖动影响；
 * 但只在停顿 delay(默认 300ms) 后才把值 commit 给上层（patch / 写设置），
 * 连续打字不会每键触发一次父级更新 / 脏标记 / 重渲染。
 * 失焦立即提交一次，保证最终值与父级一致。
 */
export default function DebouncedInput({
  value,
  onCommit,
  type = 'text',
  min,
  max,
  delay = 300,
  className = 'input',
  style,
}: {
  value: string | number;
  onCommit: (v: string) => void;
  type?: string;
  min?: number;
  max?: number;
  delay?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [local, setLocal] = useState(String(value ?? ''));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setLocal(String(value ?? ''));
  }, [value]);

  const schedule = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onCommit(v);
    }, delay);
  };

  const flush = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      onCommit(local);
    }
  };

  return (
    <input
      className={className}
      style={style}
      type={type}
      min={min}
      max={max}
      value={local}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        flush();
        setLocal(String(value ?? ''));
      }}
      onChange={(e) => {
        setLocal(e.target.value);
        schedule(e.target.value);
      }}
    />
  );
}
