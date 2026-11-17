/**
 * 官方插件：按画幅与分辨率打标（ESM）。
 *
 * 入参：{ image, args, permissions, action, log }
 * 返回：{ logs?: string[], patch?: { tags?, note?, rating?, favorite? }, result?: unknown }
 *
 * 边界：宿主只允许「追加标签 / 覆盖备注 / 改评分 / 改收藏」，这里只追加标签，
 * 且同一素材重复运行不会产生重复项（宿主用 Set 合并）。
 */
export default async function run({ image, log }) {
  const w = Number(image?.width) || 0;
  const h = Number(image?.height) || 0;
  if (!w || !h) {
    log('素材没有宽高信息，跳过');
    return { logs: ['缺少宽高，未打标'], result: { tagged: [] } };
  }

  const tags = [];
  if (h > w * 1.15) tags.push('竖图');
  else if (w > h * 1.15) tags.push('横图');
  else tags.push('方图');

  const longEdge = Math.max(w, h);
  if (longEdge >= 3840) tags.push('4K');
  else if (longEdge >= 2560) tags.push('2K');
  else if (longEdge >= 1920) tags.push('1080P');
  else if (longEdge >= 1280) tags.push('720P');

  log(`画幅 ${w}×${h} → ${tags.join(' / ')}`);
  return {
    logs: [`${w}×${h}`, tags.join(',')],
    patch: { tags },
    result: { tagged: tags },
  };
}
