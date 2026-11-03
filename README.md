# 图库

**桌面应用（Electron）**：多源采集、去重、筛选、浏览与管理本地高清图片，图片**直接保存到本地文件夹**，可一键设为桌面壁纸。
技术栈：**Electron + Node 22+（内置 `node:sqlite`）+ Express 5 + sharp + React 18 + Vite 6**，无需外部数据库。

## 启动桌面应用

```bash
npm install            # 仓库根目录执行（应用代码就在本仓库内，无需进入子目录）
npm run desktop        # 先构建前端，再启动 Electron 窗口
```

首次启动后：设置 → 通用 →「保存文件夹」→ 选择你要存放照片的目录。
采集到的图片会以 `关键词_来源_宽x高_时间.jpg` 直接写入该目录，可用资源管理器直接浏览。

其它命令：

```bash
npm run desktop:dev    # 已构建过前端，只启动 Electron
npm start              # 网页模式（浏览器访问 http://localhost:3001）
npm run dev            # 前端热更新 http://localhost:5173 + 后端 :3001
npm run verify         # 提交前跑一遍：eslint + 双 tsconfig 类型检查 + 单测 + 服务端冒烟
npm run unit           # 只跑 node --test 单测（test/ 下）
npm run smoke          # 只跑接口冒烟（真起服务、临时目录，不碰你的图库）
npm run lint           # eslint + 自定义静态检查
```

> 已存在的素材用「导入本地素材」登记（按原路径登记，不复制），导入过程会去重并生成缩略图；
> 每个素材文件夹就是一个资源库，库数据放在该文件夹下的 `.gemvault/` 里，随素材一起搬走。

## 功能

