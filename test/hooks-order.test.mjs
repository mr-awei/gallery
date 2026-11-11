/**
 * 静态守门：组件里「先 return 再调 hook」。
 *
 * 为什么需要这条测试：eslint 配置只覆盖纯 JS（TS/TSX 交给 tsc），没有 react-hooks 插件，
 * 所以这类错误在 typecheck / lint 里全是绿的，只会在真实渲染时炸成
 * 「Rendered more hooks than during the previous render」——整页白屏，用户只能重启。
 * 本轮 Timeline 的「整页空就自动重建」effect 就是这么写崩的，故用 TS 编译器 API 钉死。
 *
 * 判据：块级函数体里，顶层的 return 语句之后又出现了 use* 调用（不钻进嵌套函数，
 * 那是另一个组件/回调的作用域）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = path.join(ROOT, 'web', 'src');

function listSources(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) listSources(full, out);
    else if (/\.tsx?$/.test(ent.name)) out.push(full);
  }
  return out;
}

const isHookName = (name) => /^use[A-Z0-9]/.test(name);

/** 该表达式里是否调用了 hook（不深入嵌套函数体） */
function containsHookCall(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isFunctionLike(n)) return; // 嵌套函数有自己的 hook 作用域
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && isHookName(callee.text)) {
        found = true;
        return;
      }
      // React.useState(...) / React.useMemo(...)
      if (ts.isPropertyAccessExpression(callee) && isHookName(callee.name.text)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** 该语句里是否含 return（`if (!x) return null;` 这种早退也要抓到，同样不深入嵌套函数） */
function containsReturn(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** 返回该文件里「return 之后才调 hook」的位置描述 */
function offendersIn(file) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body && ts.isBlock(node.body)) {
      let returned = false;
      for (const st of node.body.statements) {
        if (returned && containsHookCall(st)) {
          const { line } = sf.getLineAndCharacterOfPosition(st.getStart(sf));
          hits.push(`第 ${line + 1} 行：早退之后的 hook 调用`);
        }
        if (containsReturn(st)) returned = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

test('web/src 里没有「早退之后再调 hook」的组件', () => {
  const files = listSources(WEB_SRC);
  assert.ok(files.length > 20, `扫描到的源码太少（${files.length}），可能目录不对`);
  const bad = [];
  for (const file of files) {
    for (const hit of offendersIn(file)) {
      bad.push(`${path.relative(ROOT, file)} ${hit}`);
    }
  }
  assert.deepEqual(bad, [], `发现条件调用 hook：\n${bad.join('\n')}`);
});
