// @ts-check
/**
 * 纯 JS 的 HNSW（分层可导航小世界图）—— 给 CLIP 向量召回做近似最近邻。
 *
 * 为什么自己写：现有实现是「16 分桶 + int16 量化 + 桶级上界剪枝」，桶内仍是逐条点积，
 * 属于有损的近邻扫描；库到百万级时桶内扫描会变成主要耗时。HNSW 把「候选集大小」
 * 从「整桶」压到「ef 个点」，检索代价与库规模基本脱钩。
 *
 * 取舍：
 * - 只做单层邻居剪枝（不做 heuristic 选边），实现短、可读、够用；
 * - 向量按传入顺序插入，level 用几何分布抽样，与论文一致；
 * - 相似度用「已归一化向量的点积」，与 CLIP 余弦一致，避免每次开方。
 *
 * 注意：这是内存结构。百万级 512 维 float32 ≈ 2GB，绝不能常驻主进程；
 * 调用方需自己控制规模（见 clip.js 里 ANN_MAX 的说明）。
 */

/** 距离度量：单位向量点积（= 余弦） */
function dot(a, b, dim) {
  let s = 0;
  for (let i = 0; i < dim; i++) s += a[i] * b[i];
  return s;
}

export class Hnsw {
  /**
   * @param {{ M?: number, efConstruction?: number, efSearch?: number }} [opts]
   */
  constructor({ M = 16, efConstruction = 200, efSearch = 64 } = {}) {
    this.M = Math.max(4, M);
    this.efConstruction = Math.max(this.M, efConstruction);
    this.efSearch = Math.max(this.M, efSearch);
    /** 层数上限对应的采样系数：level = floor(-ln(U) / ln(M)) */
    this.ml = 1 / Math.log(this.M);
    /** @type {Map<number, { vec: Float32Array, level: number, links: number[][] }>} */
    this.nodes = new Map();
    /** @type {number[]} 每层入口点 */
    this.entry = [];
    this.dim = 0;
    this.maxLevel = -1;
  }

  get size() {
    return this.nodes.size;
  }

  clear() {
    this.nodes.clear();
    this.entry = [];
    this.maxLevel = -1;
    this.dim = 0;
  }

  /**
   * 插入一个向量（重复 id 会覆盖业务含义，调用方自己保证唯一）。
   * @param {number} id
   * @param {Float32Array} vec
   */
  insert(id, vec) {
    if (!this.dim) this.dim = vec.length;
    if (vec.length !== this.dim) throw new Error(`HNSW 维度不一致：${vec.length} != ${this.dim}`);
    if (this.nodes.has(id)) return;

    const u = Math.random() || 1e-9; // 避免 log(0)
    const level = Math.min(16, Math.floor(-Math.log(u) * this.ml));
    const node = { vec, level, links: Array.from({ length: level + 1 }, () => []) };
    this.nodes.set(id, node);

    if (this.maxLevel < 0) {
      this.maxLevel = level;
      this.entry = Array.from({ length: level + 1 }, () => id);
      return;
    }

    let cur = this.entry[this.maxLevel];
    // 1) 从最高层往下，贪心走到本层最近的入口
    for (let lc = this.maxLevel; lc > level; lc--) {
      cur = this.greedy(cur, vec, lc);
    }
    // 2) 从 min(level, maxLevel) 层开始逐层建立双向邻居
    for (let lc = Math.min(level, this.maxLevel); lc >= 0; lc--) {
      const cands = this.searchLayer(vec, [cur], lc, this.efConstruction);
      const picked = cands.slice(0, this.M).map((c) => c.id);
      node.links[lc] = picked;
      for (const nid of picked) {
        const nb = this.nodes.get(nid);
        if (!nb) continue;
        const arr = nb.links[lc] || (nb.links[lc] = []);
        arr.push(id);
        // 邻居超员就按相似度裁掉最远的，保持图稀疏（否则查询会退化成分桶扫描）
        if (arr.length > this.M * 2) {
          arr.sort((a, b) => this.simOf(b, nb.vec) - this.simOf(a, nb.vec));
          arr.length = this.M;
        }
      }
      if (cands.length) cur = cands[0].id;
    }
    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entry = Array.from({ length: level + 1 }, (_, i) => (i <= level ? id : this.entry[i] ?? id));
    }
  }

  /**
   * 近似最近邻查询。
   * @param {Float32Array} vec
   * @param {number} k
   * @param {number} [ef] 候选集大小，越大越准越慢
   * @returns {{ id: number, sim: number }[]}
   */
  search(vec, k = 10, ef = this.efSearch) {
    if (!this.nodes.size) return [];
    const efv = Math.max(ef, k);
    let cur = this.entry[this.maxLevel];
    for (let lc = this.maxLevel; lc > 0; lc--) cur = this.greedy(cur, vec, lc);
    const cands = this.searchLayer(vec, [cur], 0, efv);
    return cands.slice(0, k);
  }

  /** 某一层里从若干入口出发的贪心最好点 */
  greedy(startId, vec, level) {
    let bestId = startId;
    let bestSim = this.simOf(startId, vec);
    let improved = true;
    while (improved) {
      improved = false;
      const node = this.nodes.get(bestId);
      if (!node) break;
      for (const nid of node.links[level] || []) {
        const s = this.simOf(nid, vec);
        if (s > bestSim) {
          bestSim = s;
          bestId = nid;
          improved = true;
        }
      }
    }
    return bestId;
  }

  /** 标准 best-first 层内搜索，返回按相似度降序的 [{id, sim}] */
  searchLayer(vec, entryIds, level, ef) {
    const visited = new Set(entryIds);
    /** @type {{ id: number, sim: number }[]} */
    const result = [];
    /** @type {{ id: number, sim: number }[]} */
    const queue = [];
    for (const id of entryIds) {
      const sim = this.simOf(id, vec);
      if (sim === -Infinity) continue;
      result.push({ id, sim });
      queue.push({ id, sim });
    }
    result.sort((a, b) => b.sim - a.sim);
    while (queue.length) {
      queue.sort((a, b) => b.sim - a.sim);
      const cur = queue.shift();
      if (!cur) break;
      if (result.length >= ef && cur.sim < result[result.length - 1].sim) break;
      const node = this.nodes.get(cur.id);
      if (!node) continue;
      for (const nid of node.links[level] || []) {
        if (visited.has(nid)) continue;
        visited.add(nid);
        const sim = this.simOf(nid, vec);
        if (sim === -Infinity) continue;
        if (result.length < ef || sim > result[result.length - 1].sim) {
          result.push({ id: nid, sim });
          queue.push({ id: nid, sim });
          result.sort((a, b) => b.sim - a.sim);
          if (result.length > ef) result.length = ef;
        }
      }
    }
    return result;
  }

  simOf(id, vec) {
    const node = this.nodes.get(id);
    if (!node) return -Infinity;
    return dot(node.vec, vec, this.dim);
  }
}

export default Hnsw;
