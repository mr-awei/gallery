// @ts-check
/**
 * 相机 RAW / 设计文件的「内嵌预览」定位器（容器感知）。
 *
 * 这是 Honeyview、FastStone、Xee、LibRaw 的共同做法：**不解拜耳阵列**，
 * 而是按各家容器的结构，把相机写进文件里的那张 JPEG 预览找出来。
 *  - TIFF 家族（CR2/NEF/ARW/DNG/ORF/RW2/PEF/SRW/3FR/IIQ…）：走 IFD 目录，
 *    预挂在 IFD0/IFD1/SubIFD/PreviewIFD 上，用 JPEGInterchangeFormat 或
 *    StripOffsets+StripByteCounts 指向；DNG 常见「未压缩 RGB 8bit」整幅预览。
 *  - CR2 额外有一个 RAW IFD（头部 12 字节处），里面才是传感器数据，跳过即可。
 *  - RAF（富士）：固定文件头 84/88 字节处直接写着 JPEG 偏移与长度。
 *  - CR3（佳能，ISO-BMFF）：预览放在 PRVW / THMB 盒子里，盒子可能嵌在 uuid 里。
 *  - 其余（X3F、MRW…）：结构太特殊，交给调用方的「盲扫 JPEG 段」兜底。
 *
 * 相比盲扫的好处：只读几十 KB 的目录 + 精确的那几段，不用把 48MB 读进内存；
 * 也不会把 RAW 数据里那段 12/14 位「无损 JPEG」当成预览（sharp 解不了它）。
 */
import fs from 'node:fs';

/** 单段上限：超过这个体积的一定不是预览图，而是传感器数据 */
const MAX_SEGMENT = 48 * 1024 * 1024;
/** JPEG 预览的最小体积：再小就是相册缩略图/图标，出了也是糊的 */
const MIN_JPEG = 1024;
/** 目录遍历上限，防止畸形文件把扫描拖死 */
const MAX_IFDS = 16;
const MAX_ENTRIES = 4096;

const TIFF_MAGIC = new Set([42, 0x4f52 /* ORF "RO" */, 0x4e45 /* 少数 ORF "NE" */]);
const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'moof', 'traf']);
const PREVIEW_BOXES = new Set(['PRVW', 'THMB', 'PREV']);
/** Canon CRX 的 uuid 前缀（CR3 用它包一层自定义盒子） */
const CRX_UUID = Buffer.from('85c0b687820f11e08111f4ce462b6a48', 'hex');

function u16(buf, off, le) {
  return le ? buf.readUInt16LE(off) : buf.readUInt16BE(off);
}
function u32(buf, off, le) {
  return le ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
}
function u64(buf, off, le) {
  const v = le ? buf.readBigUInt64LE(off) : buf.readBigUInt64BE(off);
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
}

/** 文件读取器：切片读，避免把整份 RAW 读进内存 */
function fileReader(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  return {
    size,
    read(offset, length) {
      const len = Math.max(0, Math.min(length, size - offset));
      if (!len) return Buffer.alloc(0);
      const buf = Buffer.allocUnsafe(len);
      const got = fs.readSync(fd, buf, 0, len, offset);
      return got === len ? buf : buf.subarray(0, got);
    },
    close() {
      fs.closeSync(fd);
    },
  };
}

/** 测试用：把一段内存当文件读 */
export function bufferReader(buf) {
  return {
    size: buf.length,
    read(offset, length) {
      return buf.subarray(offset, Math.min(offset + length, buf.length));
    },
    close() {},
  };
}

/**
 * TIFF 目录遍历：收集所有能当预览的区段。
 * @returns {{kind:'jpeg'|'rgb', offset?:number, length?:number, strips?:{offset:number,length:number}[], width?:number, height?:number}[]}
 */
