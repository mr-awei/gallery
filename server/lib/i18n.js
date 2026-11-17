// @ts-check
/**
 * 服务端用户可见文案（error / msg / message 等）的中英字典与语言切换。
 *
 * 为什么统一在响应出口翻译，而不是逐个路由改写字符串：
 *   - 错误文案散落在 server/ 下近 200 个文件的 500 多处，逐点改会制造大量噪声；
 *   - 桌面端是单用户本地服务，语言偏好是全局的（跟随界面语言），
 *     在 res.json 出口按 Accept-Language 统一翻译，覆盖最全、对业务代码零侵入；
 *   - 带变量的模板文案（如 `${action}失败：${msg}`）先按占位符编译成正则再替换，
 *     仍然只匹配服务端自己产出的句式，不会把用户的文件名 / 路径当文案处理。
 *
 * 用法：在注册路由之前 app.use(localeMiddleware)。
 */

/** @type {Record<string, string>} 中文原文 → 英文译文 */
const EN = {
  "${action}失败：${err?.message || code || '未知错误'}": "${action} failed: ${err?.message || code || 'Unknown error'}",
  "${action}失败：文件「${name}」已不存在（可能被移动或删除）。": "${action} failed: file \"${name}\" no longer exists (it may have been moved or deleted).",
  "${action}失败：文件「${name}」正被其他程序占用或拒绝访问。${OCCUPIED_HINT}": "${action} failed: file \"${name}\" is in use by another program, or access is denied. ${OCCUPIED_HINT}",
  "${action}失败：目标磁盘为只读。": "${action} failed: the target disk is read-only.",
  "${action}失败：磁盘空间不足。": "${action} failed: not enough disk space.",
  "${ext || '这种'} 格式不能直接上传，先在「工具箱 → 格式转换」转成 JPG 再搜": "${ext || 'This'} format can't be uploaded directly. Convert it to JPG in \"Toolbox → Format Conversion\" first, then search",
  "${format || '未知'} 格式暂不支持擦除，请先转成 PNG / JPEG / WebP": "${format || 'Unknown'} format doesn't support erasing yet; convert it to PNG / JPEG / WebP first",
  "${label}不合法": "${label} is invalid",
  "${label}必须是绝对路径（收到：${raw}）": "${label} must be an absolute path (received: ${raw})",
  "${label}路径过长": "${label} path is too long",
  "${model.label} 安装完成": "${model.label} installed",
  "${source} 返回的不是 JSON（可能触发风控或页面已改版）：${String(text).slice(0, 120)}": "${source} did not return JSON (bot protection may have been triggered, or the page has changed): ${String(text).slice(0, 120)}",
  "/api/v1 需要 Authorization: Bearer 令牌": "/api/v1 requires an Authorization: Bearer token",
  "AI 抠图模型还没下载（设置 → AI 里可下载，约 4.5MB）；白底/灰底这类图直接用「纯底图抠图」即可": "The AI matting model hasn't been downloaded yet (get it in Settings → AI, about 4.5MB); for images on white or gray backgrounds, just use \"Plain Background Matting\"",
  "AI 指令为空": "AI prompt is empty",
  "AI 未返回 JSON": "AI did not return JSON",
  "AI 未返回有效规则，现有规则保持不变": "AI returned no valid rules; existing rules are unchanged",
  "AI 未配置": "AI is not configured",
  "AI 未配置：请先在设置页填写 Base URL、API Key 与模型名称": "AI is not configured: enter the Base URL, API Key, and model name in Settings first",
  "AI 没有返回可写入的内容": "AI returned nothing that could be saved",
  "AI 超分失败（退出码 ${code}）：${(err || out).slice(-300) || '无输出'}": "AI upscaling failed (exit code ${code}): ${(err || out).slice(-300) || 'No output'}",
  "AI 运行库${useCugan ? '（Real-CUGAN）' : ''}${binCheck.reason}，已删除并请重新下载": "AI runtime ${useCugan ? '(Real-CUGAN)' : ''}${binCheck.reason}; it has been deleted, please download it again",
  "AI 返回非 JSON：${text.slice(0, 200)}": "AI returned non-JSON: ${text.slice(0, 200)}",
  "C# 预编译缓存 DLL 写入失败": "Failed to write the C# precompiled cache DLL",
  "CLIP 已通过 TUKU_CLIP=off 关闭": "CLIP is disabled via TUKU_CLIP=off",
  "CLIP 扫描 worker 已退出": "CLIP scanning worker has exited",
  "CLIP 模型与随包可信哈希不一致：${key}，请删除 ${file} 后重新下载": "CLIP model does not match the trusted hash bundled with the app: ${key}. Delete ${file} and download it again",
  "CLIP 模型尚未加载完成，稍后再试": "The CLIP model hasn't finished loading yet, try again later",
  "CLIP 模型尚未加载完成，稍后再试（首次需下载模型）": "The CLIP model hasn't finished loading yet, try again later (the model must be downloaded on first use)",
  "CLIP 模型未就绪": "CLIP model is not ready",
  "CLIP 模型未就绪：先在设置里下载语义模型（之后离线可用）": "CLIP model is not ready: download the semantic model in Settings first (it works offline afterwards)",
  "EPUB 条目过多，已拒绝解析": "Too many EPUB entries, parsing refused",
  "Eagle 资源库目录不存在": "Eagle library folder does not exist",
  "HNSW 维度不一致：${vec.length} != ${this.dim}": "HNSW dimension mismatch: ${vec.length} != ${this.dim}",
  "OCR 输出解析失败（系统组件返回了非预期内容）": "Failed to parse OCR output (the system component returned unexpected content)",
  "QR 数据位摆放不完整": "QR data bits are incomplete",
  "QR 码字交织长度不一致": "QR codeword interleaving lengths do not match",
  "Real-CUGAN 安装完成": "Real-CUGAN installed",
  "Real-CUGAN 未安装": "Real-CUGAN is not installed",
  "SCHEMA_VERSION(${SCHEMA_VERSION}) 与迁移表最新版本(${LATEST_MIGRATION}) 不一致": "SCHEMA_VERSION(${SCHEMA_VERSION}) does not match the latest migration version (${LATEST_MIGRATION})",
  "SauceNAO 返回 ${resp.status}": "SauceNAO returned ${resp.status}",
  "SauceNAO 返回 ${resp.status}，请稍后再试": "SauceNAO returned ${resp.status}, try again later",
  "Wikimedia Commons 返回错误：${json.error.info || json.error.code}": "Wikimedia Commons returned an error: ${json.error.info || json.error.code}",
  "Yandex 没有返回检索 id（多半触发了风控验证），过一会儿再试": "Yandex returned no search id (bot verification was probably triggered); try again in a moment",
  "Yandex 返回 ${resp.status}": "Yandex returned ${resp.status}",
  "Yandex 返回的不是结果数据（多半触发了风控验证），过一会儿再试": "Yandex did not return result data (bot verification was probably triggered); try again in a moment",
  "dataUrl 不是图片 data URL": "dataUrl is not an image data URL",
  "day 需形如 2026-11-13": "day must look like 2026-11-13",
  "ids 不能为空": "ids cannot be empty",
  "images/ 里没有 *.info 目录，可能不是 Eagle 4 资源库": "No *.info folders in images/, this may not be an Eagle 4 library",
  "library.json 已损坏，无法确认备份来源与版本": "library.json is corrupted; the backup source and version cannot be determined",
  "month 需形如 2026-11": "month must look like 2026-11",
  "plugin.json 必须是对象": "plugin.json must be an object",
  "transformers 的下载不支持中止，请等它结束": "The transformers download cannot be cancelled; wait for it to finish",
  "「${row.summary || row.op}」不支持撤销": "\"${row.summary || row.op}\" cannot be undone",
  "一项信息都没选：请至少勾选一个要显示的拍摄信息，或打开「品牌 logo」": "Nothing selected: check at least one shooting info item to display, or turn on \"Brand logo\"",
  "上传失败（HTTP ${status}）：${text.slice(0, 240)}": "Upload failed (HTTP ${status}): ${text.slice(0, 240)}",
  "下载不完整，请重试": "Download incomplete, please try again",
  "下载失败 HTTP ${res.status}": "Download failed HTTP ${res.status}",
  "下载失败：${errors.join('；').slice(0, 300)}": "Download failed: ${errors.join('; ').slice(0, 300)}",
  "下载失败：HTTP ${res.status}": "Download failed: HTTP ${res.status}",
  "下载文件过小，疑似不完整": "Downloaded file is too small and looks incomplete",
  "下载结果失败（HTTP ${dl.status}）": "Download failed (HTTP ${dl.status})",
  "下载超时": "Download timed out",
  "不允许访问本机或内网地址": "Access to local or intranet addresses is not allowed",
  "不是 EPUB 文件": "Not an EPUB file",
  "不是 PDF 文件": "Not a PDF file",
  "不是受支持的插件包格式（tuku-plugin/1）": "Not a supported plugin package format (tuku-plugin/1)",
  "不是可下载的图片": "Not a downloadable image",
  "不是合法的 JSON 主题包": "Not a valid JSON theme pack",
  "不是图库主题包（kind=${String(raw.kind).slice(0, 40)}）": "Not a library theme pack (kind=${String(raw.kind).slice(0, 40)})",
  "不是图片 data URL": "Not an image data URL",
  "不是有效的 EPUB：OPF 文件读不出来": "Not a valid EPUB: the OPF file cannot be read",
  "不是有效的 EPUB：找不到 OPF 文件": "Not a valid EPUB: OPF file not found",
  "不是有效的 EPUB：缺少 META-INF/container.xml": "Not a valid EPUB: missing META-INF/container.xml",
  "不是有效的 zip 包（签名不符），可能被镜像替换或下载中断": "Not a valid zip package (signature mismatch); it may have been replaced by a mirror or the download was interrupted",
  "不是本素材目录的旧图库": "Not an old library belonging to this asset folder",
  "不能写入开机启动目录（${resolved}）": "Cannot write to the startup folder (${resolved})",
  "不能写入系统目录（${resolved}）": "Cannot write to the system folder (${resolved})",
  "不能把标签挂到自己的子标签下": "Cannot attach a tag under its own subtag",
  "不能直接使用根目录（${resolved}）": "Cannot use the root folder directly (${resolved})",
  "不能直接使用磁盘根目录（${resolved}）": "Cannot use a disk root directory directly (${resolved})",
  "主题包不存在": "Theme pack does not exist",
  "主题包内容为空": "Theme pack is empty",
  "主题包版本 ${raw.version} 高于当前支持的 ${PACK_VERSION}，请升级应用": "Theme pack version ${raw.version} is newer than the supported ${PACK_VERSION}; please update the app",
  "书签不存在": "Bookmark does not exist",
  "二维码内容不能为空": "QR code content cannot be empty",
  "人物不存在": "Person does not exist",
  "人物重建正在进行中": "Person rebuild is already in progress",
  "人脸扫描已经在跑": "Face scan is already running",
  "人脸扫描正在进行中": "Face scan is in progress",
  "人脸检测模型输出异常（期望 9 个张量，实际 ${names.length} 个），请重新下载模型": "Face detection model produced unexpected output (expected 9 tensors, got ${names.length}); please download the model again",
  "人脸模型损坏或哈希不匹配（${check.reason || '校验失败'}），已删除，请在设置里重新下载": "Face model is corrupted or its hash does not match (${check.reason || 'verification failed'}); it was deleted, please download it again in Settings",
  "人脸模型未下载，请先到「设置 → 人脸识别」下载（约 191MB）": "Face model is not downloaded; get it in \"Settings → Face Recognition\" first (about 191MB)",
  "人脸模型正在下载，请稍后再试": "Face model is downloading, try again later",
  "人脸索引 ${done}/${pending0}": "Face indexing ${done}/${pending0}",
  "人脸记录不存在": "Face record does not exist",
  "仅 Windows 支持每个显示器独立壁纸": "Only Windows supports a separate wallpaper for each monitor",
  "令牌缺少 ${needed.join('、')} 权限": "Token is missing the ${needed.join(', ')} permission",
  "任务不存在": "Task does not exist",
  "任务已结束，无需停止": "Task has already ended, no need to stop it",
  "仿射矩阵不可逆": "Affine matrix is not invertible",
  "供应商不存在：${id}": "Provider does not exist: ${id}",
  "像素数据长度不足": "Pixel data is too short",
  "先开启局域网访问，分享链接才有可访问的端口": "Enable LAN access first, otherwise the share link has no reachable port",
  "入口文件不存在": "Entry file does not exist",
  "入库失败：${r.reason || '未知原因'}": "Import failed: ${r.reason || 'Unknown reason'}",
  "关键词不能为空": "Keyword cannot be empty",
  "内容过长（${dataLen} 字节），超出 QR version ${MAX_VERSION} 容量": "Content is too long (${dataLen} bytes), exceeding the capacity of QR version ${MAX_VERSION}",
  "内容过长，超出 QR byte mode 计数范围": "Content is too long, exceeding the QR byte mode count range",
  "内置插件不能卸载": "Built-in plugins cannot be uninstalled",
  "准备下载 ${model.label}…": "Preparing to download ${model.label}…",
  "准备下载 Real-CUGAN…": "Preparing to download Real-CUGAN…",
  "准备下载…": "Preparing to download…",
  "准备中…": "Preparing…",
  "准备重算人脸质量…": "Preparing to recalculate face quality…",
  "分享链接不存在或已失效": "Share link does not exist or has expired",
  "分组名不能为空": "Group name cannot be empty",
  "删除文件失败：${message}": "Failed to delete file: ${message}",
  "删除记录失败：${err.message}": "Failed to delete record: ${err.message}",
  "别名不能为空": "Alias cannot be empty",
  "别名不能包含英文逗号": "Alias cannot contain commas",
  "别名不能和标签本身同名": "Alias cannot be the same as the tag itself",
  "动作不存在": "Action does not exist",
  "动作名称不能为空": "Action name cannot be empty",
  "动作至少要包含一个步骤": "An action must contain at least one step",
  "动态壁纸目前仅支持 Windows": "Animated wallpapers are currently Windows-only",
  "包内未找到 realcugan-ncnn-vulkan.exe": "realcugan-ncnn-vulkan.exe not found in the package",
  "包内未找到 realesrgan-ncnn-vulkan.exe": "realesrgan-ncnn-vulkan.exe not found in the package",
  "包内未找到模型目录": "Model directory not found in the package",
  "升级前备份失败，已中止迁移（v${fromVersion} → v${SCHEMA_VERSION}）：${backup.error}。": "Backup before upgrade failed; migration aborted (v${fromVersion} → v${SCHEMA_VERSION}): ${backup.error}.",
  "原分组名不能为空": "Original group name cannot be empty",
  "原图记录已不存在": "The original image record no longer exists",
  "原图读取失败": "Failed to read the original image",
  "原密码不正确": "Current password is incorrect",
  "原文件不存在（可能被移动或删除）": "The original file does not exist (it may have been moved or deleted)",
  "原文件已经不在磁盘上，无法上传搜图": "The original file is no longer on disk, so it cannot be uploaded for search",
  "原文件记录缺失": "Original file record is missing",
  "去背景模型文件损坏或哈希不匹配（${check.reason || '校验失败'}），已删除并请在「设置 → 下载中心」重新下载": "Background removal model file is corrupted or its hash does not match (${check.reason || 'verification failed'}); it was deleted, please download it again in \"Settings → Download Center\"",
  "去背景模型未下载，请先到「设置 → 下载中心」下载": "Background removal model is not downloaded; get it in \"Settings → Download Center\" first",
  "参数无法序列化：${err?.message || err}": "Failed to serialize parameters: ${err?.message || err}",
  "只支持 http / https 地址": "Only http / https addresses are supported",
  "只支持 http/https 地址（收到 ${url.protocol}）": "Only http/https addresses are supported (received ${url.protocol})",
  "只能卸载用户插件目录里的插件": "Only plugins in the user plugin folder can be uninstalled",
  "只能定位素材库内的文件": "Only files inside the library folder can be located",
  "只能打开素材库目录内的文件夹": "Only folders inside the library folder can be opened",
  "只能读插件自己目录下的文件": "Can only read files in the plugin's own folder",
  "只读分享链接不能上传": "Read-only share links cannot be used for uploads",
  "合并需要两个不同的人物": "Merging requires two different people",
  "同步文件夹不可写：${err?.message || err}": "Sync folder is not writable: ${err?.message || err}",
  "同步文件夹不存在：${state.syncDir}": "Sync folder does not exist: ${state.syncDir}",
  "同步文件夹必须是绝对路径": "Sync folder must be an absolute path",
  "同步文件夹里还没有任何设备发布过快照": "No device has published a snapshot to the sync folder yet",
  "同步清单为空": "Sync manifest is empty",
  "同步清单版本 ${raw.version} 高于当前支持的 ${SYNC_VERSION}，请先升级应用": "Sync manifest version ${raw.version} is newer than the supported ${SYNC_VERSION}; please update the app first",
  "同步清单的 revision 不合法": "Sync manifest revision is invalid",
  "同步清单读取失败：${err?.message || err}": "Failed to read the sync manifest: ${err?.message || err}",
  "同步清单里的文件列表不完整": "The file list in the sync manifest is incomplete",
  "同步清单里的文件列表有重复或缺失": "The file list in the sync manifest has duplicates or missing entries",
  "同步清单里的文件校验和不合法：${String(f?.name || '?')}": "Invalid file checksum in the sync manifest: ${String(f?.name || '?')}",
  "名称不能为空": "Name cannot be empty",
  "响应过大（${Math.round(declared / 1024 / 1024)}MB），已中止": "Response too large (${Math.round(declared / 1024 / 1024)}MB), aborted",
  "响应过大（超过 ${Math.round(limit / 1024 / 1024)}MB），已中止": "Response too large (over ${Math.round(limit / 1024 / 1024)}MB), aborted",
  "响应过大，已中止": "Response too large, aborted",
  "回收站记录不存在": "Recycle bin record does not exist",
  "回收站里的文件已丢失": "The file in the recycle bin is missing",
  "图片不存在": "Image does not exist",
  "图片为空或超过 50MB": "Image is empty or larger than 50MB",
  "图片文件不存在": "Image file does not exist",
  "图片超过 12MB，搜图服务不接受这么大的上传": "Image is over 12MB; the reverse image search service does not accept uploads this large",
  "图片路径为空": "Image path is empty",
  "地址格式不对，检查一下有没有多余的空格": "Address format is wrong, check for extra spaces",
  "地址格式不正确": "Address format is incorrect",
  "地址缺少主机名": "Address is missing a hostname",
  "地址里不能包含账号密码": "Address cannot contain a username or password",
  "域名解析失败：${host}": "DNS lookup failed: ${host}",
  "堆叠不存在": "Stack does not exist",
  "处理超时": "Request timed out",
  "备份不完整，已中止恢复：${head}${more}": "Backup is incomplete, restore aborted: ${head}${more}",
  "备份数据库损坏（${value || '未知原因'}）": "Backup database is corrupted (${value || 'unknown reason'})",
  "备份数据库无法打开：${err?.message || err}": "Cannot open backup database: ${err?.message || err}",
  "备份文件夹不存在": "Backup folder does not exist",
  "备份文件已丢失，无法恢复这个版本": "Backup file is missing, cannot restore this version",
  "备份文件已丢失，无法撤销": "Backup file is missing, cannot undo",
  "备份里没有 images 表，不像是图库数据库": "Backup has no images table; this does not look like a library database",
  "多帧动图暂不支持擦除，请先导出其中一帧": "Erasing is not supported for multi-frame animations yet; export a single frame first",
  "夜间批处理正在运行": "Nightly batch processing is running",
  "安装失败：${err.message || err}": "Installation failed: ${err.message || err}",
  "安装完成": "Installation complete",
  "安装完成但宿主没有发现插件，请检查插件包内容": "Installation finished but the host did not find the plugin; check the plugin package contents",
  "完成：${r.exported} 个素材": "Done: ${r.exported} assets",
  "完成：修正 ${fixed} 张的拍摄时间": "Done: fixed the capture time of ${fixed} photos",
  "密码不正确": "Incorrect password",
  "密码至少 4 位": "Password must be at least 4 characters",
  "导入 ${path.basename(file)}（已保存 ${result.saved}）": "Imported ${path.basename(file)} (${result.saved} saved)",
  "导入任务正在运行": "An import task is running",
  "导入失败：${err.message}": "Import failed: ${err.message}",
  "导出目录不存在，请重新选择": "Export folder does not exist; choose it again",
  "封面数据为空": "Cover data is empty",
  "封面数据格式不正确": "Cover data has an invalid format",
  "尺寸没有更大": "The size is not larger",
  "局域网投送未开启或没有可用的局域网 IP": "LAN sharing is off or no LAN IP is available",
  "已切换资源库，相似搜索中止": "Library switched, similarity search aborted",
  "已取消": "Canceled",
  "已取消下载": "Download canceled",
  "已取消（修正 ${fixed} 张）": "Canceled (${fixed} photos fixed)",
  "已存在同名智能文件夹": "A smart folder with this name already exists",
  "已存在同名清单": "A list with this name already exists",
  "已扫描 ${processed}/${total}，检出人脸 ${faceTotal} 张": "Scanned ${processed}/${total}, faces found in ${faceTotal} photos",
  "已扫描 ${scanned} 张，修正 ${fixed} 张": "Scanned ${scanned} photos, fixed ${fixed}",
  "已有 Eagle 导出任务在运行": "An Eagle export task is already running",
  "已有增强任务正在进行": "An enhancement task is already in progress",
  "已有批量编辑任务正在进行": "A batch edit task is already in progress",
  "已有采集任务正在运行": "A capture task is already running",
  "已经安装": "Already installed",
  "已补 ${stats.done} 张${stats.failed ? ": "Filled in ${stats.done}${stats.failed ? ",
  "已请求停止，正在收尾当前这一张": "Stop requested; finishing the current photo",
  "市场条目 ${id} 没有可安装的包": "Market entry ${id} has no installable package",
  "市场条目的包名不合法": "Market entry package name is invalid",
  "市场条目的包名越界": "Market entry package name escapes the allowed directory",
  "市场索引格式不正确": "Market index has an invalid format",
  "市场索引缺少 plugins 数组": "Market index is missing the plugins array",
  "市场里没有这个插件：${id}": "Plugin not found in the market: ${id}",
  "库结构迁移失败（v${fromVersion} → v${SCHEMA_VERSION}）：${err?.message || err}": "Library schema migration failed (v${fromVersion} → v${SCHEMA_VERSION}): ${err?.message || err}",
  "开始重建人物分组…": "Rebuilding people groups…",
  "张数与模板不匹配": "Photo count does not match the template",
  "当前库没有任何图片记录，已拒绝清理": "The current library has no image records; cleanup refused",
  "当前系统不支持系统 OCR（仅 Windows 可用）": "System OCR is not supported on this system (Windows only)",
  "微博 Cookie 无效或已过期，请重新获取": "Weibo Cookie is invalid or expired; please get a new one",
  "微博返回异常：${json?.msg || ": "Weibo returned an error: ${json?.msg || ",
  "微博需要登录 Cookie：请到「设置 → 采集」填入微博 Cookie 后再采集": "Weibo requires a login Cookie: go to Settings → Capture, enter your Weibo Cookie, then capture again",
  "快照文件 ${f.name} 校验和不匹配，可能只传了一半，请重新同步": "Checksum mismatch for snapshot file ${f.name}; the transfer may be incomplete, please sync again",
  "快照文件 ${f.name} 还没同步到本机，请等网盘传完再拉取": "Snapshot file ${f.name} has not synced to this machine yet; wait for the cloud drive to finish, then pull again",
  "快照文件缺失（可能已被清理）": "Snapshot file is missing (it may have been cleaned up)",
  "成功：返回 ${info.width}×${info.height}（${Math.round(resultBuf.length / 1024)} KB）": "Success: returned ${info.width}×${info.height} (${Math.round(resultBuf.length / 1024)} KB)",
  "所有模型都已装好": "All models are installed",
  "扫描正在进行，等它结束再重建（扫描本身也在建组）": "A scan is in progress; wait for it to finish before rebuilding (the scan also builds groups)",
  "抓取失败：${err?.message || '网络错误'}": "Fetch failed: ${err?.message || 'network error'}",
  "抓取失败：HTTP ${res.status}": "Fetch failed: HTTP ${res.status}",
  "拉取失败：${err?.message || err}": "Pull failed: ${err?.message || err}",
  "拉取模型失败 · ${friendlyError(res.status, text)}": "Failed to pull model · ${friendlyError(res.status, text)}",
  "拉取模型失败：接口返回不是 JSON（该厂家可能不开放 /models 接口，可直接手填模型名并点「测试连接」）": "Failed to pull model: the response is not JSON (this provider may not expose the /models endpoint; enter the model name manually and click \"Test connection\")",
  "指定的线上服务不存在": "The specified online service does not exist",
  "按文件夹分享需要有效的文件夹 id": "Sharing by folder requires a valid folder id",
  "按选区分享需要至少一张素材": "Sharing by selection requires at least one asset",
  "排序列表不能为空": "Sort list cannot be empty",
  "接口不存在": "Endpoint not found",
  "插件 id 不能为空": "Plugin id cannot be empty",
  "插件 id 只能用小写字母/数字/下划线/连字符（2~41 位）": "Plugin id may only contain lowercase letters, digits, underscores, and hyphens (2-41 characters)",
  "插件「${plugin.name}」已停用，请先在设置里启用": "Plugin \"${plugin.name}\" is disabled; enable it in Settings first",
  "插件不允许访问模块：${s}（${why}）": "Plugin is not allowed to access module: ${s} (${why})",
  "插件不存在": "Plugin not found",
  "插件不存在：${id || '(空)'}": "Plugin not found: ${id || '(empty)'}",
  "插件不存在：${pid}": "Plugin not found: ${pid}",
  "插件不支持动作 ${action}": "Plugin does not support action ${action}",
  "插件入口必须是 .js / .mjs / .cjs": "Plugin entry must be a .js / .mjs / .cjs file",
  "插件入口文件不存在：${manifest.entry}": "Plugin entry file does not exist: ${manifest.entry}",
  "插件入口越出了插件目录": "Plugin entry is outside the plugin directory",
  "插件包不是合法的 JSON（.tuku-plugin）或 ZIP": "Plugin package is not valid JSON (.tuku-plugin) or ZIP",
  "插件包为空": "Plugin package is empty",
  "插件包内容为空": "Plugin package contents are empty",
  "插件包总体积过大": "Plugin package is too large overall",
  "插件包文件数量不合法（${keys.length}）": "Plugin package has an invalid file count (${keys.length})",
  "插件包文件过多（${entries.length}）": "Plugin package has too many files (${entries.length})",
  "插件包缺少 files": "Plugin package is missing files",
  "插件包缺少 plugin.json": "Plugin package is missing plugin.json",
  "插件包过大": "Plugin package is too large",
  "插件包里不允许的文件类型：${rel}": "File type not allowed in plugin package: ${rel}",
  "插件包里包含非法路径：${String(raw).slice(0, 80)}": "Plugin package contains an invalid path: ${String(raw).slice(0, 80)}",
  "插件包里的 ${rel} 过大": "${rel} in the plugin package is too large",
  "插件参数过大": "Plugin arguments are too large",
  "插件执行参数不是合法 JSON": "Plugin execution arguments are not valid JSON",
  "插件执行超时（${DEFAULT_TIMEOUT}ms）": "Plugin execution timed out (${DEFAULT_TIMEOUT}ms)",
  "插件没有导出 default/run 函数": "Plugin does not export a default/run function",
  "插件没有返回结果（退出码 ${code}）${stderr ? ": "Plugin returned no result (exit code ${code})${stderr ? ",
  "插件清单不合法：${err?.message || err}": "Plugin manifest is invalid: ${err?.message || err}",
  "插件结果写库失败：${err?.message || err}": "Failed to write plugin result to the database: ${err?.message || err}",
  "插件缺少 name": "Plugin is missing name",
  "插件输出过大": "Plugin output is too large",
  "插件返回了非法 JSON：${err?.message || err}": "Plugin returned invalid JSON: ${err?.message || err}",
  "操作记录不存在": "Operation record does not exist",
  "操作记录不存在（可能已被清理）": "Operation record does not exist (it may have been cleaned up)",
  "擦除区域超过整图 60%：内容感知扩散无法保证效果，请缩小范围或改用裁切": "Erase area exceeds 60% of the image: content-aware fill cannot guarantee a good result; reduce the area or use crop instead",
  "文件不存在": "File does not exist",
  "文件不完整（${p.size} 字节，预期约 ${item.sizeHint}）": "File is incomplete (${p.size} bytes, expected about ${item.sizeHint})",
  "文件不完整（仅 ${size} 字节）": "File is incomplete (only ${size} bytes)",
  "文件为空": "File is empty",
  "文件夹不存在": "Folder does not exist",
  "文件夹不能为空": "Folder cannot be empty",
  "文件夹名称不能为空": "Folder name cannot be empty",
  "文件超出预期大小": "File is larger than expected",
  "文件超过大小上限": "File exceeds the size limit",
  "文件超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）": "File exceeds the size limit (${Math.round(maxBytes / 1024 / 1024)}MB)",
  "新分组名不能为空": "New group name cannot be empty",
  "无效的颜色值，请用 #rrggbb": "Invalid color value; use #rrggbb",
  "无法启动 AI 程序：${e.message}": "Cannot start AI program: ${e.message}",
  "无法启动插件进程：${err?.message || err}": "Cannot start plugin process: ${err?.message || err}",
  "无法识别新文件的尺寸": "Cannot determine the dimensions of the new file",
  "无法读取图片": "Cannot read image",
  "无法读取图片像素": "Cannot read image pixels",
  "无法读取图片尺寸": "Cannot read image dimensions",
  "无法读取这张图的尺寸（文件可能损坏）": "Cannot read the dimensions of this image (the file may be corrupted)",
  "无法调用 PowerShell：${e.message}": "Cannot invoke PowerShell: ${e.message}",
  "旧库备份失败：${err.message}": "Failed to back up the old library: ${err.message}",
  "智能文件夹不存在": "Smart folder does not exist",
  "智能文件夹名称不能为空": "Smart folder name cannot be empty",
  "智能文件夹至少要有一个筛选条件（不设条件的文件夹会命中整库，没有意义）": "A smart folder needs at least one filter condition (without conditions it matches the whole library, which is pointless)",
  "服务未返回 JSON：${text.slice(0, 240)}": "Service did not return JSON: ${text.slice(0, 240)}",
  "服务返回内容为空": "Service returned an empty response",
  "未找到结果地址（可在服务配置里指定字段路径）：${text.slice(0, 240)}": "Result address not found (you can specify the field path in the service settings): ${text.slice(0, 240)}",
  "未指定 Transformer 超分模型": "No Transformer upscale model specified",
  "未授权：缺少或无效的 API 令牌": "Unauthorized: missing or invalid API token",
  "未知任务类型": "Unknown task type",
  "未知权限 ${p}": "Unknown permission ${p}",
  "未知模板": "Unknown template",
  "未知的使用统计类型：${kind}": "Unknown usage stats type: ${kind}",
  "未知的搜图引擎": "Unknown image search engine",
  "未知的搜图渠道": "Unknown image search channel",
  "未知的模型": "Unknown model",
  "未知的模型档位": "Unknown model tier",
  "未知的步骤类型：${type || '(空)'}": "Unknown step type: ${type || '(empty)'}",
  "未知的编辑类型": "Unknown edit type",
  "未知的超分模型": "Unknown upscale model",
  "未能识别桌面环境，已尝试：${failures.join('；')}。请手动设置壁纸或安装 feh": "Could not detect the desktop environment; tried: ${failures.join('; ')}. Please set the wallpaper manually or install feh",
  "未选中图片": "No image selected",
  "未选择受支持的音频文件": "No supported audio file selected",
  "未配置 AI，无法执行 AI 步骤": "AI is not configured; cannot run AI steps",
  "未配置上传地址": "Upload address is not configured",
  "本地文件不存在": "Local file does not exist",
  "本地文件不存在（可能已被移动或删除）": "Local file does not exist (it may have been moved or deleted)",
  "本地文件不存在，可能被移动或删除了": "Local file does not exist; it may have been moved or deleted",
  "查询向量维度 ${q.length} 与索引 ${dim} 不一致": "Query vector dimension ${q.length} does not match the index dimension ${dim}",
  "查询文本不能为空": "Query text cannot be empty",
  "标签不能为空": "Tag cannot be empty",
  "标签不能作为自己的父标签": "A tag cannot be its own parent tag",
  "标签名不能为空": "Tag name cannot be empty",
  "样本不足（需要同时有「喜欢」和「不喜欢/删除」信号，至少 8 条）": "Not enough samples (both \"like\" and \"dislike/delete\" signals are needed, at least 8 in total)",
  "检测模型校验未通过（${det.reason || '哈希不匹配'}），请重试安装": "Detection model verification failed (${det.reason || 'hash mismatch'}); please reinstall",
  "检测点重合，无法估计对齐变换": "Detected points coincide; cannot estimate the alignment transform",
  "模型下载失败：${lastErr?.message || '镜像与官方源都不可达'}": "Model download failed: ${lastErr?.message || 'neither the mirror nor the official source is reachable'}",
  "模型文件校验未通过（${check.reason || '哈希不匹配'}），请重试安装": "Model file verification failed (${check.reason || 'hash mismatch'}); please reinstall",
  "模型输出无法识别为遮罩": "Model output is not a recognizable mask",
  "模板不能为空": "Template cannot be empty",
  "正在下载 ${m.name}（${done + 1}/${queue.length}）": "Downloading ${m.name} (${done + 1}/${queue.length})",
  "正在下载/安装，请稍后再试": "Downloading or installing; please try again later",
  "正在下载中，请稍候": "Downloading, please wait",
  "正在下载，请稍后再试": "Downloading; please try again later",
  "比例格式不对，示例：2:3": "Invalid ratio format; example: 2:3",
  "没找到扩展目录": "Extension directory not found",
  "没找到扩展目录（开发时应在仓库 extension/ 下）": "Extension directory not found (in development it should be under extension/ in the repo)",
  "没有原始文件路径": "No original file path",
  "没有可上传的图片数据": "No image data to upload",
  "没有可下载的图片": "No images to download",
  "没有可撤销的操作": "Nothing to undo",
  "没有可用的内嵌预览": "No embedded preview available",
  "没有可用的局域网 IP": "No LAN IP available",
  "没有可用的缩略图": "No thumbnail available",
  "没有可用素材": "No assets available",
  "没有在跑的夜间任务": "No nightly task is running",
  "没有找到更大的版本": "No larger version found",
  "没有标签内容": "No tag content",
  "没有要修改的字段": "No fields to update",
  "没有这一章": "No such chapter",
  "没有这个功能": "This feature is not available",
  "没有选中的图片": "No images selected",
  "没有选择任何素材": "No assets selected",
  "没有需要增强的图片": "No images to enhance",
  "没有需要补算的图片": "No images to recompute",
  "清单不存在": "List not found",
  "清单名称不能为空": "List name cannot be empty",
  "清单里找不到这一项": "This item is not in the list",
  "父文件夹不存在": "Parent folder not found",
  "版本文件不存在": "Version file not found",
  "特征模型校验未通过（${rec.reason || '哈希不匹配'}），请重试安装": "Feature model verification failed (${rec.reason || 'hash mismatch'}); please retry the installation",
  "生成快照失败：${err?.message || err}": "Failed to create snapshot: ${err?.message || err}",
  "用户停止采集": "Collection stopped by the user",
  "用户取消下载": "Download cancelled by the user",
  "目录名必须与插件 id 一致": "The folder name must match the plugin id",
  "目标 ${w}×${h}（约 ${(px / 1e6).toFixed(1)} 百万像素）超出单张处理上限 ": "Target ${w}×${h} (about ${(px / 1e6).toFixed(1)} megapixels) exceeds the per-image processing limit ",
  "目标人物不存在": "Target person not found",
  "目标堆叠不存在": "Target stack not found",
  "目标已存在且不为空：${target}\\n换个空文件夹，或先删掉它": "Target already exists and is not empty: ${target}\\nUse an empty folder, or delete it first",
  "目标标签不能为空": "Target tag cannot be empty",
  "相似变换至少需要 3 个点": "Similarity transform needs at least 3 points",
  "章节序号不对": "Invalid chapter number",
  "笔记不存在": "Note not found",
  "笔记内容不能为空": "Note content cannot be empty",
  "筛选器不存在": "Filter not found",
  "筛选器名称不能为空": "Filter name cannot be empty",
  "筛选条件太大，无法保存": "Filter criteria are too large to save",
  "系统 OCR 仅 Windows 可用": "System OCR is only available on Windows",
  "系统 OCR 仅 Windows 可用（当前系统没有离线识别引擎）": "System OCR is only available on Windows (this system has no offline recognition engine)",
  "系统代理下载为空": "System proxy download returned nothing",
  "系统代理下载失败（退出码 ${code}，${size} 字节）${err.slice(0, 200)}": "System proxy download failed (exit code ${code}, ${size} bytes) ${err.slice(0, 200)}",
  "素材 id 无效": "Invalid asset id",
  "素材不存在": "Asset not found",
  "素材不存在或已被删除": "Asset not found or already deleted",
  "线上服务不存在": "Online service not found",
  "缩略图读取失败": "Failed to read thumbnail",
  "缺少 hex 参数（如 #aabbcc）": "Missing hex parameter (e.g. #aabbcc)",
  "缺少 image（base64 data url）": "Missing image (base64 data URL)",
  "缺少 query 参数": "Missing query parameter",
  "缺少 url": "Missing URL",
  "缺少图片 id": "Missing image id",
  "缺少插件执行参数": "Missing plugin execution parameters",
  "缺少搜索词 q": "Missing search term q",
  "缺少文件名": "Missing file name",
  "缺少文件名或文件内容为空": "Missing file name, or the file content is empty",
  "缺少模型 id": "Missing model id",
  "缺少组标识": "Missing group identifier",
  "缺少要保留的图片": "Missing the image to keep",
  "缺少要保留的图片 id": "Missing the id of the image to keep",
  "缺少路径": "Missing path",
  "脚本步骤缺少合法的插件 id": "Script step is missing a valid plugin id",
  "自检未生成输出文件": "Self-check did not produce an output file",
  "自由裁切需要先框选区域": "Free crop requires selecting an area first",
  "至少要选一个搜图引擎": "Select at least one image search engine",
  "至少选择两张素材才能堆叠": "Select at least two assets to stack",
  "至少需要一个裁切框": "At least one crop box is required",
  "蒙版不是合法的 PNG：请重新涂出要擦除的区域": "The mask is not a valid PNG: please paint the area to erase again",
  "蒙版是空的：请先用画笔涂出要擦除的区域": "The mask is empty: use the brush to paint the area to erase first",
  "补算正在进行中": "Recompute already in progress",
  "裁切区域无效": "Invalid crop area",
  "要保留的图片不存在（可能已被删除）": "The image to keep does not exist (it may have been deleted)",
  "要合并的堆叠不存在": "The stack to merge does not exist",
  "视频文件不存在": "Video file not found",
  "解压失败：${err.message}": "Extraction failed: ${err.message}",
  "解压安装无法中途取消，请等这一步结束": "Extraction and installation cannot be cancelled midway; please wait for this step to finish",
  "设置壁纸失败：${err.message}": "Failed to set wallpaper: ${err.message}",
  "访问密码需为 4~64 个字符": "Access password must be 4 to 64 characters",
  "评分需为 0~5 的整数": "Rating must be an integer from 0 to 5",
  "评论不存在": "Comment not found",
  "评论不能为空": "Comment cannot be empty",
  "该令牌只有只读权限，不能调用写接口": "This token is read-only and cannot call write endpoints",
  "该任务还在运行": "This task is still running",
  "该域名解析到本机或内网地址，已拒绝访问": "This domain resolves to a local or private address, so access was denied",
  "该文件夹下已存在同名文件": "A file with the same name already exists in this folder",
  "该文件夹已加锁，请先输入密码": "This folder is locked; enter the password first",
  "该格式暂不支持": "This format is not supported yet",
  "该格式暂不支持或内容重复": "This format is not supported yet, or the content is a duplicate",
  "该模型正在下载，请先取消": "This model is downloading; cancel it first",
  "该模型正在加载/下载，请稍后再试": "This model is loading or downloading; please try again later",
  "该素材不在此分享链接范围内": "This asset is not included in this share link",
  "该范围内没有可用图片，请到「设置 → 壁纸」切换挑选范围，或先往图库里添加图片": "No images are available in this range. Go to \"Settings → Wallpaper\" to change the selection range, or add images to the library first",
  "语义索引 ${s.done}/${s.total}": "Semantic index ${s.done}/${s.total}",
  "语义补算已经在跑": "Semantic recompute is already running",
  "请先填写 Base URL": "Please fill in the Base URL first",
  "请先安装 AI 超分运行库": "Please install the AI upscaling runtime first",
  "请先等「清理模糊人脸」结束": "Please wait for \"Clean up blurry faces\" to finish first",
  "请先设置素材文件夹": "Please set the asset folder first",
  "请先选择一个水印样式或相框样式": "Please select a watermark style or frame style first",
  "请先选择保存位置": "Please choose a save location first",
  "请先选择备份位置": "Please choose a backup location first",
  "请填写市场索引地址": "Please enter the marketplace index URL",
  "请提供插件 id 或插件包地址": "Please provide a plugin id or plugin package URL",
  "请求体不是合法 JSON": "The request body is not valid JSON",
  "请求体超过上限（${Math.round(cap / 1024 / 1024)}MB）": "The request body exceeds the limit (${Math.round(cap / 1024 / 1024)}MB)",
  "请求体过大（上限 50MB）": "The request body is too large (limit 50MB)",
  "请求已取消": "Request cancelled",
  "请至少填写一个文件夹名称": "Please enter at least one folder name",
  "请至少填写一个标签名": "Please enter at least one tag name",
  "请至少选择一个关键词": "Please select at least one keyword",
  "请至少选择一个采集源": "Please select at least one collection source",
  "请输入网页地址": "Please enter a web page URL",
  "请选择${label}": "Please select ${label}",
  "请选择另一个堆叠合并": "Please select another stack to merge",
  "请选择素材文件夹": "Please select an asset folder",
  "读不到数据库路径：${err?.message || err}": "Cannot read the database path: ${err?.message || err}",
  "读取失败：${m}": "Read failed: ${m}",
  "读取失败：文件「${name}」已不存在（可能被移动或删除）。": "Read failed: the file \"${name}\" no longer exists (it may have been moved or deleted).",
  "读取失败：无法打开「${name}」——文件正被其他程序占用，或文件已损坏 / 不是有效图片。${OCCUPIED_HINT}": "Read failed: cannot open \"${name}\" — the file is in use by another program, or it is damaged / not a valid image. ${OCCUPIED_HINT}",
  "读取文件夹失败：${err.message}": "Failed to read folder: ${err.message}",
  "调用过于频繁，请稍后再试（每分钟 120 次）": "Too many requests; please try again later (120 per minute)",
  "调色参数过大": "Color adjustment values are too large",
  "豆瓣拒绝了本次请求（${err?.message || err}）：站点可能要求登录或触发反爬，请稍后重试": "Douban rejected this request (${err?.message || err}): the site may require login or triggered anti-scraping; please try again later",
  "豆瓣触发了安全验证：请先在浏览器访问一次豆瓣，稍后再试": "Douban triggered a security check: please visit Douban once in your browser, then try again later",
  "贴吧搜索失败（${err?.message || err}）：站点可能要求登录或触发反爬，请稍后重试": "Tieba search failed (${err?.message || err}): the site may require login or triggered anti-scraping; please try again later",
  "资源库不存在": "Library not found",
  "资源库名称不能为空": "Library name cannot be empty",
  "超分模型按需加载，无需预下载": "Upscaling models load on demand, so no pre-download is needed",
  "超过大小上限 ${Math.round(maxBytes / 1024 / 1024)}MB": "Exceeds the size limit of ${Math.round(maxBytes / 1024 / 1024)}MB",
  "路径为空": "Path is empty",
  "运行库未安装": "Runtime not installed",
  "返回内容不是可识别的图片（${resultBuf.length} 字节）": "The response is not a recognizable image (${resultBuf.length} bytes)",
  "还有${KIND_TITLE[job.kind] || ''}任务在跑，等它结束再重试": "A ${KIND_TITLE[job.kind] || ''} task is still running; wait for it to finish and try again",
  "还没下载": "Not downloaded yet",
  "还没有切换过壁纸": "Wallpaper has not been changed yet",
  "还没有反馈记录，先删除几张不满意的图片吧": "No feedback yet; delete a few images you are not happy with first",
  "还没有设置同步文件夹": "No sync folder has been set yet",
  "还没有识别过": "Nothing has been recognized yet",
  "这一项无法取消": "This item cannot be cancelled",
  "这一项没有下载入口": "This item has no download option",
  "这一项没有删除入口": "This item has no delete option",
  "这不是图库同步文件夹（找不到 tuku.sync 清单）": "This is not a library sync folder (no tuku.sync manifest found)",
  "这个人还没有可用的人脸照片": "This person has no usable face photos yet",
  "这个分享链接不允许下载原图": "This share link does not allow downloading original images",
  "这个地址返回的不是网页（${ctype || '未知类型'}）": "This address did not return a web page (${ctype || 'unknown type'})",
  "这个备份来自更新的版本（格式 ${schema}），请先升级应用再恢复": "This backup comes from a newer version (format ${schema}); please upgrade the app before restoring",
  "这个引擎还没有实现": "This engine is not implemented yet",
  "这个文件夹里没有 gallery.db，不像是图库备份": "There is no gallery.db in this folder, so it does not look like a library backup",
  "这个格式（${ext || '未知'}）不是位图，无法做文字识别": "This format (${ext || 'unknown'}) is not a bitmap, so text recognition cannot be done",
  "这个版本不存在（可能已被撤销清理）": "This version does not exist (it may have been removed by a cleanup)",
  "这个目录下没有 images/，不是 Eagle 资源库（.library）": "There is no images/ folder here, so this is not an Eagle library (.library)",
  "这个资源库已加锁：先输入密码解锁": "This library is locked: enter the password to unlock it",
  "这些素材都无法解码成图片（视频/3D/字体不能拼接）": "None of these assets can be decoded into images (videos, 3D models and fonts cannot be stitched)",
  "这张图没有记录原始来源地址（本地导入的图无法自动换大图）": "No original source URL is recorded for this image (locally imported images cannot be upgraded to a larger version automatically)",
  "这张照片里没有这个人的人脸记录": "This photo has no face record for this person",
  "这张素材不在该堆叠里": "This asset is not in that stack",
  "这张素材没有原文件": "This asset has no original file",
  "这是动图：静态壁纸只会显示第一帧。请改用动态壁纸模式（/live 轮播会播放原动图）": "This is an animated image: a static wallpaper only shows the first frame. Switch to live wallpaper mode instead (/live slideshow plays the original animation)",
  "这是虚拟文件夹，没有对应的磁盘目录": "This is a virtual folder with no matching directory on disk",
  "这条素材不是网页书签": "This asset is not a web bookmark",
  "这次导入没有记录可撤销的边界": "This import did not record an undo boundary",
  "这次操作已经撤销过了": "This action has already been undone",
  "这种编辑不支持非破坏记录": "This kind of edit does not support non-destructive history",
  "选中的素材都不存在": "None of the selected assets exist",
  "重定向次数过多，已中止": "Too many redirects; aborted",
  "链接已失效或令牌无效": "The link has expired or the token is invalid",
  "需要 base64 图片（data:image/...;base64,...）": "A base64 image is required (data:image/...;base64,...)",
  "需要 dataUrl 或 http(s) url": "A dataUrl or http(s) URL is required",
  "需要 fromId 与 toId": "fromId and toId are required",
  "需要 imageId": "imageId is required",
  "需要人物与照片": "A person and a photo are required",
  "需要访问密码": "Access password required",
  "非破坏编辑最多累积 ${MAX_OPS} 步，请先「应用到底片」": "Non-destructive edits can accumulate up to ${MAX_OPS} steps; please use \"Apply to negatives\" first",
  "音频文件不存在": "Audio file not found",
  "预览生成失败": "Failed to generate preview",
  "预览读取失败": "Failed to read preview",
  "默认资源库不可删除": "The default library cannot be deleted",
  "处理文件": "Process file",
  "写入文件": "Write file",
  "覆盖原图": "Overwrite original",
  "未知错误": "Unknown error",
  "请关闭正在打开这张图的程序（看图软件 / PS / 资源管理器的预览窗格），或临时关闭杀毒软件实时防护后重试。": "Close any program that has this image open (image viewer / Photoshop / Explorer preview pane), or temporarily disable real-time antivirus protection, then try again.",
  "CLIP 语义模型": "CLIP semantic model",
  "导出 Eagle 库": "Export Eagle library",
  "清理模糊人脸并重选封面": "Clean blurry faces and reselect covers",
  "重建人物分组": "Rebuild people groups",
  "人脸扫描与聚类": "Face scan and clustering",
  "人脸模型（SCRFD + ArcFace）": "Face models (SCRFD + ArcFace)",
  "图库 TuKu 开放 API": "TuKu Open API",
  "重建拍摄时间": "Rebuild capture time",
  "下载全部模型": "Download all models",
  "重建缺失缩略图": "Rebuild missing thumbnails",
  "${state.label} ${ids.length} 张": "${state.label} · ${ids.length} photos",
  "画质增强 ${ids.length} 张（${model}）": "Enhance ${ids.length} photos (${model})",
  "采集 ${keywords.length} 词 × ${sources.length} 源 × ${pages} 页": "Crawl ${keywords.length} keywords × ${sources.length} sources × ${pages} pages",
  "去背景模型（${p.label}）": "Background removal model (${p.label})",
  "开放 API（v1）": "Open API (v1)",
  "给脚本 / 插件 / 外部程序的稳定接口，需要 Bearer 令牌与对应 scope（见 /api/v1/openapi.json）": "Stable API for scripts, plugins and external apps; requires a Bearer token with matching scope (see /api/v1/openapi.json)",
  "图片与检索": "Images & Search",
  "列表分页、单张详情、相似 / 重复查找、堆叠与缩略图": "List pagination, single-image details, similar / duplicate search, stacks and thumbnails",
  "资源库与导入": "Libraries & Import",
  "多资源库切换、扫描导入、采集、SSE 事件流与系统能力": "Multi-library switching, scan import, crawling, SSE event stream and system capabilities",
  "整理与分类": "Organize & Classify",
  "文件夹、标签、关键词、智能文件夹、筛选、清单与知识库": "Folders, tags, keywords, smart folders, filters, playlists and knowledge base",
  "编辑与标注": "Edit & Annotate",
  "非破坏编辑、标注、批注、水印、增强、撤销栈": "Non-destructive editing, annotations, comments, watermarks, enhancement and undo stack",
  "AI 与识别": "AI & Recognition",
  "模型管理、向量索引、人脸与人物、以图搜图、本地推理任务": "Model management, vector index, faces and people, reverse image search and local inference jobs",
  "壁纸": "Wallpaper",
  "壁纸盘点评分、桌面设置、隐私相关的本地开关": "Wallpaper rating, desktop settings and privacy-related local switches",
  "数据与维护": "Data & Maintenance",
  "导出、备份还原、一致性对账、回收站、后台任务与统计": "Export, backup restore, consistency checks, trash, background jobs and stats",
  "扩展与集成": "Extensions & Integrations",
  "浏览器扩展、插件、局域网共享、同步、右键动作、时间线": "Browser extension, plugins, LAN sharing, sync, context actions and timeline",
  "其它": "Other",
  "Bearer 令牌 + scope": "Bearer token + scope",
  "局域网令牌": "LAN token",
  "本机令牌": "Local token",
  "无": "None",
  "按这个接口的实际字段填": "Fill in the actual fields for this endpoint",
  "数据目录下 .api-token": ".api-token in the data directory",
  "# 图库 HTTP API 参考": "# TuKu HTTP API Reference",
  "> 本文档由服务端根据**实际注册的路由**生成，不是手写的，因此不会与代码漂移。": "> Generated by the server from the **actually registered routes** — not hand-written, so it never drifts from the code.",
  "> 版本：${meta.version}": "> Version: ${meta.version}",
  "> 本机地址：${meta.baseUrl}": "> Base URL: ${meta.baseUrl}",
  "> 接口总数：${routes.length}": "> Total endpoints: ${routes.length}",
  "## 鉴权": "## Authentication",
  "- 本机接口（`/api/*`）：请求头 `Authorization: Bearer <token>`，令牌见数据目录下的 `.api-token`。": "- Local endpoints (`/api/*`): send `Authorization: Bearer <token>`; the token is in `.api-token` in the data directory.",
  "# 首次调用前把令牌读进环境变量（bash / zsh；PowerShell 用 $env:TUKU_TOKEN = Get-Content .api-token）": "# Load the token into an env var before the first call (bash / zsh; PowerShell: $env:TUKU_TOKEN = Get-Content .api-token)",
  "- 局域网接口（`/api/lan/*`）：分享链接里的局域网令牌，`?token=` 只允许 `GET`。": "- LAN endpoints (`/api/lan/*`): the LAN token from the share link; `?token=` is only allowed on `GET`.",
  "- 开放 API（`/api/v1/*`）：Bearer 令牌 + scope，完整 schema 见 `GET /api/v1/openapi.json`。": "- Open API (`/api/v1/*`): Bearer token + scope; full schema at `GET /api/v1/openapi.json`.",
  "## 通用约定": "## Conventions",
  "- 响应均为 JSON；失败时形如 `{ \"error\": \"人能看懂的说明\" }`，HTTP 状态码有意义。": "- All responses are JSON; failures look like `{ \"error\": \"human-readable message\" }` and HTTP status codes are meaningful.",
  "- 分页参数：`?offset=&limit=`（部分接口为 `?page=`），返回里带 `total`。": "- Pagination: `?offset=&limit=` (some endpoints use `?page=`); responses include `total`.",
  "- 路径参数用 `:name` 表示，实际请求换成具体 id。": "- Path parameters are written as `:name`; replace with a real id in actual requests.",
  "| 方法 | 路径 | 鉴权 |": "| Method | Path | Auth |",
  "### 调用示例": "### Examples",
  "> 令牌在数据目录的 `.api-token` 里（桌面版由界面自动带上，脚本里自己读一次塞进 `Authorization`）。": "> The token lives in `.api-token` in the data directory (the desktop app adds it automatically; scripts should read it once and put it in `Authorization`).",
  "> 路径里的 `:id` 这类参数在示例中已换成 `1`，实际请求时替换成真实 id；请求体字段请对照该接口的实现或界面上的操作。": "> Path parameters like `:id` are replaced with `1` in examples; use a real id in actual requests. For request-body fields, refer to the endpoint implementation or the corresponding UI action.",
  "## ${g.label}（${list.length}）": "## ${g.label} (${list.length})",
  "_${g.note}_": "_${g.note}_",
  "示例：按前缀打标": "Example: tag by prefix",
  "内置示例插件：给素材追加一个自定义标签和按宽度生成的标签。可复制整个目录到用户插件目录，改 index.js 写自己的逻辑。": "Built-in sample plugin: adds a custom tag and a width-based tag to each image. Copy the folder into your user plugin directory and edit index.js to write your own logic.",
  "备注补日期前缀": "Prepend date to notes",
  "官方插件：给备注补上 YYYY-MM-DD 前缀，已有日期就跳过；备注为空时按 arg 里的日期兜底写入。适合批量整理灵感笔记。": "Official plugin: prepends a YYYY-MM-DD date to notes, skipping notes that already have one; if a note is empty, writes the date from arg. Useful for batch-organizing idea notes.",
  "按画幅与分辨率打标": "Tag by aspect ratio and resolution",
  "官方插件：按宽高比追加「横图 / 竖图 / 方图」，按长边追加「1K / 2K / 4K」档位标签。只追加，不覆盖已有标签；重复运行不会产生重复标签。": "Official plugin: adds Landscape / Portrait / Square tags by aspect ratio and 1K / 2K / 4K tags by long edge. Only appends, never overwrites existing tags, and never duplicates tags on repeat runs.",
  "按媒体类型打标": "Tag by media type",
  "官方插件：给素材追加「图片 / 视频 / 音频」标签，方便用 tag:视频 这类前缀搜索把混放素材分开。只追加，可重复运行。": "Official plugin: adds Image / Video / Audio tags so mixed libraries can be filtered with prefix searches like tag:video. Only appends; safe to run repeatedly.",
  "标签推评分": "Rating from tags",
  "按素材标签里是否含「精选 / 收藏 / 重点」推算星级，用于给历史素材批量补评分。会写库，安装前请看权限声明。": "Infers star ratings from whether tags contain \"Featured / Favorite / Key\", useful for backfilling ratings on older images. It writes to the library — review the permissions before installing.",
  "标题前缀清理": "Title prefix cleanup",
  "试算并展示去掉 IMG_ / DSC_ / 微信图片_ 之类相机前缀后的标题，只读不写库，适合先看清效果。": "Previews titles with camera prefixes like IMG_ / DSC_ / WeChat image prefixes removed. Read-only, so you can check the effect first.",
  "图库官方": "TuKu official",
  "整理": "Organize",
  "评分": "Rating",
  "命名": "Naming",
  "只读": "Read-only",
  "素材没有宽高信息，跳过": "Image has no width/height info; skipped",
  "缺少宽高，未打标": "Missing width/height; not tagged",
  "标题前缀清理：${title} -> ${cleaned}": "Title prefix cleanup: ${title} -> ${cleaned}",
  "处理素材 ${image.id || '(未指定)'}：${image.title || '无标题'}": "Processing image ${image.id || '(未指定)'}: ${image.title || '无标题'}",
  "素材 ${image?.id || '(未指定)'} 类型 ${kind} → ${tag}": "Image ${image?.id || '(未指定)'} type ${kind} → ${tag}",
  "画幅 ${w}×${h} → ${tags.join(' / ')}": "Aspect ${w}×${h} → ${tags.join(' / ')}",
  "备注已有日期前缀，跳过": "Note already has a date prefix; skipped",
  "已带日期，未改动": "Already dated; unchanged",
  "备注补日期 ${date}": "Note date prepended: ${date}",
  "(未指定)": "(unspecified)",
  "无标题": "Untitled",
  "前缀=${prefix}": "prefix=${prefix}"
};

