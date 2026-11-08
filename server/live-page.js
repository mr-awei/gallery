/**
 * 动态壁纸渲染页（挂到桌面 WorkerW 层的那扇窗口加载它）。
 *
 * 六种模式：
 *  - slideshow：相册轮播（可缓慢缩放 / 淡入淡出）
 *  - video：本地视频循环播放
 *  - web：由主进程直接加载网址（此页不处理）
 *  - shader：WebGL 片元着色器（内置预设或自定义 GLSL）
 *  - interactive：canvas 粒子，鼠标可参与（主进程关掉鼠标穿透）
 *  - audio：WebAudio AnalyserNode 实时频谱（素材音频 / 麦克风 / 系统音频回环）
 *
 * 对外 window.__live：
 *  - apply() 重新按配置渲染；pause(bool) 性能规则暂停；next() 下一张/下一帧
 *  - setParams(patch) 拖动滑块时即时更新，不重启渲染器
 * 参数：brightness / speed / intensity / depth（0~300 的 UI 值，这里归一化到倍率）
 */
export const LIVE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'" />
<title>动态壁纸</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  #stage { position: fixed; inset: 0; overflow: hidden; transition: filter .18s linear; }
  #stage canvas { width: 100%; height: 100%; display: block; }
  .layer {
    position: absolute; inset: 0;
    background-size: cover; background-position: center center;
    opacity: 0; transition: opacity 1.4s ease;
  }
  .layer.on { opacity: 1; }
  .layer.kb { animation: kb 26s ease-in-out infinite alternate; }
  @keyframes kb { from { transform: scale(1.02); } to { transform: scale(1.14); } }
  .paused .layer.kb { animation-play-state: paused; }
  video { width: 100%; height: 100%; object-fit: cover; display: block; }
  #tip {
    position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
    padding: 8px 14px; border-radius: 20px; color: #fff; font: 12.5px/1.6 "Microsoft YaHei", sans-serif;
    background: rgba(0, 0, 0, .55); border: 1px solid rgba(255, 255, 255, .18);
    opacity: 0; transition: opacity .3s ease; pointer-events: none; white-space: pre-wrap; max-width: 82vw;
  }
  #tip.on { opacity: 1; }
  #clock {
    position: fixed; right: 6vw; bottom: 9vh; display: none; text-align: right;
    color: rgba(255,255,255,.92); text-shadow: 0 2px 24px rgba(0,0,0,.55);
    font: 300 74px/1.1 "Segoe UI Light", "Microsoft YaHei", sans-serif; pointer-events: none;
  }
  #clock small { display: block; font-size: 17px; letter-spacing: .12em; opacity: .72; margin-top: 10px; }
  body.screensaver #clock { display: block; }
  body.screensaver #tip { bottom: auto; top: 24px; }
