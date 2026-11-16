// @ts-check
/**
 * 热更的单例装配：路径、公钥、feed 地址、fetch（走 Electron net，自动继承应用内的代理设置）。
 *
 * 为什么公钥放文件而不是常量：换钥匙不用改代码逻辑，
 * 但只要这个文件在 asar 里，用户就改不动它 —— 和写死是同一级别的可信。
 */
import { app, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHotfix, defaultFeedUrls } from './hotfix.js';
import { APP_ROOT_DIR } from './constants.js';
import { SCHEMA_VERSION } from '../../server/db/schema-version.js';

/**
 * Gitee 镜像仓库（形如 'mr-awei/gallery'）。
 * 打包后的应用没有环境变量可读，所以默认值必须写在这里；设成空串才只走 GitHub。
 */
const GITEE_MIRROR = process.env.TUKU_HOTFIX_GITEE ?? 'mr-awei/gallery';

/** @type {ReturnType<typeof createHotfix> | null} */
let instance = null;

/** 公钥：PEM，随安装包发布；缺失等于热更整体关闭（宁可没有功能，也不要没有验签的热更） */
function readPublicKey() {
  const file = path.join(APP_ROOT_DIR, 'electron', 'hotfix-public.pem');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function feedUrls() {
  // 本地联调：TUKU_HOTFIX_FEED=http://127.0.0.1:8000/manifest.json
  const override = String(process.env.TUKU_HOTFIX_FEED || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (override.length) return override;
  return defaultFeedUrls({ gitee: GITEE_MIRROR });
}

export function hotfix() {
  if (instance) return instance;
  instance = createHotfix({
    // 绿色版/便携模式把用户数据放哪，热更就跟着放哪
    userDataDir: process.env.TUKU_USER_DATA || app.getPath('userData'),
    appRoot: APP_ROOT_DIR,
    shellVersion: app.getVersion(),
    schemaVersion: SCHEMA_VERSION,
    publicKeyPem: readPublicKey(),
    feedUrls: feedUrls(),
    // net.fetch 用默认会话，所以设置里的 HTTP/SOCKS5 代理、系统代理都会自动生效
    fetchImpl: (url, init) => net.fetch(url, init),
  });
  return instance;
}