/**
 * 把带 `${...}` 占位符的模板拆成「静态片段 / 占位符」序列。
 * @param {string} text
 * @returns {{ lit?: string, ph?: string }[]}
 */
function splitPlaceholders(text) {
  /** @type {{ lit?: string, ph?: string }[]} */
  const parts = [];
  let lit = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '{') {
      if (lit) {
        parts.push({ lit });
        lit = '';
      }
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      parts.push({ ph: text.slice(i + 2, j - 1) });
      i = j;
      continue;
    }
    lit += text[i];
    i++;
  }
  if (lit) parts.push({ lit });
  return parts;
}

/** 正则元字符转义 @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @typedef {{ re: RegExp, parts: ({ lit?: string, idx?: number })[], order: number }} Pattern
 * @type {Pattern[]}
 */
const PATTERNS = [];
{
  let order = 0;
  for (const [zh, en] of Object.entries(EN)) {
    if (!zh.includes('$' + '{')) continue;
    const zhParts = splitPlaceholders(zh);
    const enParts = splitPlaceholders(en);
    const zhPh = zhParts.filter((p) => p.ph !== undefined).length;
    const enPh = enParts.filter((p) => p.ph !== undefined).length;
    if (!zhPh || zhPh !== enPh) continue; // 占位符对不上就不做模板匹配，宁可留中文
    let src = '^';
    for (const p of zhParts) src += p.ph !== undefined ? '(.+?)' : escapeRe(p.lit ?? '');
    src += '$';
    let idx = 1;
    const parts = enParts.map((p) => (p.ph !== undefined ? { idx: idx++ } : { lit: p.lit }));
    PATTERNS.push({ re: new RegExp(src), parts, order: order++ });
  }
  // 静态片段更长的先匹配，减少「短模板抢走长模板」的误判
  PATTERNS.sort((a, b) => b.re.source.length - a.re.source.length || a.order - b.order);
}

