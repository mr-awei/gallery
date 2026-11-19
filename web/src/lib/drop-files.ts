/**
 * 把拖进来的文件/文件夹递归摊平成 File 列表。
 *
 * 浏览器拖文件夹时 `dataTransfer.files` 里没有内容，只有 `webkitGetAsEntry()`；
 * 画布和图库都要支持「整个文件夹拖进来」，所以统一放在这里，避免两处实现分叉。
 */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items || [])
    .map((it) => (it.kind === 'file' ? it.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return Array.from(dt.files);

  const out: File[] = [];
  const readDir = (dir: FileSystemDirectoryEntry) =>
    new Promise<FileSystemEntry[]>((resolve) =>
      dir.createReader().readEntries((r) => resolve(r), () => resolve([]))
    );

  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file((f) => resolve(f), () => resolve(null))
      );
      if (file) out.push(file);
      return;
    }
    if (entry.isDirectory) {
      const dir = entry as FileSystemDirectoryEntry;
      for (;;) {
        const batch = await readDir(dir);
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };

  for (const entry of entries) await walk(entry);
  return out;
}

/** 只保留图片/视频这类能入库的文件，避免把 .DS_Store、PSD 临时文件也传上去 */
export function isMediaFile(f: File): boolean {
  return (
    f.type.startsWith('image/') ||
    f.type.startsWith('video/') ||
    /\.(jpe?g|png|webp|gif|bmp|avif|heic|tiff?|svg|mp4|webm|mov|mkv|avi)$/i.test(f.name)
  );
}
