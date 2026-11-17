import { useCallback, useEffect, useState } from 'react';
import { api, quiet } from '../api';
import { ensureHardware, hardwareFeatureForModel } from '../lib/hardware';
import type { ImageItem } from '../types';
import type { Toast } from './types';
import i18n from '../i18n';

type Options = {
  patchItem: (updated: ImageItem) => void;
  refreshStats: () => void;
  showToast: Toast;
};

/**
 * 大图预览里的「画质增强」：默认模型从设置读一次，点一次按默认模型放大并覆盖原文件。
 * 那个读设置的一次性 effect 与拆分前处在同一位置（按钮快捷键订阅之后）。
 */
export function useEnhance({ patchItem, refreshStats, showToast }: Options) {
  const [enhanceModel, setEnhanceModel] = useState('');
  /** 正在增强的那张图 id（按钮转圈 + 防重复点） */
  const [enhancingId, setEnhancingId] = useState<number | null>(null);

  // 读取默认增强模型（大图预览里的「画质增强」用它，与设置里保持一致）
  useEffect(() => {
    api
      .enhanceStandards()
      .then((s) => setEnhanceModel(s.config?.model || 'sharp-standard'))
      .catch(quiet);
  }, []);

  /** 大图预览中直接增强：按默认模型放大到标准以上并覆盖原文件 */
  const enhanceOne = useCallback(
    async (item: ImageItem) => {
      // 默认模型可能被设成 AI 档：开跑前过一遍硬件门槛，不够就先把原因摊开
      if (!(await ensureHardware(hardwareFeatureForModel(enhanceModel || 'sharp-standard')))) return;
      setEnhancingId(item.id);
      try {
        const { item: updated, noop } = await api.enhanceImage(item.id, enhanceModel || 'sharp-standard');
        patchItem(updated);
        // 已达标时服务端不会改动文件（noop），不能谎报「已增强至 W×H」
        showToast(
          noop
            ? i18n.t('k532bf855', { p0: updated.width, p1: updated.height })
            : i18n.t('kcfc980d6', { p0: updated.width, p1: updated.height })
        );
        refreshStats();
      } catch (err) {
        showToast(i18n.t('k7af59a2d', { p0: (err as Error).message }));
      } finally {
        setEnhancingId(null);
      }
    },
    [enhanceModel, patchItem, refreshStats, showToast]
  );

  return { enhanceModel, enhancingId, enhanceOne };
}