| 模块 | 说明 |
|---|---|
| 多资源库 | 一个素材文件夹 = 一个资源库，各自独立的 `gallery.db` 与缩略图；左上角切换 / 新建 / 重命名，跨库访问被库代数与根路径前缀双重拦截 |
| 多源采集 | 必应图片 / 百度图片 / 搜狗图片 / Wallhaven / 微博，关键词可增删改，每关键词可配置页数；**边搜边下载**，双进度条 + 失败明细（含原因），已下载 URL 跳过；任务落 `jobs` 表，中断可续采 |
| 网络代理 | 关闭 / 系统代理 / HTTP / HTTPS / SOCKS5 / SOCKS4 + 主机、端口、账号密码、测试连接；采集、下载、AI 全部生效 |
| 质量过滤 | 长边最小像素、最小文件大小、格式白名单、单张体积上限；深度过滤规则可配 |
| 去重 | pHash（DCT 感知哈希）+ MD5 精确重复 + CLIP 语义相似三路；支持「全库 / 当前筛选 / 已选」三种扫描范围 |
| 图库浏览 | 瀑布流 / 网格 / **列表**三视图，列表可按名称、体积、时间排序；缩略图懒加载、无限滚动、多层级文件夹树 |
| 媒体预览 | 图片 / 视频 / 音频 / PDF（内嵌阅读器 + 页码跳转）/ PSD / Office（docx、xlsx）/ 3D（glb、gltf、obj、fbx、stl、ply）|
| 大图预览 | Lightbox 全屏查看，信息检查器（分辨率 / 体积 / 来源 / 关键词 / 时间 / EXIF / 版本），ESC 关闭、方向键切换、收藏与标签编辑；预览图按可见区预取并带版本号长缓存，翻页与重复打开不糊 |
| 图片编辑 | 单张与**批量裁切**（逐张框选、焦点检测自动构图）、旋转、调色（曝光/对比度/白平衡/曲线，预览与成品逐像素一致）、画质增强、纯底图抠图、AI 抠图、多区域裁切、**水印 / 相框**（23 款水印 + 20 款相框，读 EXIF 显示品牌型号 / 镜头 / 光圈 / 快门 / ISO / 时间 / 拍摄地点，可勾选、可批量）；写回前自动存版本 |
| 版本历史 | 每次改写原图前保存旧文件，可按版本预览、回滚（回滚前再存一份，避免连锁丢失） |
| 整理工具 | 相似图分组（pHash / CLIP）、同目录同名跨格式重复、拼接联系表（最多 60 张，1–12 列、间距、底色、输出格式）、并排 / 分割 / 重叠三种对比 |
| OCR | Windows 系统 WinRT OCR（零外部二进制），识别图内文字并写入索引，可直接参与关键词搜索 |
| 外部以图搜图 | SauceNAO 上传识别；Google Lens / TinEye 对带公网 `source_url` 的图可直链打开；并尝试推断更大的原图地址一键换大图 |
| 动作（Actions） | 可编排的步骤：打标签 / 移入文件夹 / 评分 / 写备注 / 改标题 / 收藏 / OCR / AI 描述 / 自定义 AI 提示；支持按筛选预估命中数与批量执行 |
| 书签浏览器 | 保存网页书签（标题、描述、封面、离线 HTML 快照，快照以 CSP `script-src 'none'` 提供），左侧列表预览、右侧直接看快照，可打开原网址 / 复制链接 / 重命名 / 删除 |
| 命令面板 | `Ctrl/⌘+K` 搜命令，`Alt+F` 搜筛选器，卡片右键「搜索命令…」；导航、操作、界面、帮助统一入口 |
| 收藏与标签 | 心形收藏、收藏夹视图、自定义标签（含标签元数据）与按标签筛选 |
| 下载与导出 | 单张下载、批量选中打包 ZIP、导出 HTML 画廊（单文件内嵌缩略图）、元数据 JSON / CSV |
| 数据出口 | 备份（VACUUM INTO 的 `gallery.db` + 可读 `library.json` + 可选缩略图）→ 恢复为新库时按旧根目录重映射绝对路径；从 Eagle 4 `.library` 迁移（名称/标签/备注/来源） |
| 维护工具 | 库体检（张数 / 文件缺失 / 缩略图占用 / DB 体积 / 可撤销数）、重建缺失与过期缩略图（按原图 `mtime` 判断，重建后重算 pHash 并更新 `cover_ver`）、清理孤立缩略图（先试运行报数量再确认删除）、压缩数据库（`VACUUM` + 完整性检查）、补算音视频时长、库-盘失配的「尝试找回 / 移除记录」 |
| 桌面能力 | 图片直接落盘；「设为桌面壁纸」「在文件夹中显示」、原生拖拽导出、开机自启、托盘、全局快捷键、应用内更新 |
| AI 接入 | OpenAI 兼容接口，内置常见预设 + 自定义 Base URL / Key / 文本与视觉模型；支持拉取模型列表与测试连接；AI 结果可追溯（搜索会标明实际使用的引擎） |
| AI 知识库 | 删除图片时选择「为什么不满意」并可让 AI 看图补充 → 沉淀为规则（来源/关键词/分辨率/宽高比/标签/相似画面/AI 描述词）→ 打分、降权排序、采集过滤、生成采集建议 |
| 采集扩展 | Chrome MV3 扩展：单图 / 本页全部图片 / 可见区域截图 / **整页滚动截图**入库；端口自动探测，扩展 ID 固定 |
| 仪表盘 | 总数 / 收藏数 / 体积 / 来源分布 / 分辨率分布 / 采集趋势 / 最近与最高画质预览 |
| 设置 | 采集参数、去重阈值、采集源开关、关键词、保存位置与多库、回收站、代理、AI、任务、扩展、备份恢复、应用更新、**新手教程**（分步导览可随时重看／关闭自动弹） |
| 新手教程 | 7 步高亮导览（侧栏 → 工具箱 → 筛选 → 网格 → 大图编辑 → 设置），可逐步「下一步」或一键跳过；看完/跳过记入设置，之后可在 设置 → 新手教程 重看 |

## API

接口按领域拆在 `server/routes/*.js`，每个文件 `register(app, ctx)` 挂载；下表是主要入口，逐条全量列表以各路由文件为准。

