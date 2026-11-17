import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { api } from '../api';
import type { ImageItem } from '../types';
import type { LoadGallery, Toast } from './types';
import i18n from '../i18n';

type Options = {
  selected: Set<number>;
  setSelected: Dispatch<SetStateAction<Set<number>>>;
  pageRef: MutableRefObject<number>;
  load: LoadGallery;
  showToast: Toast;
};

/** 图片堆叠（Eagle 的 stack）：选中成组 / 拖到某张卡上成组 / 解散。无 effect。 */
export function useStacks({ selected, setSelected, pageRef, load, showToast }: Options) {
  const stackSelection = useCallback(async () => {
    const ids = [...selected];
    if (ids.length < 2) return showToast(i18n.t('k7418fd30'));
    try {
      await api.createStack(ids);
      showToast(i18n.t('kf9ec1a72', { p0: ids.length }));
      setSelected(new Set());
      pageRef.current = 1;
      load(1, true);
    } catch (err) {
      showToast((err as Error).message);
    }
  }, [load, selected, showToast, setSelected, pageRef]);

  /**
   * 拖图到某张卡上：目标是组主就并入那一堆，否则两张（多张）现场成组。
   * 桌面端系统级拖出会抢走 HTML5 拖放，所以卡片上按住 Alt 拖才走这条路径（见 ImageCard）。
   */
  const stackDropOnImage = useCallback(
    async (dragIds: number[], target: ImageItem) => {
      const ids = dragIds.filter((id) => id !== target.id);
      if (!ids.length) return;
      try {
        if ((target.stackCount || 0) > 1 && target.stackId) {
          const r = await api.addToStack(target.stackId, ids);
          showToast(i18n.t('k8b818440', { p0: ids.length, p1: r.stacks.length }));
        } else {
          await api.createStack([target.id, ...ids]);
          showToast(i18n.t('k0c200918', { p0: ids.length + 1 }));
        }
        setSelected(new Set());
        pageRef.current = 1;
        load(1, true);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [load, showToast, setSelected, pageRef]
  );

  const ungroupStackAt = useCallback(
    async (stackId: number) => {
      try {
        const r = await api.ungroupStack(stackId);
        showToast(i18n.t('k0403886e', { p0: r.removed }));
        pageRef.current = 1;
        load(1, true);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [load, showToast, pageRef]
  );

  return { stackSelection, stackDropOnImage, ungroupStackAt };
}
