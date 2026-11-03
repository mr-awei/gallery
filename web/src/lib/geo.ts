/**
 * 拍摄地点的三级选择：省 → 市 → 区/县，最后拼成水印上那一行字。
 *
 * 只做「拼字」这一件事：地名不参与任何排版计算，服务端只认 location 字符串。
 * 拼法按常见水印的习惯来 —— 直辖市不重复（北京 · 东城区），省级在选了市之后省略，
 * 区县保留全名（西湖区），详细地址（外滩）可以用 · 接在后面。
 */
import { api, type GeoProvince } from '../api';

export type Place = { province: string; city: string; district: string; detail: string };

export const EMPTY_PLACE: Place = { province: '', city: '', district: '', detail: '' };

/**
 * 「省直辖县级行政区划 / 自治区直辖县级行政区划」这类不是城市名的伪节点：
 * 湖北的仙桃、海南的琼海、新疆的石河子都挂在它下面，选中的其实是第三级的县级市。
 * 拼字时把这一级跳过（换成省份），否则水印上会印出「省直辖县级行政区划 · 仙桃市」。
 */
const PSEUDO_CITY = /直辖县级|^市辖区$|^县$/;

/** 省级名去掉行政区后缀：浙江省 → 浙江，内蒙古自治区 → 内蒙古，香港特别行政区 → 香港 */
export function shortProvince(name: string): string {
  return String(name || '')
    .replace(/特别行政区$/, '')
    .replace(/维吾尔自治区$/, '')
    .replace(/壮族自治区$/, '')
    .replace(/回族自治区$/, '')
    .replace(/自治区$/, '')
    .replace(/省$/, '')
    .replace(/市$/, '');
}

/** 市级名去掉「市」：杭州市 → 杭州；自治州/地区/盟保留全名（大理白族自治州、大兴安岭地区） */
export function shortCity(name: string): string {
  const s = String(name || '');
  return s.length > 2 && s.endsWith('市') ? s.slice(0, -1) : s;
}

/** 把三级选择 + 详细地址拼成水印上的文字；全空时返回空串（服务端会回落到 EXIF） */
export function composeLocation(place: Place): string {
  const parts: string[] = [];
  const city = shortCity(place.city);
  const prov = shortProvince(place.province);
  if (city && !PSEUDO_CITY.test(city)) parts.push(city);
  else if (prov) parts.push(prov);
  if (place.district) parts.push(place.district);
  if (place.detail) parts.push(place.detail);
  return parts.join(' · ').slice(0, 80);
}

/**
 * 从一段手填文本里反认省/市/区（只认字面，不做模糊匹配）：
 * 用户先手填了「杭州 · 西湖」，又想换回三级选择器时，能直接定位到浙江 / 杭州 / 西湖区。
 * 认不出来就返回空，面板回落成「待选择」，不会瞎猜。
 */
export function guessPlace(text: string, regions: GeoProvince[]): Place {
  const s = String(text || '').trim();
  if (!s) return EMPTY_PLACE;
  // 1) 先按市名直配：「杭州 · 西湖区」
  for (const p of regions) {
    for (const c of p.cities) {
      const city = shortCity(c.name);
      if (city.length < 2 || PSEUDO_CITY.test(city) || !s.includes(city)) continue;
      const district = c.districts.find((d) => s.includes(d)) || '';
      return { province: p.name, city: c.name, district, detail: '' };
    }
  }
  // 2) 只认得出省 + 区县时按区县反查：「香港 · 中西区」「湖北 · 仙桃市」
  //    （仙桃挂在「省直辖县级行政区划」下，市名根本不在文字里，只能靠第三级认）
  for (const p of regions) {
    const prov = shortProvince(p.name);
    if (prov.length < 2 || !s.includes(prov)) continue;
    for (const c of p.cities) {
      const district = c.districts.find((d) => s.includes(d));
      if (district) return { province: p.name, city: c.name, district, detail: '' };
    }
    return { province: p.name, city: '', district: '', detail: '' };
  }
  return EMPTY_PLACE;
}

/** 省/市/区三级的数据只在第一次用到时拉一次（约 60KB，缓存住别每次开面板都重下） */
let cache: GeoProvince[] | null = null;
let pending: Promise<GeoProvince[]> | null = null;

export function loadGeoRegions(): Promise<GeoProvince[]> {
  if (cache) return Promise.resolve(cache);
  if (pending) return pending;
  pending = api
    .geoRegions()
    .then((r) => {
      cache = Array.isArray(r?.provinces) ? r.provinces : [];
      return cache;
    })
    .catch(() => {
      // 拉不到不影响加水印：选择器退化成「只有手填」
      pending = null;
      return [];
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** 已缓存的数据（同步取，用于渲染） */
export function cachedGeoRegions(): GeoProvince[] {
  return cache || [];
}