</style>
</head>
<body>
<div id="stage"></div>
<div id="clock"></div>
<div id="tip"></div>
<script>
(() => {
  const stage = document.getElementById('stage');
  const tip = document.getElementById('tip');
  const clockEl = document.getElementById('clock');
  const SCREENSAVER = new URLSearchParams(location.search).get('screensaver') === '1';
  // 屏保可以有自己的画面模式，不影响日常动态壁纸的配置
  const SAVER_MODE = new URLSearchParams(location.search).get('mode') || '';
  // 本地 API 鉴权令牌：主进程加载本页时经 URL 注入（?token=xxx）
  const TOKEN = new URLSearchParams(location.search).get('token') || '';
  // 系统音频回环：主进程注入的桌面源 id（Windows 桌面声音），空则未就绪
  const SYS_AUDIO_ID = new URLSearchParams(location.search).get('sysAudioId') || '';
  const api = (path) => fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN));
  const DEFAULT_PARAMS = { brightness: 100, speed: 50, intensity: 60, depth: 40 };
  let cfg = {};
  let params = { ...DEFAULT_PARAMS };
  let timer = null;
  let layers = [];
  let cursor = 0;
  let index = 0;
  let paused = false;
  /** 当前模式的渲染器：{ setParams, pause, next, destroy } */
  let renderer = null;

  const say = (text) => {
    tip.textContent = text;
    tip.classList.add('on');
    setTimeout(() => tip.classList.remove('on'), 3200);
  };
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
  };
  /** UI 的 0~300 数值 → shader / canvas 用的倍率 */
  const P = (p) => ({
    brightness: clamp(p.brightness, 0, 300, 100) / 100,
    speed: clamp(p.speed, 0, 300, 50) / 100,
    intensity: clamp(p.intensity, 0, 300, 60) / 100,
    depth: clamp(p.depth, 0, 300, 40) / 100,
  });

  async function loadConfig() {
    try { cfg = await (await api('/api/wallpaper/live')).json(); } catch { cfg = {}; }
    return cfg;
  }

  /** 除 params 外的配置指纹：只有它变了才重建渲染器，拖滑块不会重启窗口内容 */
  const sig = (c) => JSON.stringify({
    mode: c.mode, enabled: c.enabled, scope: c.scope, intervalSec: c.intervalSec,
    videoPath: c.videoPath, playlistId: c.playlistId, minScore: c.minScore,
    kenBurns: c.kenBurns, mute: c.mute, volume: c.volume,
    shaderPreset: c.shaderPreset, shaderSource: c.shaderSource,
    audioPath: c.audioPath, audioSource: c.audioSource,
  });

  function stopRenderer() {
    if (renderer) { try { renderer.destroy(); } catch {} renderer = null; }
    clearTimeout(timer);
    timer = null;
    layers = [];
    stage.innerHTML = '';
  }

  /** 通用参数：亮度/饱和度/景深用 CSS filter，速度也影响视频播放速率 */
  function applyCommonParams() {
    const p = P(params);
    stage.style.filter = 'brightness(' + p.brightness.toFixed(2) + ') saturate(' +
      (0.55 + p.intensity * 0.6).toFixed(2) + ') blur(' + (p.depth * 1.2).toFixed(2) + 'px)';
    const v = stage.querySelector('video');
    if (v && cfg.mode === 'video') v.playbackRate = Math.max(0.25, Math.min(3, p.speed * 2));
  }

  /* ------------------------------- 相册轮播 ------------------------------- */
  const sigOf = (d) => (d.items || []).map((x) => x.id).join(',') + '|' + d.interval + '|' + d.kenBurns;
  let playlistSig = '';
  let refreshing = false;
  async function refreshPlaylistIfChanged() {
    if (refreshing) return;
    refreshing = true;
    try {
      const d = await (await api('/api/wallpaper/live/playlist')).json();
      if (!d || !d.items || !d.items.length) return;
      if (sigOf(d) === playlistSig) return;
      await startSlideshow();
    } catch {
      /* 网络抖动：下一轮再试 */
    } finally {
      refreshing = false;
    }
  }

  async function startSlideshow() {
    let data = { items: [], interval: 15, kenBurns: true };
    try { data = await (await api('/api/wallpaper/live/playlist')).json(); } catch {}
    if (!data.items || !data.items.length) {
      say('相册里还没有图片：请先收藏几张，或在设置里把范围改成「全库」');
      return;
    }
    playlistSig = sigOf(data);
    stage.innerHTML = '';
    layers = [0, 1].map(() => {
      const el = document.createElement('div');
      el.className = 'layer' + (data.kenBurns === false ? '' : ' kb');
      stage.appendChild(el);
      return el;
    });
    const withTok = (u) => u + (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
    let front = 0;
    index = 0;
    let misses = 0;
    // 预加载：加载成功才切到该层；失败（源文件在没挂载的盘上 / 预览还没生成）
    // 就退避重试，多次仍失败则跳过这张 —— 避免某张图 404 让整屏壁纸长期黑着。
    const tryShow = (i, layerIdx, attempt) => {
      const url = withTok(data.items[i % data.items.length].url);
      const img = new Image();
      img.onload = () => { misses = 0; layers[layerIdx].style.backgroundImage = 'url("' + url + '")'; };
      img.onerror = () => {
        if (paused) return;
        if ((attempt || 0) < 4) { setTimeout(() => tryShow(i, layerIdx, (attempt || 0) + 1), 800 + 1500 * (attempt || 0)); return; }
        misses++;
        // 一轮下来没有一张能显示（典型：开机时盘还没挂好）：稍后整页重渲染自愈
        if (misses >= data.items.length) { setTimeout(() => window.__live.apply(), 8000); return; }
        index++; scheduleStep();
      };
      img.src = url;
    };
    const step = () => {
      if (paused) return;
      tryShow(index, 1 - front, 0);
      layers[1 - front].classList.add('on');
      layers[front].classList.remove('on');
      front = 1 - front;
      index++;
      if (index % data.items.length === 0) refreshPlaylistIfChanged();
      scheduleStep();
    };
    const scheduleStep = () => {
      clearTimeout(timer);
      const p = P(params);
      timer = setTimeout(step, Math.max(3, (Number(data.interval) || 15) / Math.max(0.25, p.speed)) * 1000);
    };
    tryShow(0, 0, 0);
    layers[0].classList.add('on');
    index = 1;
    scheduleStep();
    say('动态壁纸：相册轮播（' + data.items.length + ' 张）');
  }

  /* ------------------------------- 视频壁纸 ------------------------------- */
  async function startVideo() {
    stage.innerHTML = '';
    const v = document.createElement('video');
    v.src = '/api/wallpaper/live/video' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : '');
    v.loop = true;
    v.autoplay = true;
    v.muted = cfg.mute !== false;
    v.volume = Math.max(0, Math.min(1, (Number(cfg.volume) || 0) / 100));
    v.playsInline = true;
    v.addEventListener('error', () => say('视频无法播放：请检查文件是否存在、编码是否为 H.264/VP9'));
    stage.appendChild(v);
    layers = [];
    try { await v.play(); } catch { say('视频自动播放被系统拦截，请重新开启动态壁纸'); }
    say('动态壁纸：视频循环');
  }

  /* --------------------------- GLSL 着色器壁纸 --------------------------- */
  async function startShader() {
    stage.innerHTML = '';
    const canvas = document.createElement('canvas');
    stage.appendChild(canvas);
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false });
    if (!gl) { say('当前环境不支持 WebGL，无法使用着色器壁纸'); return; }
    let source = String(cfg.shaderSource || '').trim();
    if (!source) {
      try {
        const list = await (await api('/api/wallpaper/live/shaders')).json();
        const hit = (list.presets || []).find((p) => p.id === (cfg.shaderPreset || 'plasma'));
        source = (hit || (list.presets || [])[0])?.source || '';
      } catch {}
    }
    if (!source) { say('没有可用的着色器预设'); return; }
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(String(log || '编译失败').slice(0, 400));
      }
      return sh;
    };
    let program;
    try {
      const vs = compile(gl.VERTEX_SHADER, 'attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos,0.0,1.0); }');
      const fs = compile(gl.FRAGMENT_SHADER, source);
      program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    } catch (err) {
      say('GLSL 编译失败：' + (err.message || err));
      return;
    }
    gl.useProgram(program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uni = {};
    for (const n of ['u_resolution','u_mouse','u_time','u_brightness','u_speed','u_intensity','u_depth']) {
      uni[n] = gl.getUniformLocation(program, n);
    }
    const mouse = { x: 0.5, y: 0.5 };
    const onMove = (e) => { mouse.x = e.clientX / innerWidth; mouse.y = 1 - e.clientY / innerHeight; };
    window.addEventListener('pointermove', onMove);
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(2, Math.floor(innerWidth * dpr));
      canvas.height = Math.max(2, Math.floor(innerHeight * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    window.addEventListener('resize', resize);
    let elapsed = 0;
    let last = performance.now();
    let raf = 0;
    let localPaused = false;
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      if (localPaused || paused) { last = now; return; }
      const p = P(params);
      elapsed += Math.min(0.1, (now - last) / 1000) * (0.35 + p.speed * 0.65);
      last = now;
      gl.uniform2f(uni.u_resolution, canvas.width, canvas.height);
      gl.uniform2f(uni.u_mouse, mouse.x, mouse.y);
      gl.uniform1f(uni.u_time, elapsed);
      gl.uniform1f(uni.u_brightness, p.brightness);
      gl.uniform1f(uni.u_speed, p.speed);
      gl.uniform1f(uni.u_intensity, p.intensity);
      gl.uniform1f(uni.u_depth, p.depth);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    raf = requestAnimationFrame(frame);
    renderer = {
      setParams() {},
      pause(on) { localPaused = !!on; },
      next() { elapsed += 12; },
      destroy() {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', resize);
        window.removeEventListener('pointermove', onMove);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      },
    };
    say('动态壁纸：GLSL 着色器（' + (cfg.shaderPreset || '自定义') + '）');
  }

  /* --------------------------- 交互式粒子壁纸 --------------------------- */
  function startInteractive() {
    stage.innerHTML = '';
    const canvas = document.createElement('canvas');
    stage.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) { say('无法创建画布'); return; }
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(2, Math.floor(innerWidth * dpr));
      canvas.height = Math.max(2, Math.floor(innerHeight * dpr));
    };
    resize();
    window.addEventListener('resize', resize);
    const mouse = { x: -9999, y: -9999 };
    const onMove = (e) => { mouse.x = e.clientX; mouse.y = e.clientY; };
    const onLeave = () => { mouse.x = -9999; mouse.y = -9999; };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // 页面自己把 interactive 关掉；主进程收到 liveBus 后会重新让窗口忽略鼠标
      fetch('/api/wallpaper/live', {
        method: 'PUT',
        headers: { 'x-api-token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ interactive: false }),
      }).catch(() => {});
      say('已退出交互（Esc）');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerleave', onLeave);
    window.addEventListener('keydown', onKey);
    const N = 110;
    const dots = Array.from({ length: N }, () => ({
      x: Math.random() * innerWidth, y: Math.random() * innerHeight,
      vx: (Math.random() - 0.5) * 0.7, vy: (Math.random() - 0.5) * 0.7,
      r: 1.2 + Math.random() * 3.4, hue: Math.random() * 360,
    }));
    let raf = 0;
    let localPaused = false;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (localPaused || paused) return;
      const p = P(params);
      // depth 越大拖尾越长（叠一层更透明的黑），形成景深/运动模糊
      ctx.fillStyle = 'rgba(4,6,16,' + (0.34 - Math.min(0.3, p.depth * 0.22)).toFixed(3) + ')';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(2, window.devicePixelRatio || 1);
      for (const d of dots) {
        const dx = mouse.x - d.x, dy = mouse.y - d.y;
        const dist2 = dx * dx + dy * dy + 400;
        const pull = (mouse.x > -9000 ? 1 : 0) * (2600 / dist2) * p.intensity;
        d.vx = (d.vx + dx * 0.00002 * pull) * 0.985;
        d.vy = (d.vy + dy * 0.00002 * pull) * 0.985;
        d.x += d.vx * (0.4 + p.speed * 1.6);
        d.y += d.vy * (0.4 + p.speed * 1.6);
        if (d.x < 0 || d.x > innerWidth) d.vx *= -1;
        if (d.y < 0 || d.y > innerHeight) d.vy *= -1;
        ctx.beginPath();
        ctx.arc(d.x * scale, d.y * scale, d.r * scale, 0, 6.2832);
        ctx.fillStyle = 'hsla(' + d.hue + ',85%,' + Math.min(88, 58 * p.brightness + 18) + '%,0.82)';
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(frame);
    renderer = {
      setParams() {},
      pause(on) { localPaused = !!on; },
      next() { for (const d of dots) { d.vx += (Math.random() - 0.5) * 6; d.vy += (Math.random() - 0.5) * 6; } },
      destroy() {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', resize);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerleave', onLeave);
        window.removeEventListener('keydown', onKey);
      },
    };
    say('动态壁纸：交互式粒子（移动鼠标试试；Esc 退出交互）');
  }

  /* --------------------------- 音频可视化壁纸 --------------------------- */
  async function startAudio() {
    stage.innerHTML = '';
    const canvas = document.createElement('canvas');
    stage.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) { say('无法创建画布'); return; }
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(2, Math.floor(innerWidth * dpr));
      canvas.height = Math.max(2, Math.floor(innerHeight * dpr));
    };
    resize();
    window.addEventListener('resize', resize);

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { say('当前环境不支持 Web Audio'); return; }
    let ac = null, analyser = null, audio = null, stream = null, sourceNode = null;
    try {
      ac = new AC();
      analyser = ac.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.78;
      const gain = ac.createGain();
      // 静音放在 gain 上而不是 audio.muted：muted 会让 MediaElementSource 直接没有数据，频谱就空了
      gain.gain.value = cfg.mute === false ? Math.max(0, Math.min(1, (Number(cfg.volume) || 0) / 100)) : 0;
      analyser.connect(gain);
      gain.connect(ac.destination);
      if (cfg.audioSource === 'mic') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        sourceNode = ac.createMediaStreamSource(stream);
        say('音频可视化：麦克风输入');
      } else if (cfg.audioSource === 'system') {
        // 系统音频回环：用主进程注入的桌面源 id 捕获 Windows 桌面声音（不含麦克风）。
        // 没有 id 说明配置未刷新（首次开系统音频），提示用户重存一次以触发重新加载页面。
        if (SYS_AUDIO_ID) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: SYS_AUDIO_ID } },
          });
          sourceNode = ac.createMediaStreamSource(stream);
          say('音频可视化：系统音频回环（Windows 桌面声音）');
        } else {
          say('系统音频回环未就绪：请重新保存一次动态壁纸配置以申请桌面音频权限');
        }
      } else {
        audio = document.createElement('audio');
        audio.src = '/api/wallpaper/live/audio' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : '');
        audio.loop = true;
        audio.playsInline = true;
        audio.addEventListener('error', () => say('音频文件无法播放：请在设置里选择一个本地音频'));
        sourceNode = ac.createMediaElementSource(audio);
        await audio.play().catch(() => say('音频自动播放被拦截，点击桌面后重试'));
        say('音频可视化：素材音频频谱');
      }
      if (sourceNode) sourceNode.connect(analyser);
    } catch (err) {
      say('音频采集失败：' + (err?.message || err) + '（Windows 系统音频回环需要额外权限，可改用素材音频文件）');
      return;
    }
    const data = new Uint8Array(analyser.frequencyBinCount);
    // 静音时频谱静止：音量在 analyser 之后的 gain 上归零，analyser 本身仍有数据，
    // 若照常 getByteFrequencyData，桌面会「明明静音了还在跳」。文档验收要求静音即静止。
    const muted = cfg.mute !== false;
    if (muted) say('音频可视化：已静音，频谱保持静止');
    let raf = 0;
    let localPaused = false;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (localPaused || paused) return;
      const p = P(params);
      if (muted) data.fill(0);
      else analyser.getByteFrequencyData(data);
      const w = canvas.width, h = canvas.height;
      ctx.fillStyle = 'rgba(6,8,18,' + (0.42 - Math.min(0.3, p.depth * 0.2)).toFixed(3) + ')';
      ctx.fillRect(0, 0, w, h);
      const bars = 72;
      const bw = w / bars;
      for (let i = 0; i < bars; i++) {
        const v = (data[Math.floor((i / bars) * data.length * 0.72)] || 0) / 255;
        const bh = Math.pow(v, 0.75) * h * 0.72 * p.intensity;
        const hue = 190 + i * 2.2 + p.speed * 40;
        ctx.fillStyle = 'hsla(' + hue + ',90%,' + Math.min(85, 46 * p.brightness + 18) + '%,0.9)';
        ctx.fillRect(i * bw + bw * 0.14, h - bh, bw * 0.72, bh);
      }
    };
    raf = requestAnimationFrame(frame);
    renderer = {
      setParams() {},
      pause(on) {
        localPaused = !!on;
        if (audio) { if (on) audio.pause(); else audio.play().catch(() => {}); }
      },
      next() { if (audio) audio.currentTime = 0; },
      destroy() {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', resize);
        try { audio?.pause(); } catch {}
        try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
        try { sourceNode?.disconnect(); } catch {}
        try { ac?.close(); } catch {}
      },
    };
  }

  /* ------------------------------ 对外控制 ------------------------------ */
  window.__live = {
    async apply() {
      clearInterval(timer);
      stopRenderer();
      await loadConfig();
      if (SCREENSAVER && SAVER_MODE) cfg.mode = SAVER_MODE;
      // 屏保是独立窗口：即使日常动态壁纸没开，屏保也要照常显示
      params = { ...DEFAULT_PARAMS, ...(cfg.params || {}) };
      if (cfg.enabled === false && !SCREENSAVER) { stage.innerHTML = ''; return; }
      if (cfg.mode === 'video') await startVideo();
      else if (cfg.mode === 'shader') await startShader();
      else if (cfg.mode === 'interactive') startInteractive();
      else if (cfg.mode === 'audio') await startAudio();
      else await startSlideshow();
      applyCommonParams();
    },
    /** 拖滑块时由主进程直推：不重建渲染器、不重开窗口 */
    setParams(patch) {
      if (!patch || typeof patch !== 'object') return;
      params = { ...params, ...patch };
      cfg.params = { ...(cfg.params || {}), ...patch };
      if (renderer?.setParams) renderer.setParams(params);
      applyCommonParams();
    },
    pause(on) {
      paused = !!on;
      document.querySelectorAll('.layer.kb').forEach((el) => {
        el.style.animationPlayState = on ? 'paused' : 'running';
      });
      const v = document.querySelector('video');
      if (v) { if (on) v.pause(); else v.play().catch(() => {}); }
      if (renderer?.pause) renderer.pause(on);
      if (!SCREENSAVER) say(on ? '已暂停（有全屏应用或正在用电池）' : '已恢复');
    },
    next() {
      if (renderer?.next) { renderer.next(); return; }
      const v = document.querySelector('video');
      if (v) { v.currentTime = 0; return; }
      if (!layers.length) return;
      index++;
      layers[1].style.backgroundImage = layers[0].style.backgroundImage;
    },
  };

  // 配置变化时热更新（页面上点保存后无需重启）
  window.addEventListener('message', (e) => {
    if (e?.data === 'reload-live') window.__live.apply();
  });
  setInterval(async () => {
    const before = sig(cfg);
    const beforeParams = JSON.stringify(cfg.params || {});
    await loadConfig();
    if (SCREENSAVER && SAVER_MODE) cfg.mode = SAVER_MODE;
    if (JSON.stringify(cfg.params || {}) !== beforeParams) {
      window.__live.setParams(cfg.params || {});
    }
    if (sig(cfg) !== before) window.__live.apply();
  }, 15000);

  // 屏保模式：大时钟 + 提示语；输入即退出由主进程的 getSystemIdleTime 负责
  if (SCREENSAVER) {
    document.body.classList.add('screensaver');
    api('/api/settings').then((r) => r.json()).then((s) => {
      if (s?.screensaver?.showClock === false) clockEl.style.display = 'none';
    }).catch(() => {});
    const tick = () => {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      clockEl.innerHTML = pad(d.getHours()) + ':' + pad(d.getMinutes()) +
        '<small>' + d.getFullYear() + ' / ' + pad(d.getMonth() + 1) + ' / ' + pad(d.getDate()) + ' · 图库屏保</small>';
    };
    tick();
    setInterval(tick, 1000);
  }

  window.__live.apply();
})();
</script>
</body>
</html>`;
