#!/usr/bin/env node
/**
 * 生成热更签名用的 Ed25519 密钥对。
 *
 * 公钥随安装包发布（进仓库），私钥只留在本机与 CI secret 里 ——
 * 这是「没有自己的服务器」时唯一能挡住中间人的东西：URL 谁都能换，密钥换不了。
 *
 * 用法：node scripts/hotfix-keygen.mjs [--force]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pubPath = path.join(root, 'electron', 'hotfix-public.pem');
const privPath = path.join(root, '.hotfix-private.pem');

if (fs.existsSync(pubPath) && !process.argv.includes('--force')) {
  console.log('[hotfix] 已存在公钥，未覆盖：', pubPath);
  console.log('[hotfix] 确需重来加 --force —— 注意已发布的老壳里写死的是旧公钥，新钥匙签的包它们不认');
  process.exit(0);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

console.log('[hotfix] 公钥 →', pubPath, '（随安装包发布，可提交）');
console.log('[hotfix] 私钥 →', privPath, '（已在 .gitignore）');
console.log('[hotfix] 下一步：把私钥整段内容存进 GitHub 仓库 secret：HOTFIX_PRIVATE_KEY');
