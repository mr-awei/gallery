/**
 * 插件示例（ESM）。
 *
 * 入参：{ image, args, permissions, action, log }
 * 返回：{ logs?: string[], patch?: { tags?, note?, rating?, favorite? }, result?: unknown }
 *
 * 这个进程拿不到数据库、拿不到设置、也拿不到素材文件路径；只有 image 这份普通快照。
 * patch 是否写回、写哪些字段由父进程按 plugin.json 的 permissions 决定。
 */
export default async function run({ image, args, log }) {
  const prefix = String(args?.prefix || '脚本标记').trim().slice(0, 30);
  const widthTag = image.width ? `宽${image.width}` : '';
  log(`处理素材 ${image.id || '(未指定)'}：${image.title || '无标题'}`);
  return {
    logs: [`前缀=${prefix}`],
    patch: { tags: [prefix, widthTag].filter(Boolean) },
    result: { widthTag },
  };
}
