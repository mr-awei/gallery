// @ts-check
/**
 * 热更清单的纯逻辑：规范化序列化、验签、白名单与版本闸门。
 *
 * 这里刻意不碰 electron / fs / net，主进程和单测用同一份代码。
 * 安全边界只有一条：**签名覆盖清单的全部字段，公钥写死在壳里**。
 * 因此清单放在 GitHub 还是 Gitee、中间过多少镜像都不影响结论 ——
 * 被篡改最坏也只是「装不上」，不会执行陌生代码。
 */
import crypto from 'node:crypto';

/** 稳定序列化：签名和验签必须对同一串字节，键序或空白差一点就对不上 */
export function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** 被签名的内容：除 sig 以外的一切字段（含 seq、shellVersion、files） */
export function manifestPayload(manifest) {
  const body = { ...manifest };
  delete body.sig;
  return canonicalJson(body);
}

/** 用清单里的 sig 验证整份清单；任何异常都当作「验签失败」 */
export function verifyManifest(manifest, publicKeyPem) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  if (typeof manifest.sig !== 'string' || !manifest.sig) return false;
  if (!publicKeyPem || typeof publicKeyPem !== 'string') return false;
  try {
    return crypto.verify(
      null, // Ed25519 不需要单独指定摘要算法
      Buffer.from(manifestPayload(manifest), 'utf8'),
      publicKeyPem,
      Buffer.from(manifest.sig, 'base64')
    );
  } catch {
    return false;
  }
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 发布侧签名（脚本用；客户端永远不会拿到私钥） */
export function signManifest(manifest, privateKeyPem) {
  const sig = crypto.sign(null, Buffer.from(manifestPayload(manifest), 'utf8'), privateKeyPem);
  return { ...manifest, sig: sig.toString('base64') };
}

/**
 * 只有这三类目录允许进热更包。
 * electron/（壳）、package.json（依赖树）、原生模块（*.node/*.dll）一旦放行，
 * 就等于让「远程执行」越过安装包这道唯一的用户确认环节。
 */
const ALLOWED_PREFIX = /^(server|web|plugins)\//;
const FORBIDDEN_EXT = /\.(node|dll|exe|so|dylib|msi|bat|cmd|ps1|vbs)$/i;

/** 包内相对路径是否允许（同时挡掉 ../ 与绝对路径穿越） */
export function fileAllowed(relPath) {
  if (typeof relPath !== 'string' || !relPath) return false;
  const p = relPath.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false;
  if (p.split('/').some((seg) => seg === '..' || seg === '')) return false;
  if (!ALLOWED_PREFIX.test(p)) return false;
  if (FORBIDDEN_EXT.test(p)) return false;
  // package.json 会改依赖解析与 main 入口，属于「壳」的范畴
  if (/(^|\/)package\.json$/i.test(p)) return false;
  return true;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * 清单能不能用。返回 '' 表示通过，否则是给日志看的中文原因。
 * @param {any} manifest
 * @param {{ shellVersion: string, schemaVersion: number, lastSeq: number }} ctx
 */
export function manifestProblem(manifest, ctx) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return '清单不是对象';
  const { shellVersion, schemaVersion, lastSeq } = ctx;
  // 滚动发布同一个 tag，链接会被 CDN/代理缓存住：必须靠 seq 单调 + 壳版本严格相等来判新旧
  if (!Number.isInteger(manifest.seq) || manifest.seq <= 0) return 'seq 非法';
  if (manifest.shellVersion !== shellVersion) return `清单针对 ${manifest.shellVersion}，当前 ${shellVersion}`;
  // DB 迁移是单向的：热更包比壳新会让回滚变成「库比代码新」，只能拒装
  if (manifest.schemaVersion !== schemaVersion) return '数据库版本不匹配（该走安装包）';
  if (manifest.seq <= lastSeq) return `seq ${manifest.seq} 不高于已应用的 ${lastSeq}`;
  if (!Array.isArray(manifest.files) || !manifest.files.length) return '清单里没有文件';
  if (manifest.files.length > 5000) return '清单文件数异常';
  const seen = new Set();
  for (const f of manifest.files) {
    if (!f || typeof f !== 'object') return '文件条目非法';
    if (!fileAllowed(f.path)) return `不允许的文件：${f.path}`;
    if (!HEX64.test(String(f.sha256 || '').toLowerCase())) return `缺少 sha256：${f.path}`;
    if (!Number.isInteger(f.size) || f.size < 0) return `size 非法：${f.path}`;
    if (seen.has(f.path)) return `重复文件：${f.path}`;
    seen.add(f.path);
  }
  if (!Array.isArray(manifest.urls) || !manifest.urls.length) return '清单没有下载地址';
  if (!manifest.urls.every((u) => typeof u === 'string' && /^https:\/\//i.test(u))) return '下载地址必须是 https';
  return '';
}
