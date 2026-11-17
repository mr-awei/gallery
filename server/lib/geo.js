// @ts-check
/**
 * 拍摄地点的三级选择器数据：省 → 市 → 区/县。
 *
 * 数据来源：china-division（https://github.com/modood/Administrative-divisions-of-China，MIT），
 * 已压成「只有名字、没有行政代码」的紧凑结构（约 60KB），后端一次性读进内存。
 * 直辖市在原始数据里市级是「市辖区 / 县」这种伪节点，这里合并成「北京市 → 东城区…」。
 *
 * 港澳台按各自的真实下一级行政区补全（原始数据留空，只有名字对不上用户需求）：
 * 香港 18 区（香港岛 4 / 九龙 5 / 新界 9）、澳门 8 堂区、台湾 22 县市 + 乡镇市区。
 * 直筒子市（东莞/中山/儋州/嘉峪关）原始数据第三级只有自己，这里补成街道/镇，
 * 否则第三级下拉里只有「东莞市」一项，等于没有更细的地址可选。
 *
 * 地名只用来拼水印上的那一行字，不参与任何合成计算；改数据不影响排版。
 */
import fs from 'node:fs';

/** @type {{ name: string, cities: { name: string, districts: string[] }[] }[]} */
export const GEO_REGIONS = JSON.parse(fs.readFileSync(new URL('./geo-regions.json', import.meta.url), 'utf8'));
