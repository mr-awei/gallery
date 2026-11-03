import js from '@eslint/js';

/**
 * 真 lint。此前 npm run lint 走 scripts/lint.mjs，实际只做 node --check 语法校验，
 * 抓不到「未使用变量 / 重复键 / 不可达代码 / 可疑正则」这类真问题，等于假 lint。
 *
 * 分工：TS/TSX 的类型与未使用符号由 tsc 双 tsconfig（含 noUnusedLocals）负责，
 * 这里只覆盖服务端、Electron 主进程、脚本这些纯 JS 代码，避免再引入 typescript-eslint
 * 这一坨重依赖。
 */

// 只用到的 Node/Electron 运行时全局，手写一份，省掉 globals 依赖
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  module: 'writable',
  require: 'readonly',
  exports: 'writable',
  global: 'readonly',
  globalThis: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  fetch: 'readonly',
  structuredClone: 'readonly',
  performance: 'readonly',
  navigator: 'readonly',
  // Node 18+ 的全局（CLIP / 超分里直接用 Blob 喂 onnxruntime，别再当成未定义）
  Blob: 'readonly',
  File: 'readonly',
  WebSocket: 'readonly',
  FormData: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  crypto: 'readonly',
};

// 浏览器扩展的 service worker / popup 环境
const extensionGlobals = {
  chrome: 'readonly',
  browser: 'readonly',
  document: 'readonly',
  window: 'readonly',
  location: 'readonly',
  getComputedStyle: 'readonly',
  fetch: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  // MV3 Service Worker 里拼长图用的离屏画布与 base64 编码
  OffscreenCanvas: 'readonly',
  createImageBitmap: 'readonly',
  btoa: 'readonly',
};

export default [
  {
    ignores: [
      'dist/**',
      'release-build/**',
      'node_modules/**',
      '.codebuddy/**',
      '_tmp/**',
      'scripts/_audit.mjs',
      // scripts/manual/* 是当初排查界面问题的一次性脚本，不在任何自动化流程里，
      // 引用的又是当时的临时目录和变量名；纳入 lint 只会不断冒无关告警
      'scripts/manual/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      // 服务端/主进程本来就靠 console 输出诊断信息，调试残留由 lint.mjs 的阈值告警负责
      'no-console': 'off',
      // catch {} 是刻意忽略（很多地方是「尽力而为」的清理），不算错误
      'no-empty': ['error', { allowEmptyCatch: true }],
      // for (;;) 是本项目常用的无限循环写法
      'no-constant-condition': ['error', { checkLoops: false }],
      // 捕获了但没用到的 error 很常见（只关心是否抛）
      'no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // 正则里允许 \u0000 之类的控制字符（解析二进制头时要用）
      'no-control-regex': 'off',
      // 有些地方刻意用构造函数字符串拼日志
      'no-new-func': 'warn',
      // 兜底类型判断常写 obj.hasOwnProperty
      'no-prototype-builtins': 'off',
      eqeqeq: ['warn', 'smart'],
      'no-fallthrough': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-redeclare': 'error',
      'no-self-assign': 'error',
      'no-async-promise-executor': 'warn',
      'no-loss-of-precision': 'error',
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      'no-var': 'warn',
    },
  },
  {
    // 测试与 CI 报告脚本：允许随意打印与非常规写法
    files: ['test/**/*.mjs', 'scripts/verify-*.mjs'],
    rules: {
      'no-console': 'off',
      'no-unused-vars': 'off',
    },
  },
  {
    // 浏览器扩展跑在 chrome.* 环境里，不是 Node
    files: ['extension/**/*.js'],
    languageOptions: { globals: extensionGlobals },
  },
];