export function tiffPreviewSegments(read, size) {
  const head = read(0, Math.min(16, size));
  if (head.length < 8) return [];
  const le = head[0] === 0x49;
  const magic = u16(head, 2, le);
  if (!TIFF_MAGIC.has(magic)) return [];

  const queue = [u32(head, 4, le)];
  // CR2：头部 8..9 是 'CR'，12..15 是 RAW IFD（传感器数据），单独入队只为跳过它
  const isCr2 = head.length >= 16 && head.toString('latin1', 8, 10) === 'CR';
  if (isCr2) queue.push(u32(head, 12, le));

  const seen = new Set();
  /** @type {Array<{kind:'jpeg'|'rgb', offset?:number, length?:number, strips?:{offset:number,length:number}[], width?:number, height?:number}>} */
  const out = [];
  while (queue.length && seen.size < MAX_IFDS) {
    const off = queue.shift();
    if (!off || seen.has(off) || off + 2 > size) continue;
    seen.add(off);
    const cntBuf = read(off, 2);
    if (cntBuf.length < 2) continue;
    const count = u16(cntBuf, 0, le);
    if (!count || count > MAX_ENTRIES) continue;
    const dir = read(off + 2, count * 12 + 4);
    if (dir.length < count * 12) continue;

    const tags = new Map();
    for (let i = 0; i < count; i++) {
      const base = i * 12;
      const tag = u16(dir, base, le);
      const type = u16(dir, base + 2, le);
      const n = u32(dir, base + 4, le);
      const sizeOfType = { 1: 1, 3: 2, 4: 4, 5: 8 }[type] || 4;
      const total = sizeOfType * n;
      // 值不内联时，那 4 字节是偏移
      const valueAt = total <= 4 ? base + 8 : u32(dir, base + 8, le);
      const readValues = () => {
        const want = Math.min(total, 64 * 1024);
        const raw = total <= 4 ? dir.subarray(base + 8) : read(valueAt, want);
        const arr = [];
        const step = sizeOfType;
        for (let k = 0; k + step <= raw.length && arr.length < n; k += step) {
          arr.push(sizeOfType === 2 ? u16(raw, k, le) : sizeOfType === 1 ? raw[k] : u32(raw, k, le));
        }
        return arr;
      };
      if (tag === 0x014a) {
        // SubIFDs：预览常常挂在这里
        for (const v of readValues()) queue.push(v);
      }
      tags.set(tag, { n, valueAt, total, readValues, inline: total <= 4 });
    }
    const next = dir.length >= count * 12 + 4 ? u32(dir, count * 12, le) : 0;
    if (next) queue.push(next);

    const num = (tag) => {
      const t = tags.get(tag);
      if (!t) return 0;
      const v = t.readValues();
      return v[0] || 0;
    };
    const width = num(0x0100);
    const height = num(0x0101);
    const bits = num(0x0102);
    const compression = num(0x0103);
    const photometric = num(0x0106);
    const spp = num(0x0115);
    const planar = num(0x011c);
    const jpegOff = num(0x0201);
    const jpegLen = num(0x0202);

    // 1) 标准 JPEGInterchangeFormat（老式 TIFF 预览、部分 NEF/ARW 的 PreviewIFD）
    if (jpegOff && jpegLen >= MIN_JPEG && jpegLen <= MAX_SEGMENT && jpegOff + jpegLen <= size) {
      out.push({ kind: 'jpeg', offset: jpegOff, length: jpegLen, width, height });
      continue;
    }
    const stripOff = tags.get(0x0111);
    const stripLen = tags.get(0x0117);
    if (!stripOff || !stripLen) continue;
    const offs = stripOff.readValues();
    const lens = stripLen.readValues();
    if (!offs.length || offs.length !== lens.length) continue;
    const total = lens.reduce((a, b) => a + b, 0);

    // 2) 未压缩 / JPEG 压缩的条带预览
    if (compression === 7 || compression === 6) {
      // 传感器数据也是 JPEG 压缩（无损），但它 bits≥10、单通道：筛掉
      if (bits && bits !== 8) continue;
      if (spp && spp !== 3 && spp !== 4) continue;
      if (total < MIN_JPEG || total > MAX_SEGMENT) continue;
      // 条带偏移是「文件绝对位置」，只要求彼此首尾相接
      let cursor = offs[0];
      let ok = true;
      for (let i = 0; i < offs.length; i++) {
        if (offs[i] !== cursor) {
          ok = false;
          break;
        }
        cursor += lens[i];
      }
      if (!ok) continue; // 条带不连续，拼出来一定是坏数据
      out.push({ kind: 'jpeg', strips: offs.map((offset, i) => ({ offset, length: lens[i] })), width, height });
    } else if (compression === 1 && photometric === 2 && bits === 8 && spp === 3 && planar <= 1) {
      // DNG 常见：整幅未压缩 RGB 预览
      if (width < 256 || height < 256) continue;
      const need = width * height * 3;
      if (need > MAX_SEGMENT || total < need) continue;
      out.push({
        kind: 'rgb',
        strips: offs.map((offset, i) => ({ offset, length: lens[i] })),
        width,
        height,
      });
    }
  }
  return out;
}

