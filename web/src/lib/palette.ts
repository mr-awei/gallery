/**
 * 色板导出（Eagle 的「Export palette」）：
 * - ASE：Adobe Swatch Exchange，Photoshop / Illustrator / Affinity 可直接导入
 * - PNG：色块 + 色值长图，适合贴到设计稿/沟通文档里
 * 调色板来源既可以是图片真实主色（/api/images/:id 的 palette），也可以是预设色。
 */

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function buildASE(colors: string[], title = '图库'): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const header = new ArrayBuffer(12);
  const hv = new DataView(header);
  enc.encode('ASEF').forEach((b, i) => hv.setUint8(i, b));
  hv.setUint16(4, 1);
  hv.setUint16(6, 0);
  hv.setUint32(8, colors.length, false);
  chunks.push(new Uint8Array(header));

  for (const hex of colors) {
    const rgb = [
      parseInt(hex.slice(1, 3), 16) / 255,
      parseInt(hex.slice(3, 5), 16) / 255,
      parseInt(hex.slice(5, 7), 16) / 255,
    ];
    const nameUnits = title.length + 1;
    const blockLen = 2 + nameUnits * 2 + 4 + 12 + 2;
    const buf = new ArrayBuffer(8 + blockLen);
    const dv = new DataView(buf);
    dv.setUint16(0, 0x0001, false); // color entry
    dv.setUint32(2, blockLen, false);
    let off = 6;
    dv.setUint16(off, nameUnits, false);
    off += 2;
    for (const ch of title) {
      dv.setUint16(off, ch.charCodeAt(0), false);
      off += 2;
    }
    dv.setUint16(off, 0, false); // 名称结束
    off += 2;
    ['R', 'G', 'B', ' '].forEach((c, i) => dv.setUint8(off + i, c.charCodeAt(0)));
    off += 4;
    rgb.forEach((v, i) => dv.setFloat32(off + i * 4, v, false));
    off += 12;
    dv.setUint16(off, 2, false); // normal color
    chunks.push(new Uint8Array(buf));
  }
  return new Blob(chunks as BlobPart[], { type: 'application/octet-stream' });
}

export function buildPngSheet(colors: string[], labels?: string[]): Promise<Blob> {
  const cols = Math.min(4, Math.max(1, colors.length));
  const cellW = 160;
  const cellH = 128;
  const rows = Math.ceil(colors.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cols * cellW;
  canvas.height = rows * cellH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.fillStyle = '#1a1a24';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  colors.forEach((hex, i) => {
    const x = (i % cols) * cellW;
    const y = Math.floor(i / cols) * cellH;
    ctx.fillStyle = hex;
    ctx.fillRect(x + 10, y + 10, cellW - 20, cellH - 44);
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.strokeRect(x + 10, y + 10, cellW - 20, cellH - 44);
    ctx.fillStyle = '#e8e8f2';
    ctx.font = '600 12px -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(hex.toUpperCase(), x + 12, y + cellH - 24);
    const extra = labels?.[i];
    if (extra) {
      ctx.fillStyle = 'rgba(232,232,242,.55)';
      ctx.font = '500 11px -apple-system, "Segoe UI", sans-serif';
      ctx.fillText(extra, x + 12, y + cellH - 8);
    }
  });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('导出失败'))), 'image/png');
  });
}
