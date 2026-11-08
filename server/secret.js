/**
 * 敏感配置（微博 Cookie 等）的本地静态加密：AES-256-GCM。
 *
 * 背景：微博登录 Cookie 之前以明文直接写进 settings 表，数据库文件被拷走
 * （备份、误分享、同步盘）即等于账号凭据泄露。现在入库统一加密：
 * - 密钥为 32 字节随机数，保存在用户数据目录 secret.key，与 gallery.db 分离，
 *   单独泄露数据库文件无法还原凭据；
 * - 旧版本写入的明文值（无 enc1: 前缀）读取时原样返回，重新保存时自动转为密文。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const KEY_FILE = path.join(DATA_DIR, 'secret.key');
const PREFIX = 'enc1:';
let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  try {
    const buf = fs.readFileSync(KEY_FILE);
    if (buf.length === 32) {
      cachedKey = buf;
      return cachedKey;
    }
  } catch {
    /* 首次使用：下面生成 */
  }
  cachedKey = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, cachedKey, { mode: 0o600 });
  return cachedKey;
}

/** 加密敏感串；空值或已是密文的输入原样返回（幂等） */
export function encryptSecret(plain) {
  const text = String(plain ?? '');
  if (!text || text.startsWith(PREFIX)) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

/** 解密；非密文（旧明文）原样返回。密钥丢失或数据损坏时返回空串，让功能层提示重新登录 */
export function decryptSecret(stored) {
  const text = String(stored ?? '');
  if (!text.startsWith(PREFIX)) return text;
  try {
    const [ivB64, tagB64, dataB64] = text.slice(PREFIX.length).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