```
# 资源与浏览
GET    /api/stats                       统计概览
GET    /api/images?q=&source=&favorite=&orientation=&bucket=&tag=&sort=&page=
GET    /api/images/:id                  PATCH(收藏/标签/标题/备注)  DELETE
GET    /api/images/:id/thumb|file|download|snapshot
GET    /api/images/:id/exif|pdf-info|versions|ocr|search-providers
GET/POST /api/libraries                 多资源库列表 / 新建；POST /api/libraries/:id/activate 切换；PUT/DELETE /api/libraries/:id
GET    /api/folders                     多层级文件夹树
GET    /api/tags   GET /api/sources   GET /api/smart-folders   GET /api/playlists
GET    /api/trash   POST /api/trash/:id/restore   POST /api/trash/empty

# 采集、导入、任务
POST   /api/crawl/start|stop            采集任务（jobs 表可续采）
POST   /api/import/local                导入本地素材
POST   /api/extension/ingest            扩展投递（按固定扩展 ID 免令牌）
GET    /api/jobs   POST /api/jobs/:id/cancel|retry
GET    /api/ops    POST /api/ops/:id/undo|undo-last     统一撤销栈

# 编辑与增强
POST   /api/images/:id/crop|rotate|adjust|remove-bg|crop-regions
POST   /api/enhance/:id                 画质增强（单张）；POST /api/enhance/job/start 批量
GET    /api/images/:id/versions         版本列表 / 预览 / 回滚
POST   /api/images/batch/edit           批量编辑作业；GET /api/edit/job 查进度，POST /api/edit/job/cancel 取消

# 整理
GET    /api/similar?threshold=&ids=      pHash 相似分组（ids 限定扫描范围）
GET    /api/similar/clip?minCos=&ids=    CLIP 语义相似分组
GET    /api/dupes/format|md5             同目录跨格式 / MD5 精确重复
POST   /api/similar/resolve              保留一张、其余进回收站
POST   /api/maintenance/dominant|subject 主色 / 主体哈希补算

# OCR、来源、动作
POST   /api/images/:id/ocr   GET /api/ocr/status
POST   /api/images/:id/reverse-search   GET .../upgrade-source/preview   POST /api/images/:id/upgrade-source
GET/POST/PUT/DELETE /api/actions        动作编排；GET /api/actions/:id/preview

# 导出与数据出口
GET    /api/export/options   GET /api/export/stitch?ids=   联系表
GET    /api/export/gallery                                 单文件 HTML 画廊（附件下载）
GET    /api/transfer/preview|metadata.json|metadata.csv
POST   /api/transfer/backup|restore|import-eagle            备份 / 恢复 / Eagle 迁移

# 设置与系统
GET/PUT /api/settings   GET/PUT /api/network   POST /api/network/test
GET    /api/ai/presets|status   POST /api/ai/test|models|analyze
GET    /api/kb/rules|feedback|stats   POST /api/kb/rescore
POST   /api/images/:id/wallpaper   GET/POST /api/wallpaper/*
GET    /api/health
```

## 目录

```
electron/       main.js 窗口/原生菜单/IPC · server-host.js 以 utilityProcess 拉起服务 · updater.js 更新
server/         app.js（组装与启动）· routes/*.js（按领域的 HTTP 入口）· lib/*.js（编辑/整理/传输等实现）
                db.js(建表与迁移) · library.js(入库/落盘/去重) · libraries.js(多资源库) · jobs.js(任务与撤销栈)
web/            前端源码：pages/（仪表盘 / 图库 / 整理 / 清单 / 采集 / 书签 / 知识库 / 搜索 / 增强 / 设置）
                components/（灯箱、工具箱、面板等）· styles/ 按区块拆分
extension/      Chrome MV3 采集扩展（打包时作为 extraResources 分发）
test/           node --test 单测（npm run unit）
scripts/        smoke.mjs 端到端冒烟 · lint.mjs 静态检查 · manual/ 历史手工排查脚本（需本机开发环境，不在 CI 里跑）
dist/web/       前端构建产物（vite build 输出，打包时随 asar 分发）
release-build/  electron-builder 打包输出
```

素材根目录下每个资源库各有 `<素材文件夹>/.gemvault/lib_xxx/`，里面是 `gallery.db` 与 `thumbs/`；
换机器或换盘符时整目录拷走即可（或走「设置 → 数据与维护 → 备份 / 恢复」）。

## 说明