/** @type {'zh-CN' | 'en-US'} */
let current = 'zh-CN';

/**
 * 按 Accept-Language 判断界面语言：只要首选语言是英文就用英文，其余保持中文。
 * @param {string | undefined} value
 * @returns {'zh-CN' | 'en-US'}
 */
export function setLocaleFromHeader(value) {
  const raw = String(value || '').toLowerCase();
  current = /(^|[\s,;])en\b/.test(raw) || raw.startsWith('en') ? 'en-US' : 'zh-CN';
  return current;
}

/** @returns {'zh-CN' | 'en-US'} */
export function getLocale() {
  return current;
}

/**
 * 翻译一条完整文案：先精确命中，再按模板匹配。
 * 模板里的变量也会再翻一层（如「删除」这种动作名、或内嵌的 err.message 中文）。
 * @param {string} text
 * @param {number} [depth]
 * @returns {string}
 */
export function translate(text, depth = 0) {
  if (current !== 'en-US' || typeof text !== 'string') return text;
  const hit = EN[text];
  if (typeof hit === 'string') return hit;
  if (depth > 2) return text;
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    let out = '';
    for (const part of p.parts) {
      if (part.idx !== undefined) out += translate(m[part.idx], depth + 1);
      else out += part.lit ?? '';
    }
    return out;
  }
  return text;
}

