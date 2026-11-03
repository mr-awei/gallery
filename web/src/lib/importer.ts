import { api } from '../api';

/** 可入库的扩展名（与后端 mediaKind 判定保持一致） */
export const UPLOAD_EXTS =
  /\.(jpe?g|png|gif|webp|bmp|tiff?|avif|svg|heic|ico|mp4|mov|webm|mkv|avi|m4v|mpe?g|flv|wmv|mp3|wav|flac|aac|ogg|m4a|opus|wma|ttf|otf|woff2?|pdf|docx?|xlsx?|pptx?|txt|md|csv|key|numbers|pages|obj|glb|gltf|fbx|stl|3ds|dae|ply|blend)$/i;

export interface ImportProgress {
  done: number;
  total: number;
  saved: number;
  failed: number;
}

export interface ImportResult {
  saved: number;
  failed: number;
  /** 扩展名不在支持列表里，被直接跳过的数量 */
  skipped: number;
  /** 第一个失败文件的原因（含文件名），用于把「失败 3 个」变成可排查的一句话 */
  firstError?: string;
}

/**
 * 批量入库：串行上传，避免一批文件同时解码把后端压死；
 * 图库页（带进度条）和全局拖拽/粘贴（轻提示）共用这一份逻辑。
 */
export async function importFiles(
  files: File[],
  onProgress?: (p: ImportProgress) => void,
  opts: { tags?: string; keyword?: string } = {}
): Promise<ImportResult> {
  const list = files.filter((f) => UPLOAD_EXTS.test(f.name));
  const skipped = files.length - list.length;
  if (!list.length) return { saved: 0, failed: 0, skipped };

  let saved = 0;
  let failed = 0;
  let firstError: string | undefined;
  for (let i = 0; i < list.length; i++) {
    try {
      await api.uploadFile(list[i], opts);
      saved++;
    } catch (err) {
      failed++;
      // 只留第一条：批量失败通常是同一个原因（磁盘满/没权限/格式不对），全塞进 toast 没人看
      if (!firstError) firstError = `${list[i].name}：${(err as Error).message}`;
    }
    onProgress?.({ done: i + 1, total: list.length, saved, failed });
  }
  return { saved, failed, skipped, firstError };
}

/** 从剪贴板/拖拽事件里挑出文件；截图直接给 image/png 但可能没有 name */
export function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const f of Array.from(dt.files || [])) {
    if (f.name) {
      out.push(f);
      continue;
    }
    const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    out.push(new File([f], `paste_${Date.now()}.${ext}`, { type: f.type }));
  }
  return out;
}

/** 下拉遮罩里给用户看的支持说明 */
export const UPLOAD_HINT = '支持图片 / 视频 / 音频 / 字体 / PDF / Office / 3D 模型';