- 桌面端后端跑在 Electron 的 `utilityProcess` 子进程里（随机端口，带 `?token=` 的 GET 才允许无头访问），图片由 Node 直接写入本地文件夹，不经浏览器下载；进程退出时会先停服再退出。
- 设为桌面壁纸：Windows 通过 `SystemParametersInfo(SPI_SETDESKWALLPAPER)`，macOS 用 Finder，Linux 用 gsettings。
- 工作区已有素材按原路径登记（不复制）；新采集的图片写入当前资源库的素材文件夹。
- 删除策略默认「应用内回收站」：文件移到库内 `trash/`（同盘移动，秒完成），可在设置页一键恢复；比系统回收站 API 更可靠（部分环境会报 `The system call level is not correct`）。
- 知识库完全本地：`feedback` / `kb_rules` / `ai_desc` 三张 SQLite 表，API Key 只存本机。
- 不配置 AI 也能变聪明：删除时选择的原因会直接转成规则；配置 AI 后可看图分析并归纳更细的规则。
- **OCR 只支持 Windows**（走系统 `Windows.Media.Ocr`，不需要装任何外部程序）；其它平台会明确显示不可用，而不是给一个点了没反应的按钮。
- **外部以图搜图**只对 SauceNAO 做真实上传识别；Google Lens / TinEye 需要图片有公网 URL，本地导入的图会被标注为不可用。Pinterest 只提供关键词外链，不冒称以图搜图。
- **备份不包含原图**：原图本来就在素材文件夹里，备份的是 `gallery.db` + 可读 `library.json` + 可选缩略图；恢复到新目录时会按备份里记录的旧根路径重映射 `abs_path`。
- 想跳过深度特征（离线 / CI / 只想跑接口）：用 `GEM_CLIP=off` 起服务，入库查重只走 pHash，语义搜索显示不可用。冒烟脚本默认就这么起——否则「模型这一会儿加载完没有」会让同一份代码在本地和 CI 上得出不同结论。
- **缩略图缓存必须比原图新才算命中**：缓存按 `id` 命名（`thumbs/xx/<id>.jpg`、`<id>-pv.jpg`），而 `id` 会在重建库 / 清空库 / 恢复备份后从头再来，只判断「文件存在」会把上一个库同一 `id` 的图当成自己的——表现就是列表缩略图和灯箱大图不是同一张，pHash 也跟着错。服务端一律比对 `mtime`（容忍 2s 文件系统精度），新入库与回收站还原走 `force`（先删残留再画），重建后 `cover_ver + 1` 让前端换 URL 而不是吃旧缓存。
- Wallhaven 在国内网络可能无法直连，采集失败时日志会提示，其余来源不受影响。

## 打包与代码签名

```bash
npm run dist        # vite build + electron-builder → release-build/Gallery-Setup-*.exe（NSIS 安装包）
npm run dist:dir    # 只出免安装目录 release-build/win-unpacked/，更快，适合先做打包验证
```

**代码签名（可选）**：不签名时 SmartScreen 会提示「未知发布者」，功能不受影响。
项目未内置证书；拿到 `.pfx/.p12` 证书文件后**无需改任何配置**，打包前设置环境变量即可：

```powershell
$env:CSC_LINK = "D:\certs\mycert.pfx"     # 证书文件路径（也支持 http(s) 直链）
$env:CSC_KEY_PASSWORD = "证书密码"
npm run dist
```

electron-builder 检测到 `CSC_LINK` 后自动对 exe 与安装包做 SHA-256 签名并加 RFC 3161 时间戳
（时间戳服务已在 `package.json` 的 `build.win` 中配置为 DigiCert）。
EV 证书（USB 硬件钥匙）不需要 `CSC_LINK`，装好厂商驱动后 electron-builder 会自动从证书库选择。
验证签名结果：

```powershell
Get-AuthenticodeSignature "release-build\Gallery-Setup-<版本号>.exe" | Format-List
```

## 持续构建与 Releases

`.github/workflows/build.yml` 每次云端构建都会更新 Release（`contents: write`）：

| 触发 | verify | 打包 | Release |
| --- | --- | --- | --- |
| push `main` / 手动触发 | 跑 | 通过后打包 | 更新预发布 **rolling**（固定 tag，exe / blockmap / latest.yml 原地覆盖，tag 跟随最新提交） |
| push tag `v*` | 跑 | 通过后打包 | 建正式 Release（`make_latest: true`，客户端自动更新只认它） |
| PR | 跑 | 不打包 | 不更新 |

几点约定：

- rolling 是**预发布**，不会被 `/releases/latest` 选中——开发版不会通过自动更新推到用户手里；想要新版请推 tag。
- 打包产物名带版本号（`Gallery-Setup-<version>.exe`），版本号一升文件名就变，所以构建前会先删掉 rolling 里不属于本次的旧 exe / blockmap / latest.yml，避免越堆越多。
- 同一 ref 的多次构建串行排队（`concurrency`，不取消），防止两个运行同时往一个 Release 传产物互相覆盖。
- 产物同时留一份 Actions Artifact（14 天），构建失败时日志推到 `ci-logs` 分支。
