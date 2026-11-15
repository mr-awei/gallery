// @ts-check
/**
 * 微博登录小窗：打开 m.weibo.cn 登录页让用户登录，登录成功后自动把整段 Cookie 返回
 * 给渲染进程，省去用户手动 F12 复制的麻烦。
 *
 * 关键点（踩过坑）：SUB Cookie 在登录跳转过程中会提前出现，拿到后又被微博作废，
 * 必须等 Cookie 快照连续两次稳定、且用真实接口验证通过（ok=1）才算抓取成功；
 * 同时把登录会话的 User-Agent 一起返回——微博风控会把登录态与 UA 绑定，
 * 采集请求必须用同一个 UA（crawler.searchWeibo 通过 settings.weiboUserAgent 复用）。
 */
import { BrowserWindow, screen } from 'electron';
import { ctx } from './context.js';
import { installPermissionGuard, isWeiboOrigin } from './ipc-base.js';

export async function weiboLoginFlow() {
  if (ctx.weiboWin && !ctx.weiboWin.isDestroyed()) {
    ctx.weiboWin.show();
    ctx.weiboWin.focus();
    return { ok: false, msg: '登录窗口已打开，请完成登录' };
  }
  // 登录窗同样按屏幕给：小屏（1366×768）上 740 高会顶出屏幕，底部的「登录」按钮点不到
  const loginArea = screen.getPrimaryDisplay().workAreaSize;
  ctx.weiboWin = new BrowserWindow({
    width: Math.min(1020, Math.round(loginArea.width * 0.8)),
    height: Math.min(740, Math.round(loginArea.height * 0.88)),
    center: true,
    title: '登录微博（登录成功后自动获取 Cookie）',
    parent: ctx.mainWindow,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, partition: 'weibo-login' },
  });
  const ses = ctx.weiboWin.webContents.session;
  // 第三方页面：权限、弹窗、跳转都要单独上锁（它用的是自己的 partition，
  // 默认 session 的守卫一点也不管它；以前这里摄像头/麦克风是全放行的）
  installPermissionGuard(ses);
  ctx.weiboWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  ctx.weiboWin.webContents.on('will-navigate', (e, target) => {
    if (isWeiboOrigin(target)) return;
    e.preventDefault();
    console.warn('[weibo] 已阻止登录窗跳转：', target);
  });
  // HTTP 头只允许 latin1：app.setName('图库') 会把中文应用名带进 Electron 默认 UA，
  // 直接用作 fetch 请求头会报 ByteString 错误（之前窗口不自动关闭的元凶），
  // 非 ASCII 字符统一百分号编码后再使用
  const ua = ses.getUserAgent().replace(/[^\x00-\xff]/g, (ch) => encodeURIComponent(ch));
  // 清掉上次残留的过期登录态，确保拿到的是本次登录的 Cookie
  await ses.clearStorageData({ storages: ['cookies'] }).catch(() => {});
  await ctx.weiboWin.loadURL('https://passport.weibo.cn/signin/login');

  let settled = false;
  return await new Promise((resolve) => {
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(r);
      if (ctx.weiboWin && !ctx.weiboWin.isDestroyed()) ctx.weiboWin.close();
    };
    let verifying = false;
    let lastVerifyAt = 0;
    let grabErrLogged = false;
    // 用登录会话同款 UA 请求真实接口，ok=1 才算登录态有效
    const verifyCookie = async (str) => {
      try {
        const cid = '100103type%3D1%26q%3D' + encodeURIComponent('壁纸');
        const res = await fetch(`https://m.weibo.cn/api/container/getIndex?containerid=${cid}&page_type=searchall&page=1`, {
          headers: {
            'User-Agent': ua,
            Referer: `https://m.weibo.cn/search?containerid=${cid}`,
            'X-Requested-With': 'XMLHttpRequest',
            'MWeibo-Pwa': '1',
            Accept: 'application/json, text/plain, */*',
            Cookie: str,
          },
        });
        const json = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
        return json?.ok === 1;
      } catch {
        return false; // 网络抖动时不判定失败，继续轮询
      }
    };
    const grab = async () => {
      if (verifying) return;
      try {
        const cookies = await ses.cookies.get({});
        // 已登录标志：SUB 出现；只取 weibo.cn 系域的 Cookie
        // 注意：MLOGIN 在已登录会话里可能仍是 0，不能作为登录判据，最终以接口验证为准
        if (!cookies.some((c) => c.name === 'SUB')) return;
        const seen = new Set();
        const str = cookies
          .filter((c) => /weibo\.cn$/i.test(c.domain))
          .filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)))
          // Electron 返回的 Cookie 值是解码后的原文，部分 Cookie（浏览页面后种下）含中文等
          // 非 ASCII 字符，直接放进请求头会报 ByteString 错误；HTTP 头要求 latin1，重新编码
          // 名称含非 ASCII 的属于畸形 Cookie（多为追踪器写入），无法安全放进请求头，直接跳过
          .map((c) => {
            if (!/^[\x00-\xff]*$/.test(c.name)) return '';
            return `${c.name}=${/^[\x00-\xff]*$/.test(c.value) ? c.value : encodeURIComponent(c.value)}`;
          })
          .filter(Boolean)
          .join('; ');
        if (!str) return;
        // 不做快照稳定性判断：m.weibo.cn 会周期性轮换 XSRF-TOKEN，Cookie 串一直在变，
        // 等它稳定会永远等不到。直接以接口验证为准（验证通过的那份串就是要保存的串）。
        if (Date.now() - lastVerifyAt < 3000) return; // 节流，避免高频打微博接口
        lastVerifyAt = Date.now();
        verifying = true;
        const ok = await verifyCookie(str);
        verifying = false;
        if (ok) finish({ ok: true, cookie: str, ua });
      } catch (e) {
        // 1.5s 一轮的轮询：窗口被关掉、cookie 读不到都是常态，但只报第一次，
        // 否则「一直停在等待登录」时无从判断是被吞了还是真没登录
        if (!grabErrLogged) {
          grabErrLogged = true;
          console.info('[weibo] cookie 轮询异常（只提示一次）:', e?.message || e);
        }
      }
    };
    const timer = setInterval(grab, 1500);
    // SPA 登录可能不触发 did-navigate，轮询兜底；两个导航钩子只是加快取到
    ctx.weiboWin.webContents.on('did-navigate', grab);
    ctx.weiboWin.webContents.on('did-frame-finish-load', grab);
    ctx.weiboWin.on('closed', () => {
      ctx.weiboWin = null;
      finish({ ok: false, msg: '已取消登录' });
    });
  });
}