/** 需要翻译的响应字段 */
const FIELDS = new Set(['error', 'msg', 'message', 'warning', 'hint', 'detail']);

/**
 * 翻译 JSON 响应体里的文案字段；数组会逐项处理（批量操作常见 ok/error 列表）。
 * @param {any} body
 * @param {number} [depth]
 * @returns {any}
 */
export function translateBody(body, depth = 0) {
  if (current !== 'en-US' || depth > 2 || !body || typeof body !== 'object') return body;
  if (Array.isArray(body)) return body.map((item) => translateBody(item, depth + 1));
  /** @type {Record<string, any>} */
  const out = {};
  let changed = false;
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' && FIELDS.has(key)) {
      const tr = translate(value);
      if (tr !== value) {
        out[key] = tr;
        changed = true;
        continue;
      }
    }
    out[key] = value;
  }
  return changed ? out : body;
}

/**
 * Express 中间件：记录本次请求的语言，并让 res.json 出口自动翻译文案字段。
 * 必须在注册路由之前挂载。
 * @param {any} req
 * @param {any} res
 * @param {() => void} next
 */
export function localeMiddleware(req, res, next) {
  setLocaleFromHeader(req.headers && req.headers['accept-language']);
  const json = res.json.bind(res);
  res.json = (/** @type {any} */ body) => json(translateBody(body));
  next();
}
