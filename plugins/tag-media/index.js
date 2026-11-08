/**
 * 官方插件：按媒体类型打标（ESM）。
 *
 * 素材快照里的 mediaKind 只可能是 image / video / audio（其它类型一律按 image 处理），
 * 打标后可以用 `tag:视频` 把视频从图库里单独筛出来。
 */
const LABEL = {
  video: '视频',
  audio: '音频',
  image: '图片',
};

export default async function run({ image, log }) {
  const kind = String(image?.mediaKind || 'image');
  const tag = LABEL[kind] || LABEL.image;
  log(`素材 ${image?.id || '(未指定)'} 类型 ${kind} → ${tag}`);
  return {
    logs: [`mediaKind=${kind}`],
    patch: { tags: [tag] },
    result: { kind, tag },
  };
}