/** 富士 RAF：文件头 84/88 字节处直接给出预览 JPEG 的位置与长度 */
export function rafPreviewSegment(read, size) {
  const head = read(0, Math.min(104, size));
  if (head.length < 92) return null;
  if (!head.toString('latin1', 0, 15).startsWith('FUJIFILMCCD-RAW')) return null;
  const offset = head.readUInt32BE(84);
  const length = head.readUInt32BE(88);
  if (!offset || length < MIN_JPEG || length > MAX_SEGMENT || offset + length > size) return null;
  return [{ kind: 'jpeg', offset, length }];
}

/** ISO-BMFF（CR3）：在 PRVW/THMB 盒子里找 JPEG，盒子可能套在 uuid/moov 里 */
export function bmffPreviewSegments(read, size) {
  const out = [];
  let guard = 0;
  const walk = (start, end, depth) => {
    if (depth > 6) return;
    let pos = start;
    while (pos + 8 <= end && guard++ < 4000) {
      const head = read(pos, 16);
      if (head.length < 8) return;
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let headerLen = 8;
      if (boxSize === 1) {
        if (head.length < 16) return;
        boxSize = u64(head, 8, false);
        headerLen = 16;
      } else if (boxSize === 0) {
        boxSize = end - pos;
      }
      if (boxSize < headerLen || pos + boxSize > end) return;
      const bodyStart = pos + headerLen;

      if (PREVIEW_BOXES.has(type)) {
        const len = Math.min(boxSize - headerLen, MAX_SEGMENT);
        if (len >= MIN_JPEG) out.push({ kind: 'jpeg', offset: bodyStart, length: len });
      } else if (CONTAINER_BOXES.has(type)) {
        walk(bodyStart, pos + boxSize, depth + 1);
      } else if (type === 'uuid') {
        const uuid = read(bodyStart, 16);
        if (uuid.length === 16 && uuid.equals(CRX_UUID)) walk(bodyStart + 16, pos + boxSize, depth + 1);
      } else if (type === 'meta') {
        // meta 是 FullBox：4 字节 version/flags 之后才是子盒子
        walk(bodyStart + 4, pos + boxSize, depth + 1);
      }
      pos += boxSize;
    }
  };
  walk(0, size, 0);
  return out;
}

/**
 * 按容器定位预览区段（不读取图像数据本身）。
 * @param {{size:number, read:(off:number,len:number)=>Buffer}} reader
 * @param {string} ext
 */
export function locatePreviewSegments(reader, ext) {
  const { read, size } = reader;
  const head = read(0, Math.min(16, size));
  if (head.length < 4) return [];
  const e = String(ext || '').toLowerCase();

  if (e === 'raf') return rafPreviewSegment(read, size) || [];
  // ISO-BMFF：ftyp 在前 8 字节内，CR3 / HEIC / AVIF 都是
  if (head.toString('latin1', 4, 8) === 'ftyp') return bmffPreviewSegments(read, size);
  return tiffPreviewSegments(read, size);
}

/** 读出每个区段的字节（JPEG 可能是多段拼接；RGB 是整幅像素） */
function readSegment(reader, seg) {
  if (seg.offset && seg.length) return reader.read(seg.offset, seg.length);
  if (!seg.strips?.length) return null;
  const parts = seg.strips.map((s) => reader.read(s.offset, s.length));
  return Buffer.concat(parts);
}

/** JPEG 必须真的以 SOI 开头 —— 盒子里的偏移常有几字节前缀 */
function trimToSoi(buf) {
  if (!buf?.length) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return buf;
  const idx = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  return idx >= 0 ? buf.subarray(idx) : null;
}

/**
 * 打开文件，返回可用的预览数据（按「JPEG 优先、体积降序」排好）。
 * @returns {Promise<{jpeg: Buffer[], rgb: {data: Buffer, width: number, height: number}[]}>}
 */
export async function readEmbeddedPreviews(file, ext) {
  const reader = fileReader(file);
  try {
    const segs = locatePreviewSegments(reader, ext);
    const jpeg = [];
    const rgb = [];
    for (const seg of segs) {
      let buf;
      try {
        buf = readSegment(reader, seg);
      } catch {
        continue;
      }
      if (!buf?.length) continue;
      if (seg.kind === 'rgb') {
        const need = (seg.width || 0) * (seg.height || 0) * 3;
        if (need && buf.length >= need) {
          rgb.push({ data: buf.subarray(0, need), width: seg.width, height: seg.height });
        }
        continue;
      }
      const jpg = trimToSoi(buf);
      if (jpg && jpg.length >= MIN_JPEG) jpeg.push(jpg);
    }
    jpeg.sort((a, b) => b.length - a.length);
    rgb.sort((a, b) => b.width * b.height - a.width * a.height);
    return { jpeg, rgb };
  } finally {
    reader.close();
  }
}
