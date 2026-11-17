// @ts-check
// 视频元数据探测（不依赖 ffmpeg）
//
// 为什么要有：非图片素材入库时宽高/时长都是 0，卡片只能显示「未知」，
// 排序、筛选、壁纸适配全都没法用；而唯一的补救办法是「用户点开视频播一次」，
// 前端才能回写。素材目录里几百个视频没人会逐个点开。
//
// 这里用纯 JS 解析容器头，拿到时长与分辨率：
// - MP4 / MOV / M4V：moov → mvhd（时长）+ trak → tkhd（宽高）
// - WebM / MKV：EBML → Info.Duration / Tracks.Video.PixelWidth|PixelHeight
// 解不出来就返回空字段，调用方按「未探测」处理，不影响入库。
import fs from 'node:fs';

/** 单次读取上限：moov / Segment 头都在文件头部或尾部，但不会真的占满整个文件 */
const MAX_BOX_BYTES = 32 * 1024 * 1024;

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta']);

/** 从 mp4 的 moov 缓冲里递归找 mvhd / tkhd */
function scanMp4(buf, start, end, out) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let body = p + 8;
    if (size === 1) {
      if (p + 16 > end) return;
      // 64 位大小：Node 读 uint64 用 BigInt，这里按 number 截断（>8PB 不考虑）
      size = Number(buf.readBigUInt64BE(p + 8));
      body = p + 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < 8 || p + size > end) {
      // moov 被截断（分区末尾 / 读取窗口不够）：用剩余部分继续解析，能拿多少拿多少
      if (size <= 0) return;
    }
    const boxEnd = Math.min(end, p + size);

    if (type === 'mvhd' && body + 20 <= boxEnd) {
      const version = buf[body];
      const off = body + 4;
      if (version === 1) {
        if (off + 32 <= boxEnd) {
          const timescale = buf.readUInt32BE(off + 16);
          const duration = Number(buf.readBigUInt64BE(off + 20));
          if (timescale > 0 && duration > 0) out.duration = duration / timescale;
        }
      } else if (off + 20 <= boxEnd) {
        const timescale = buf.readUInt32BE(off + 8);
        const duration = buf.readUInt32BE(off + 12);
        if (timescale > 0) {
          // 全部 1 表示时长未知（分片 mp4 常见）
          if (duration > 0 && duration !== 0xffffffff) out.duration = duration / timescale;
        }
      }
    } else if (type === 'tkhd' && body + 84 <= boxEnd) {
      const version = buf[body];
      const base = body + 4 + (version === 1 ? 32 : 20) + 16 + 36;
      if (base + 8 <= boxEnd) {
        const w = buf.readUInt32BE(base) / 65536;
        const h = buf.readUInt32BE(base + 4) / 65536;
        // 音轨的宽高是 0，只有视频轨会给出真实像素
        if (w >= 2 && h >= 2 && w * h > (out.width || 0) * (out.height || 0)) {
          out.width = Math.round(w);
          out.height = Math.round(h);
        }
      }
    } else if (CONTAINERS.has(type)) {
      scanMp4(buf, body, boxEnd, out);
    }
    if (size <= 0) return;
    p += size;
  }
}

function probeMp4(fd, out) {
  const stat = fs.fstatSync(fd);
  const fileSize = stat.size;
  let pos = 0;
  let guard = 0;
  while (pos + 8 <= fileSize && guard++ < 4096) {
    const head = Buffer.alloc(16);
    const n = fs.readSync(fd, head, 0, 16, pos);
    if (n < 8) break;
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let headerLen = 8;
    if (size === 1) {
      if (n < 16) break;
      size = Number(head.readBigUInt64BE(8));
      headerLen = 16;
    } else if (size === 0) {
      size = fileSize - pos;
    }
    if (size < headerLen) break;
    if (type === 'moov') {
      const take = Math.min(size - headerLen, MAX_BOX_BYTES);
      const buf = Buffer.alloc(take);
      fs.readSync(fd, buf, 0, take, pos + headerLen);
      scanMp4(buf, 0, take, out);
      return out;
    }
    pos += size;
  }
  return out;
}

