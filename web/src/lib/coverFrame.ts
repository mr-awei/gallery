/**
 * 自定义封面抽帧（Eagle 的「Set as cover」）：
 * 视频取某一帧、GIF 取首帧、字体把当前文案渲染成图，
 * 统一输出 dataURL 交给 /api/images/:id/cover 落成缩略图。
 */

/** 画布统一的封面上限边（和后端 sharp 640 对齐，避免二次缩放糊掉） */
const MAX_SIDE = 1280;

/** 相对路径补成绝对地址：canvas 绘制要求同源可读，别让 href 决定成败 */
const toAbs = (src: string) => {
  try {
    return new URL(src, window.location.href).href;
  } catch {
    return src;
  }
};

function createCanvas(w: number, h: number) {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  return canvas;
}

/** 视频帧 → JPEG dataURL */
export function videoFrameDataUrl(src: string, ts = 0.2): Promise<string> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      v.removeAttribute('src');
      v.load();
      if (err) reject(err);
    };
    v.onerror = () => finish(new Error('视频无法解码，可能是编码不受支持'));
    v.onloadeddata = () => {
      const target = Math.min(Math.max(0, ts), Math.max(0, (v.duration || 1) - 0.05));
      const draw = () => {
        try {
          const canvas = createCanvas(v.videoWidth || 640, v.videoHeight || 360);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('无法创建画布');
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const url = canvas.toDataURL('image/jpeg', 0.9);
          finish();
          resolve(url);
        } catch (err) {
          finish(err as Error);
        }
      };
      if (target <= 0) {
        draw();
        return;
      }
      v.onseeked = draw;
      try {
        v.currentTime = target;
      } catch {
        draw();
      }
    };
    v.src = toAbs(src);
  });
}

/**
 * 已经在解码的 <video> 元素直接抽当前帧 → JPEG dataURL。
 * 卡片自动首帧封面用：不为了截图再加载一次视频文件。
 */
export function videoElementDataUrl(v: HTMLVideoElement, quality = 0.82): string | null {
  try {
    if (!v.videoWidth || !v.videoHeight) return null;
    const canvas = createCanvas(v.videoWidth, v.videoHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    // 跨域 / 解码未就绪：静默失败，卡片继续用 <video> 现状显示
    return null;
  }
}

/** 图片 / GIF 首帧 → JPEG dataURL */
export function imageFrameDataUrl(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = createCanvas(img.naturalWidth || 640, img.naturalHeight || 360);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('无法创建画布');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.9));
      } catch (err) {
        reject(err as Error);
      }
    };
    img.onerror = () => reject(new Error('图片无法解码'));
    img.src = toAbs(src);
  });
}

/** 字体素材：把当前预览文案渲染成封面（离线可用的纯 canvas 绘制） */
export async function fontFrameDataUrl(
  url: string,
  text: string,
  opts: { size?: number; inverted?: boolean } = {}
): Promise<string> {
  const fam = `tukucover-${Math.random().toString(36).slice(2, 9)}`;
  const face = new FontFace(fam, `url("${toAbs(url)}")`);
  const loaded = await face.load();
  document.fonts.add(loaded);
  try {
    const body = text || 'Aa 字体预览';
    const fontSize = opts.size || 72;
    const w = 1000;
    const h = 560;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布');
    ctx.fillStyle = opts.inverted ? '#f6f6fb' : '#17171f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = opts.inverted ? '#17171f' : '#f6f6fb';
    const scale = canvas.width / w;
    ctx.font = `600 ${fontSize * scale}px "${fam}", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 文案过长时按行折行，保证封面里能看出字形特征
    const lines: string[] = [];
    let line = '';
    for (const ch of body) {
      if (ctx.measureText(line + ch).width > canvas.width - 80 * scale) {
        lines.push(line);
        line = ch;
      } else line += ch;
    }
    if (line) lines.push(line);
    const shown = lines.slice(0, 3);
    const lh = fontSize * scale * 1.35;
    const startY = canvas.height / 2 - ((shown.length - 1) * lh) / 2;
    shown.forEach((l, i) => ctx.fillText(l, canvas.width / 2, startY + i * lh));
    return canvas.toDataURL('image/jpeg', 0.9);
  } finally {
    try {
      document.fonts.delete(loaded);
    } catch {
      /* noop */
    }
  }
}
