# 手工验证脚本（不在 CI 里跑）

这些脚本是当初排查具体界面问题时写的一次性脚本，需要本机已启动开发环境、并且装了
`agent-browser` 才能跑。它们**不在** `npm run verify` / CI 里，也从来没有被任何 npm
脚本或文档引用过——之前散在 `scripts/` 根下，看起来像是自动化测试的一部分，实际谁都不会执行。

留在这里是为了需要复现旧问题时还能找到，不要再往这里加新脚本。

需要自动化验证的话请看：

- `npm run verify`：eslint + 双 tsconfig 类型检查 + 单测 + `scripts/smoke.mjs`（真起服务）
- `scripts/smoke.mjs`：接口冒烟，断言安全头、鉴权、核心读写

注意：`verify-live.mjs` 里的 `C:\missing.mp4` 是故意写的不存在路径，用来验证
「保存视频壁纸配置时不真的去挂载文件」，不是笔误。
