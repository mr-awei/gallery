/**
 * 动态壁纸渲染页（挂到桌面 WorkerW 层的那扇窗口加载它）。
 * 三种模式：
 *  - slideshow：从相册轮播（可缓慢缩放 / 淡入淡出）
 *  - video：本地视频循环播放
 *  - web：由主进程直接加载网址（此页不处理）
 * 对外暴露 window.__live.pause(bool) 供主进程按性能规则暂停。
 */
export const LIVE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'" />
<title>动态壁纸</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  #stage { position: fixed; inset: 0; overflow: hidden; }
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
    opacity: 0; transition: opacity .3s ease; pointer-events: none;
  }
  #tip.on { opacity: 1; }
</style>
</head>
<body>
<div id="stage"></div>
<div id="tip"></div>
<script>
(() => {
  const stage = document.getElementById('stage');
  const tip = document.getElementById('tip');
  // 本地 API 鉴权令牌：主进程加载本页时经 URL 注入（?token=xxx）
  const TOKEN = new URLSearchParams(location.search).get('token') || '';
  const api = (path) => fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN));
  let cfg = {};
  let timer = null;
  let layers = [];
  let cursor = 0;
  let index = 0;
  let paused = false;

  const say = (text) => {
    tip.textContent = text;
    tip.classList.add('on');
    setTimeout(() => tip.classList.remove('on'), 2600);
  };

  async function loadConfig() {
    try { cfg = await (await api('/api/wallpaper/live')).json(); } catch { cfg = {}; }
    return cfg;
  }

  /* ------------------------------- 相册轮播 ------------------------------- */
  // 清单指纹：轮播跑完一轮后比对。壁纸窗口一开就是几天，只靠 15s 的配置轮询发现不了
  // 「又收藏了新图 / 取消收藏 / 换了范围」，不主动刷清单就会一直播启动那一刻的那批图。
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
      await startSlideshow(); // 清单变了：按新清单（含新间隔）重开轮播
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
    const show = (i, layerIdx) => {
      layers[layerIdx].style.backgroundImage = 'url("' + withTok(data.items[i % data.items.length].url) + '")';
    };
    let front = 0;
    show(0, 0);
    layers[0].classList.add('on');
    index = 1;
    const step = () => {
      if (paused) return;
      show(index, 1 - front);
      layers[1 - front].classList.add('on');
      layers[front].classList.remove('on');
      front = 1 - front;
      index++;
      // 跑完一整轮才刷新清单：避免每张图都打一次接口
      if (index % data.items.length === 0) refreshPlaylistIfChanged();
    };
    clearInterval(timer);
    timer = setInterval(step, Math.max(5, Number(data.interval) || 15) * 1000);
    say('动态壁纸：相册轮播（' + data.items.length + ' 张 · ' + (data.interval || 15) + ' 秒）');
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

  /* ------------------------------ 对外控制 ------------------------------ */
  window.__live = {
    async apply() {
      clearInterval(timer);
      await loadConfig();
      if (cfg.enabled === false) { stage.innerHTML = ''; return; }
      if (cfg.mode === 'video') await startVideo();
      else await startSlideshow();
    },
    pause(on) {
      paused = !!on;
      document.querySelectorAll('.layer.kb').forEach((el) => {
        el.style.animationPlayState = on ? 'paused' : 'running';
      });
      const v = document.querySelector('video');
      if (v) { if (on) v.pause(); else v.play().catch(() => {}); }
      say(on ? '已暂停（有全屏应用或正在用电池）' : '已恢复');
    },
    next() {
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
    const before = JSON.stringify(cfg);
    await loadConfig();
    if (JSON.stringify(cfg) !== before) window.__live.apply();
  }, 15000);

  window.__live.apply();
})();
</script>
</body>
</html>`;
