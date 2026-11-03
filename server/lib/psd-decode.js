/**
 * 最小 PSD 合成图解码器（纯 JS，无依赖）。
 *
 * 为什么不用现成库：@webtoon/psd 对部分真实文件会抛
 * 「Offset is outside the bounds of the DataView」，而 PSD 缩略图恰恰是设计师素材库里
 * 最需要稳定的一环。PSD 的合成图就躺在文件最后一段 Image Data 里，格式很固定：
 *
 *   header(26) | colorModeData | imageResources | layerMaskInfo | compression(2) | planes…
 *
 * 这里只解「能当缩略图用」的部分：8/16 bit、raw 或 RLE(PackBits)、RGB / 灰度 / CMYK。
 * 解不出来（图层效果、索引色、异常文件）就返回 null，由调用方回退到别的方案。
 *
 * 返回 { width, height, data } —— data 是 RGBA，可直接喂给 sharp 的 raw 输入。
 */

const MAX_PIXELS = 40_000_000; // 4000 万像素封顶，避免一张巨图把内存吃穿

/** PackBits(RLE) 解压一行 */
function unpackRow(src, pos, out, outPos, need) {
  let o = outPos;
  const end = outPos + need;
  while (o < end && pos < src.length) {
    const n = (src[pos++] << 24) >> 24; // 有符号字节
    if (n >= 0) {
      const cnt = Math.min(n + 1, end - o);
      src.copy(out, o, pos, pos + cnt);
      o += cnt;
      pos += cnt;
    } else if (n !== -128) {
      const cnt = Math.min(1 - n, end - o);
      out.fill(src[pos++] || 0, o, o + cnt);
      o += cnt;
    }
  }
  return o;
}

export function decodePsdComposite(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 26 + 4 + 2) return null;
  if (buf.toString('latin1', 0, 4) !== '8BPS') return null;

  const version = buf.readUInt16BE(4);
  if (version !== 1 && version !== 2) return null;

  const channels = buf.readUInt16BE(12);
  const height = buf.readUInt32BE(14);
  const width = buf.readUInt32BE(18);
  const depth = buf.readUInt16BE(22);
  const colorMode = buf.readUInt16BE(24);

  if (!width || !height || !channels) return null;
  if (width * height > MAX_PIXELS) return null;
  if (depth !== 8 && depth !== 16) return null;
  // 3=RGB, 4=CMYK, 1=灰度
  if (colorMode !== 3 && colorMode !== 4 && colorMode !== 1) return null;

  let p = 26;
  // color mode data / image resources / layer & mask info：三段都是「长度 + 内容」
  for (let i = 0; i < 3; i++) {
    if (p + 4 > buf.length) return null;
    const len = buf.readUInt32BE(p);
    p += 4 + len;
    if (p > buf.length) return null;
  }

  if (p + 2 > buf.length) return null;
  const compression = buf.readUInt16BE(p);
  p += 2;

  const bytesPerSample = depth / 8;
  const planeSize = width * height * bytesPerSample;
  const need = planeSize * channels;
  const planes = [];

  if (compression === 0) {
    // 原始数据：channels 个平面依次排列
    if (p + need > buf.length) return null;
    for (let c = 0; c < channels; c++) planes.push(buf.subarray(p + c * planeSize, p + (c + 1) * planeSize));
  } else if (compression === 1) {
    // RLE：先是 channels*height 个行长（version 2 是 4 字节）
    const rowCount = channels * height;
    const tableBytes = rowCount * (version === 2 ? 4 : 2);
    if (p + tableBytes > buf.length) return null;
    const rows = [];
    for (let i = 0; i < rowCount; i++) {
      rows.push(version === 2 ? buf.readUInt32BE(p + i * 4) : buf.readUInt16BE(p + i * 2));
    }
    p += tableBytes;
    const rowBytes = width * bytesPerSample;
    for (let c = 0; c < channels; c++) {
      const plane = Buffer.alloc(planeSize);
      for (let y = 0; y < height; y++) {
        const idx = c * height + y;
        const len = rows[idx];
        const outPos = y * rowBytes;
        if (outPos + rowBytes > plane.byteLength) return null;
        // 解压出来不够一行（文件截断）就把剩下的留 0，能出图总比整张失败好
        unpackRow(buf.subarray(p, Math.min(buf.length, p + len)), 0, plane, outPos, rowBytes);
        p += len;
      }
      planes.push(plane);
    }
  } else {
    return null;
  }

  // 16 bit 只取高字节（缩略图用不着精度）
  const sample = (plane, i) => (depth === 16 ? plane[i * 2] : plane[i]);
  const rgba = Buffer.alloc(width * height * 4);
  const n = width * height;
  for (let i = 0; i < n; i++) {
    let r;
    let g;
    let b;
    if (colorMode === 3) {
      r = sample(planes[0], i);
      g = sample(planes[1] ?? planes[0], i);
      b = sample(planes[2] ?? planes[0], i);
    } else if (colorMode === 1) {
      r = g = b = sample(planes[0], i);
    } else {
      // CMYK 在 PSD 里是反相存储的
      const c = 255 - sample(planes[0], i);
      const m = 255 - sample(planes[1] ?? planes[0], i);
      const y = 255 - sample(planes[2] ?? planes[0], i);
      const k = 255 - sample(planes[3] ?? planes[0], i);
      r = 255 - Math.min(255, c + k);
      g = 255 - Math.min(255, m + k);
      b = 255 - Math.min(255, y + k);
    }
    const o = i * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = 255;
  }
  return { width, height, data: rgba };
}
