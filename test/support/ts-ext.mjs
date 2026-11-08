/** 测试/冒烟专用入口：让 Node 直接跑 TS 源码时也能解析无扩展名的相对 import。 */
import { register } from 'node:module';

register('./ts-ext-hooks.mjs', import.meta.url);
