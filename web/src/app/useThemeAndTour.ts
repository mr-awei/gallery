import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { api, quiet } from '../api';
import { applyTheme, getStoredTheme, type Theme } from '../theme';
import type { View } from '../types';

/**
 * 主题 + 首次引导 + 分步教程。
 *
 * 这三个 effect 的相对顺序与拆分前完全一致：主题立即生效 → 拉一次服务端设置
 * → 设置到位后才决定要不要自动开教程（教程触发依赖前两者的结果）。
 */
export function useThemeAndTour({ setView }: { setView: Dispatch<SetStateAction<View>> }) {
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());
  // 首次引导：null=加载中 / false=需引导 / true=已完成
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  // 教程（分步导览）：tourOpen 控制显示；tourDone 落设置（跨资源库共享）
  const [tourOpen, setTourOpen] = useState(false);
  const [tourDone, setTourDone] = useState<boolean | null>(null);
  const tourStartedRef = useRef(false);

  // 主题：立即生效 + 持久化到设置（换机器/清缓存后仍保留）
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        if (s.theme === 'light' || s.theme === 'dark') setTheme((cur) => (cur === s.theme ? cur : s.theme));
        setOnboarding(s.onboarded === true);
        setTourDone(s.tourDone === true);
      })
      .catch(() => {
        // 读不到设置就别拦用户：首次建库与教程都当作「已完成」，避免卡在引导里出不去
        setOnboarding(true);
        setTourDone(true);
      });
    // 仅在启动时同步一次服务端设置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 教程自动触发：建库引导做完、且明确没看过（tourDone === false）时自动开一次。
     用 ref 记住「本次会话已尝试过」，避免用户在设置里重置后立刻又被弹一遍。 */
  useEffect(() => {
    if (onboarding !== true || tourDone !== false || tourStartedRef.current) return;
    tourStartedRef.current = true;
    // 后 4 步讲的是筛选栏和网格：停在仪表盘上会「指不到东西」，先回图库
    setView('gallery');
    setTourOpen(true);
  }, [onboarding, tourDone, setView]);

  const toggleTheme = useCallback(() => {
    setTheme((cur) => {
      const next: Theme = cur === 'dark' ? 'light' : 'dark';
      api.saveSettings({ theme: next }).catch(quiet);
      return next;
    });
  }, []);

  // 结束首次引导：跳过和建库成功都走这里。之前引导页自己存 storageDir、
  // 不建库，和「新建资源库」是两套问法（一个只问文件夹、一个问三个输入框），
  // 现在统一到 CreateLibraryDialog —— 引导结束只负责落 onboarded 标记
  const finishOnboarding = useCallback(() => {
    setOnboarding(true);
    api.saveSettings({ onboarded: true }).catch(quiet);
  }, []);

  /** 教程结束（看完或跳过都算）：只在设置里记一笔，下次启动不再自动弹 */
  const finishTour = useCallback(() => {
    setTourOpen(false);
    setTourDone(true);
    tourStartedRef.current = true;
    api.saveSettings({ tourDone: true }).catch(quiet);
  }, []);

  /** 设置页「重新看一遍」：先回图库，导览才有侧栏/筛选/网格可指 */
  const startTour = useCallback(() => {
    tourStartedRef.current = true;
    setView('gallery');
    setTourOpen(true);
  }, [setView]);

  return {
    theme,
    setTheme,
    toggleTheme,
    onboarding,
    tourOpen,
    tourDone,
    finishOnboarding,
    finishTour,
    startTour,
  };
}
