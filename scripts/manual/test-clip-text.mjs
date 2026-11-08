/**
 * 手动验证：CLIP 文本塔能否在本地加载并出 512 维向量。
 * 自然语言搜图依赖它；跑不通就说明只能退回「关键词 + LLM 抽词」。
 * 用法：node scripts/manual/test-clip-text.mjs
 */
import { env, AutoTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers';
import { MODEL_CACHE_DIR } from '../../server/config.js';

env.cacheDir = MODEL_CACHE_DIR;
env.allowLocalModels = false;
env.remoteHost = process.env.CLIP_HUB_HOST || 'https://hf-mirror.com';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const t0 = Date.now();
const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
const model = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'q8' });
console.log('加载耗时', Date.now() - t0, 'ms');

const out = await model(tokenizer(['一只猫', 'a photo of a cat'], { padding: true, truncation: true }));
const emb = out.text_embeds;
console.log('dims', emb.dims, 'data', emb.data.length);
const a = emb.data.slice(0, 8);
console.log('前 8 维', Array.from(a).map((x) => +x.toFixed(4)));
