/**
 * 前后端契约守门：把服务端 DTO 的字段清单变成可编译、可校验的东西。
 *
 * 以前 `web/src/types.ts` 与 `server/library.js:toDTO` 是两份手写清单，
 * 改字段名/漏字段编译器完全帮不上忙（这轮就踩过一次：DTO 加字段、前端不知道）。
 * 这个脚本做两件事：
 * 1. 从 toDTO 的返回字面量里抽出字段名，落到 `web/src/dto.generated.ts`，
 *    前端 `ImageItem` 用 `extends` 接上 —— DTO 新增字段会以 unknown 出现，
 *    没声明类型就拿来用会直接编译报错；
 * 2. 双向比对两份清单，任一侧多出/少了字段都退出码 1，接在 `npm run verify` 里。
 *
 * 只做「字段名」这一层：类型仍由前端手写（DTO 里 `row.xxx` 推不出可用类型），
 * 但改名、删字段、加字段这类最容易出事的漂移会在 CI 当场红。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DTO_SRC = path.join(root, 'server', 'library.js');
const TYPES_SRC = path.join(root, 'web', 'src', 'types.ts');
const OUT = path.join(root, 'web', 'src', 'dto.generated.ts');

/**
 * 只在某一侧存在的字段，必须写明理由 —— 否则「漏了」和「故意」分不开。
 * dtoOnly：后端返回但前端不声明（前端确实不用，可忽略）
 * clientOnly：前端自己有、后端 DTO 不返回（由列表/搜索接口二次拼装或纯客户端状态）
 */
const ALLOWED = {
  dtoOnly: {},
  clientOnly: {
    stackCount: '列表接口经 attachStackInfo 二次拼装',
    stackPrimary: '同上',
    matchHex: '颜色搜索命中色，搜索路由就地加',
    dist: '颜色搜索距离，搜索路由就地加',
    inheritedTags: '文件夹继承标签，列表路由二次拼装',
    quality: '按图找相似（CLIP）时由搜索路由补的组内画质分',
    cos: '按图找相似的余弦相似度，同上',
  },
};

/** 从 `return {` 开始按花括号配对切出对象字面量文本 */
function sliceObject(src, from) {
  const start = src.indexOf('{', src.indexOf('return', from));
  if (start < 0) throw new Error('没找到 toDTO 的 return 对象');
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (!depth) return src.slice(start + 1, i);
    }
  }
  throw new Error('toDTO 的 return 对象没有闭合');
}

/**
 * 从对象字面量 / 接口体里抽**顶层**字段名。
 * 不能只靠缩进匹配：toDTO 的 return 对象缩进 4 格，接口体缩进 2 格，
 * 而嵌套对象里的键必须排除 —— 所以按括号深度判，深度 0 处行首的键才算。
 */
function objectKeys(text) {
  const keys = [];
  let depth = 0;
  let line = '';
  const take = () => {
    if (depth !== 0) return;
    // `:` 接口字段/普通属性；`(` 方法；`tags,` 是对象字面量的简写属性，同样算字段
    const m = line.match(/^\s*([A-Za-z_$][\w$]*)\??\s*(?::|\(|,|$)/);
    if (m) keys.push(m[1]);
  };
  for (const ch of text) {
    if (ch === '\n') {
      take();
      line = '';
      continue;
    }
    line += ch;
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
  }
  take();
  return keys;
}

function interfaceBody(src, name) {
  // 允许 `interface X {` 与 `interface X extends Y {` 两种写法（后者接了生成的 DTO 形状）
  const at = src.indexOf(`export interface ${name} `);
  if (at < 0) throw new Error(`types.ts 里没有 interface ${name}`);
  let depth = 0;
  const start = src.indexOf('{', at);
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (!depth) return src.slice(start + 1, i);
    }
  }
  throw new Error(`interface ${name} 没有闭合`);
}

const libSrc = fs.readFileSync(DTO_SRC, 'utf8');
const dtoKeys = objectKeys(sliceObject(libSrc, libSrc.indexOf('export function toDTO')));

const typesSrc = fs.readFileSync(TYPES_SRC, 'utf8');
const typeKeys = objectKeys(interfaceBody(typesSrc, 'ImageItem'));

const set = (a) => new Set(a);
const dtoSet = set(dtoKeys);
const typeSet = set(typeKeys);

const missingInTypes = dtoKeys.filter((k) => !typeSet.has(k) && !ALLOWED.dtoOnly[k]);
const missingInDto = typeKeys.filter((k) => !dtoSet.has(k) && !ALLOWED.clientOnly[k]);

/* 生成的前端形状：字段集合与 DTO 完全一致，类型一律 unknown（前端在 ImageItem 里收窄）。
   一律写成可选：DTO 恒返回的字段前端也可能收窄成可选（如 trimStart?: number），
   可选基类才能同时容纳「必填」与「可选」两种收窄写法。 */
const lines = [
  '/**',
  ' * 由 scripts/gen-dto-types.mjs 生成，请勿手改。',
  ' * 字段清单直接取自 server/library.js 的 toDTO 返回字面量。',
  ' * 作用：DTO 改名/删字段会让 ImageItem 的收窄声明失去对应字段，',
  ' * 新增字段则先以 unknown 出现，必须在前端显式声明类型才能当具体类型用。',
  ' */',
  'export interface ImageDTOShape {',
  ...dtoKeys.map((k) => `  ${k}?: unknown;`),
  '}',
  '',
];
const generated = lines.join('\n');
const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
const changed = old !== generated;
if (changed) fs.writeFileSync(OUT, generated, 'utf8');

let failed = false;
if (missingInTypes.length) {
  failed = true;
  console.error(`[dto] toDTO 有、ImageItem 缺的字段（改名或漏声明）：${missingInTypes.join(', ')}`);
}
if (missingInDto.length) {
  failed = true;
  console.error(`[dto] ImageItem 有、toDTO 不返回的字段（DTO 删了？）：${missingInDto.join(', ')}`);
}
const staleAllowed = [
  ...Object.keys(ALLOWED.dtoOnly).filter((k) => typeSet.has(k)),
  ...Object.keys(ALLOWED.clientOnly).filter((k) => dtoSet.has(k)),
];
if (staleAllowed.length) {
  failed = true;
  console.error(`[dto] 白名单已过期（这些字段那边已经声明了），请从 ALLOWED 删掉：${staleAllowed.join(', ')}`);
}
if (failed) process.exit(1);

console.log(
  `[dto] 契约一致：toDTO ${dtoKeys.length} 字段 · ImageItem ${typeKeys.length} 字段${changed ? ' · 已更新 dto.generated.ts' : ''}`
);
