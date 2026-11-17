/**
 * 把「已核对来源」的模型/安装包 sha256 固化进随包只读清单 server/model-pins.json。
 *
 * 用法：
 *   npm run pin-models -- <本地文件> <键>
 *   键为 HuggingFace 镜像内相对路径时写入 models，为 http(s) URL 时写入 zips。
 *
 * 例：
 *   npm run pin-models -- ./models/onnx/model.onnx onnx/model.onnx
 *   npm run pin-models -- ./realesrgan.zip https://github.com/.../windows.zip
 *
 * ⚠️ 必须先确认这个文件来自官方发布源且未损坏（对照官方 digest / 重新下载比对），
 * 再提交生成的 model-pins.json。清单会打包进 asar，运行时用户改不了，
 * 因此它才是能挡住「模型 + sidecar 一起被替换」的可信参照。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pinsFile = path.join(root, 'server', 'model-pins.json');
const [file, key] = process.argv.slice(2);

if (!file || !key) {
  console.log('用法: npm run pin-models -- <本地文件> <镜像内路径或下载 URL>');
  process.exit(1);
}

const abs = path.resolve(root, file);
if (!fs.existsSync(abs)) {
  console.error(`文件不存在：${abs}`);
  process.exit(1);
}
if (!/^[\w./-]+$/.test(key) && !/^https?:\/\//i.test(key)) {
  console.error('键必须是镜像内相对路径或 http(s) URL');
  process.exit(1);
}

const hex = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
const pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
const bucket = /^https?:\/\//i.test(key) ? 'zips' : 'models';
pins[bucket][key] = hex;
fs.writeFileSync(pinsFile, `${JSON.stringify(pins, null, 2)}\n`, 'utf8');
console.log(`已固化 ${bucket}.${key} = ${hex}`);
console.log('请核对官方发布来源后，再把 server/model-pins.json 提交进仓库（随包清单优先于 sidecar）。');
