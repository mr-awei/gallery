import { useState } from 'react';
import type { TagNode } from '../types';

/**
 * 各类集合类弹窗的开关状态（纯 useState，没有任何 effect）：
 * 分享链接 / 标签元数据 / 文件夹外观 / 批量创建 / 快速分类 / 堆叠查看器 / 快捷键帮助。
 * 收在一处只是为了别在 App 里散着十几个 useState，行为与拆分前完全一致。
 */
export function useDialogState() {
  const [shareOpen, setShareOpen] = useState(false);
  /** 正在编辑元数据的标签（右键侧栏标签） */
  const [tagEdit, setTagEdit] = useState<TagNode | null>(null);
  const [appearanceFolderId, setAppearanceFolderId] = useState<number | null>(null);
  const [batchCreate, setBatchCreate] = useState<{ mode: 'folder' | 'tag'; parentId: number | null } | null>(null);
  const [quickClassifyIds, setQuickClassifyIds] = useState<number[] | null>(null);
  const [stackViewId, setStackViewId] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  return {
    shareOpen,
    setShareOpen,
    tagEdit,
    setTagEdit,
    appearanceFolderId,
    setAppearanceFolderId,
    batchCreate,
    setBatchCreate,
    quickClassifyIds,
    setQuickClassifyIds,
    stackViewId,
    setStackViewId,
    helpOpen,
    setHelpOpen,
  };
}

export type DialogState = ReturnType<typeof useDialogState>;