/* --------------------------------- EBML / WebM --------------------------------- */

function readVint(buf, p, keepMarker = false) {
  const first = buf[p];
  if (!first) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || p + len > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  for (let i = 1; i < len; i++) value = value * 256 + buf[p + i];
  return { value, len };
}

const CONTAINER_IDS = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0x1f43b675, 0x1254c367]);

/** 遍历 EBML 元素；只递归进少数容器，避免把整个文件走一遍 */
function walkEbml(buf, start, end, out, depth = 0) {
  if (depth > 6) return;
  let p = start;
  while (p < end) {
    const id = readVint(buf, p, true);
    if (!id) return;
    p += id.len;
    const size = readVint(buf, p);
    if (!size) return;
    p += size.len;
    const unknown = size.value === Math.pow(2, 7 * size.len) - 1;
    const bodyEnd = unknown ? end : Math.min(end, p + size.value);

    switch (id.value) {
      case 0x2ad7b1: // TimecodeScale（纳秒）
        if (p + size.value <= end) out.timecodeScale = readUInt(buf, p, size.value);
        break;
      case 0x4489: {
        // Duration（浮点，单位 = TimecodeScale）
        if (size.value === 4) out.durationRaw = buf.readFloatBE(p);
        else if (size.value === 8) out.durationRaw = buf.readDoubleBE(p);
        break;
      }
      case 0xb0: // PixelWidth
        out.width = readUInt(buf, p, size.value) || out.width;
        break;
      case 0xba: // PixelHeight
        out.height = readUInt(buf, p, size.value) || out.height;
        break;
      default:
        if (CONTAINER_IDS.has(id.value)) walkEbml(buf, p, bodyEnd, out, depth + 1);
    }
    if (unknown) return;
    p = bodyEnd;
  }
}

function readUInt(buf, p, len) {
  let v = 0;
  for (let i = 0; i < len && p + i < buf.length; i++) v = v * 256 + buf[p + i];
  return v;
}

function probeEbml(fd, out) {
  const take = Math.min(fs.fstatSync(fd).size, MAX_BOX_BYTES);
  const buf = Buffer.alloc(take);
  fs.readSync(fd, buf, 0, take, 0);
  const acc = {};
  walkEbml(buf, 0, take, acc);
  if (acc.durationRaw > 0) {
    // Duration 以 TimecodeScale（默认 1e6 ns = 1ms）为单位
    const scaleNs = acc.timecodeScale || 1_000_000;
    out.duration = (acc.durationRaw * scaleNs) / 1e9;
  }
  if (acc.width > 1) out.width = acc.width;
  if (acc.height > 1) out.height = acc.height;
  return out;
}

/** mp4 家族（ftyp 出现在文件前 12 字节内） */
function isMp4Family(fd) {
  const head = Buffer.alloc(12);
  try {
    fs.readSync(fd, head, 0, 12, 0);
  } catch {
    return false;
  }
  return head.toString('latin1', 4, 8) === 'ftyp';
}

/**
 * 探测音视频元数据。
 * @returns {{duration:number,width:number,height:number}} 解不出来的字段为 0
 */
export function probeMedia(absPath) {
  const out = { duration: 0, width: 0, height: 0 };
  let fd = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    // EBML 魔数 0x1A45DFA3 = WebM / MKV
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
      probeEbml(fd, out);
    } else if (isMp4Family(fd)) {
      probeMp4(fd, out);
    }
  } catch {
    /* 文件损坏 / 权限不足：当作未探测 */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* noop */
      }
    }
  }
  const round = (n) => (Number.isFinite(n) && n > 0 ? n : 0);
  return {
    duration: +round(out.duration).toFixed(3),
    width: Math.round(round(out.width)),
    height: Math.round(round(out.height)),
  };
}
