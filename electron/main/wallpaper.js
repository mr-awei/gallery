// @ts-check
/** 通过本地接口操作壁纸（托盘菜单与全局快捷键共用） */
import { ctx } from './context.js';
import { fetchJson } from './ipc-base.js';
import { trayNotify } from './toast.js';

/**
 * @param {'now' | 'favorite' | 'dislike'} kind
 */
export async function wallpaperAction(kind) {
  if (!ctx.serverPort) {
    trayNotify('壁纸没换成', '本地服务还没起来，等几秒再试，或点「重启本地服务」');
    return null;
  }
  const path =
    kind === 'now'
      ? '/api/wallpaper/now'
      : kind === 'favorite'
        ? '/api/wallpaper/current/favorite'
        : '/api/wallpaper/current/dislike';
  try {
    const data = await fetchJson(`http://127.0.0.1:${ctx.serverPort}${path}`, { method: 'POST' }, 30000);
    // fetchJson 不看状态码：500 时它照样返回 { error }，必须自己判
    if (!data || data.error) throw new Error(data?.error || '服务没有返回结果');
    const name = String(data.title || '').slice(0, 40);
    if (kind === 'favorite') trayNotify('已收藏', name ? `已收藏「${name}」` : '已收藏当前壁纸');
    else if (kind === 'dislike') trayNotify('已跳过', name ? `换成了「${name}」` : '已跳过这一张，换下一张');
    else trayNotify('壁纸已更换', name ? `当前壁纸：${name}` : '已切换到新壁纸');
    return data;
  } catch (err) {
    console.error('[wallpaper] 操作失败：', err?.message || err);
    trayNotify('壁纸没换成', err?.message || '未知错误');
    return null;
  }
}
