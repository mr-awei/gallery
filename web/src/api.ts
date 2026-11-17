/**
 * 前端 API 入口：只负责「组合 + 再导出」。
 *
 * 历史原因这里曾经是一个 2800 行的巨型文件，改一个接口要在 8 个域之间翻。
 * 现在按域拆到 api/ 下：每个模块导出一个普通对象，这里展开成同一个 `api`，
 * 所以 300 多处 `api.xxx()` 调用点一行都不用改。
 *
 * 依赖方向：api/*.ts → core.ts（请求层）／types.ts（形状）。
 * core 不许反向 import 任何域模块，否则又是循环。
 */
export * from './api/types';
export * from './api/core';
export * from './api/models';

import { resourcesAPI } from './api/resources';
import { curateAPI } from './api/curate';
import { integrationsAPI } from './api/integrations';
import { enhanceAPI } from './api/enhance';
import { insightAPI } from './api/insight';
import { smartAPI } from './api/smart';

/** 全部接口的唯一出口：域模块的对象在这里拼成一个 */
export const api = {
  ...resourcesAPI,
  ...curateAPI,
  ...integrationsAPI,
  ...enhanceAPI,
  ...insightAPI,
  ...smartAPI,
};
