import { IconClose } from './Icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type GeoProvince, type WatermarkOptions, type WatermarkParams } from '../api';
import { useJobProgress } from '../hooks/useJobProgress';
import type { EditJobStatus, ImageItem, WatermarkPreset } from '../types';
import Select, { type SelectOption } from './Select';
import SaveModeBlock, { SAVE_MODE_DEFAULT, type SaveModeState } from './SaveModeBlock';
import { downloadBlob } from '../lib/palette';
import { EMPTY_PLACE, cachedGeoRegions, composeLocation, guessPlace, loadGeoRegions, type Place } from '../lib/geo';
import { makePreset, mergePresets, parsePresetFile, presetFileText, sanitizePreset } from '../lib/watermark-preset';
import i18n from '../i18n';

type Props = {
  open: boolean;
  /** 选中的图片；1 张是单图，多张走批量任务 */
  ids: number[];
  onClose: () => void;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
  /** 单张应用会把更新后的条目回传（另存不入库时为 null），批量任务则只通知刷新 */
  onDone?: (item?: ImageItem | null) => void;
};

/**
 * 文字颜色：前三个是「语义色」，跟着样式/底色自动定深浅；后面是常用色板。
 * 服务端 normalizeParams 只认 light/dark/auto/#rrggbb，其余回落 auto，所以这里
 * 的值必须是合法十六进制，不能写 rgba() 或颜色名。
 */
const COLOR_OPTS = [
  { value: 'auto', label: i18n.t('k78a45b3a'), group: i18n.t('k96658cef') },
  { value: 'light', label: i18n.t('k5eb8690a'), group: i18n.t('k96658cef') },
  { value: 'dark', label: i18n.t('kd3d162ea'), group: i18n.t('k96658cef') },
  { value: '#ffffff', label: i18n.t('k5597d763'), group: i18n.t('k1829e78d') },
  { value: '#f2f2f2', label: i18n.t('k536a2ae0'), group: i18n.t('k1829e78d') },
  { value: '#9e9e9e', label: i18n.t('k78cf0c6b'), group: i18n.t('k1829e78d') },
  { value: '#141414', label: i18n.t('k3a5c90c2'), group: i18n.t('k1829e78d') },
  { value: '#d4af37', label: i18n.t('k6986b308'), group: i18n.t('k1829e78d') },
  { value: '#e8c37a', label: i18n.t('k3b5cb3d4'), group: i18n.t('k1829e78d') },
  { value: '#c0c8d0', label: i18n.t('k1537d809'), group: i18n.t('k1829e78d') },
  { value: '#ff5a5f', label: i18n.t('k4f670ea2'), group: i18n.t('k1829e78d') },
  { value: '#4da3ff', label: i18n.t('ke3f782fb'), group: i18n.t('k1829e78d') },
];

/** 型号下拉里的「自定义」哨兵值：选中它就把下拉换成输入框 */
const CUSTOM_MODEL = '__custom__';

/** EXIF 里这一项有没有值（没有就标「无」，但仍允许勾选，由服务端给出明确报错） */
function exifHasField(exif: Record<string, unknown> | null, k: string): boolean {
  if (!exif) return true;
  if (k === 'camera') return Boolean(exif.camera || exif.make);
  if (k === 'shutter') return Boolean(exif.exposure || exif.exposureTime);
  if (k === 'time') return Boolean(exif.takenAtText || exif.takenAt);
  return Boolean(exif[k]);
}

/**
 * 水印 / 相框工作台。
 * 预览走服务端同一套合成逻辑（只是缩到 1400px），所以「所见即所得」不是另一份实现。
 */
export default function WatermarkStudio({ open, ids, onClose, onToast, onDone }: Props) {
  const [opt, setOpt] = useState<WatermarkOptions | null>(null);
  const [style, setStyle] = useState('corner-br');
  const [frame, setFrame] = useState('none');
  const [fields, setFields] = useState<string[]>(['camera', 'aperture', 'shutter', 'iso']);
  const [logo, setLogo] = useState(true);
  const [brand, setBrand] = useState('auto');
  /** 手选/手写的型号：拼在品牌后面覆盖 EXIF（截图和导出图根本没有型号） */
  const [model, setModel] = useState('');
  const [size, setSize] = useState(1);
  const [opacity, setOpacity] = useState(1);
  const [color, setColor] = useState('auto');
  const [font, setFont] = useState('auto');
  /** 手填地点（保底）：和三级选择器二选一，谁在用谁说话 */
  const [location, setLocation] = useState('');
  /** 三级选择器的选择结果：省/市/区/详细，改动时同步拼出 location */
  const [place, setPlace] = useState<Place>(EMPTY_PLACE);
  /** true = 直接手填地点（地名不在库里的人用）；false = 省/市/区三级选择 */
  const [locFree, setLocFree] = useState(false);
  /** 型号的自定义输入框（列表里没有的型号） */
  const [modelFree, setModelFree] = useState(false);
  const [regions, setRegions] = useState<GeoProvince[]>(cachedGeoRegions);
  /** 本机字体（可与样式表一起返回，也可单独点「刷新」重扫） */
  const [sysFonts, setSysFonts] = useState<{ key: string; name: string; group: string }[]>([]);
  const [fontScanning, setFontScanning] = useState(false);
  const [save, setSave] = useState<SaveModeState>(SAVE_MODE_DEFAULT);

  const [exif, setExif] = useState<Record<string, unknown> | null>(null);
  const [preview, setPreview] = useState('');
  const [err, setErr] = useState('');
  /** 预览出图了但没画水印时，服务端给的原因（不是错误，红条会吓人，单独一条黄字） */
  const [note, setNote] = useState('');

  /* ---- 预设 ---- */
  const [presets, setPresets] = useState<WatermarkPreset[]>([]);
  const [presetId, setPresetId] = useState('');
  /** 「保存为预设」的名字输入行 */
  const [savingName, setSavingName] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [job, setJob] = useState<EditJobStatus | null>(null);
  const [polling, setPolling] = useState(false); // 已提交批量任务，开始轮询进度
  const [pollErr, setPollErr] = useState(''); // 连续读不到进度时的原因
  const errCount = useRef(0);
  const previewRef = useRef('');
  const firstId = ids[0] || 0;

  /* 样式表随面板一起拉，避免把 20 + 20 个名字在前后端各写一份 */
  useEffect(() => {
    if (!open || opt) return;
    let alive = true;
    void api
      .watermarkOptions()
      .then((o) => {
        if (!alive) return;
        setOpt(o);
        if (Array.isArray(o.systemFonts)) setSysFonts(o.systemFonts);
        if (o.defaults?.style) setStyle(o.defaults.style);
        if (Array.isArray(o.defaults?.fields) && o.defaults.fields.length) setFields(o.defaults.fields);
      })
      .catch((e) => setErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, [open, opt]);

  /* 省/市/区数据：只在第一次打开面板时拉（模块级缓存，之后再开瞬间就有） */
  useEffect(() => {
    if (!open || regions.length) return;
    let alive = true;
    void loadGeoRegions().then((list) => {
      if (alive && list.length) setRegions(list);
    });
    return () => {
      alive = false;
    };
  }, [open, regions.length]);

  /* 取第一张的 EXIF：用来说明「这一项有没有数据」，避免用户勾了空字段一头雾水 */
  useEffect(() => {
    if (!open || !firstId) return;
    let alive = true;
    setExif(null);
    void api
      .exif(firstId)
      .then((r) => {
        if (alive) setExif((r?.exif || {}) as Record<string, unknown>);
      })
      .catch(() => alive && setExif({}));
    return () => {
      alive = false;
    };
  }, [open, firstId]);

  const params: WatermarkParams = useMemo(
    () => ({ style, frame, fields, logo, brand, model, size, opacity, color, font, location, place }),
    [style, frame, fields, logo, brand, model, size, opacity, color, font, location, place]
  );

  /* 打开面板时读一次预设（存在设置里，跨库共享）。脏数据当场清掉，别让一条坏记录把面板搞崩 */
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api
      .settings()
      .then((s) => {
        if (!alive) return;
        const list = Array.isArray(s?.watermarkPresets) ? s.watermarkPresets : [];
        setPresets(list.map((p) => sanitizePreset(p)).filter((p): p is WatermarkPreset => Boolean(p)));
      })
      .catch(() => {
        /* 设置读不到不影响加水印，预设区留空即可 */
      });
    return () => {
      alive = false;
    };
  }, [open]);

  /** 预设落盘：本地先更新（界面立刻响应），失败再回滚并提示 */
  const persistPresets = useCallback(
    async (next: WatermarkPreset[]) => {
      const prev = presets;
      setPresets(next);
      try {
        await api.saveSettings({ watermarkPresets: next });
      } catch (e) {
        setPresets(prev);
        onToast?.(i18n.t('k934f44b0', { p0: (e as Error).message || i18n.t('k974e7484') }));
      }
    },
    [presets, onToast]
  );

  /** 套用预设：整套参数一次换掉，避免「样式换了型号还是上一套」 */
  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    const v = p.params;
    setStyle(v.style);
    setFrame(v.frame);
    setFields(Array.isArray(v.fields) ? v.fields : []);
    setLogo(v.logo);
    // 品牌清单会随版本增删（纯镜头厂已下架）：老预设里存着不存在的 key 就回落自动识别
    setBrand((opt?.brands || []).some((b) => b.key === v.brand) ? v.brand : 'auto');
    setModel(v.model);
    setSize(v.size);
    setOpacity(v.opacity);
    setColor(v.color);
    setFont(v.font);
    setLocation(v.location);
    // 老预设只有拼好的字符串：没有 place 就退回「手填」，别让三级下拉假装是空的
    const p2 = v.place;
    const hasPlace = Boolean(p2 && (p2.province || p2.city || p2.district || p2.detail));
    setPlace(hasPlace && p2 ? { ...EMPTY_PLACE, ...p2 } : EMPTY_PLACE);
    // 有省市区就用选择器；只有一段拼好的文字（老预设、手填）就回到手填框
    setLocFree(!hasPlace && Boolean(v.location));
    // 型号不在内置清单里（自定义的）要让输入框出来，否则下拉显示为空、用户以为丢了
    setModelFree(Boolean(v.model) && !(opt?.brands || []).some((b) => (b.models || []).includes(v.model)));
  };

  const commitPreset = () => {
    const name = (savingName || '').trim();
    if (!name) {
      onToast?.(i18n.t('kc0a8ba5e'));
      return;
    }
    const made = makePreset(name, params);
    if (!made) {
      onToast?.(i18n.t('kfb7914d2'));
      return;
    }
    const same = presets.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
    const next = same >= 0 ? presets.map((x, i) => (i === same ? { ...made, id: x.id } : x)) : [...presets, made];
    setSavingName(null);
    setPresetId(made.id);
    onToast?.(same >= 0 ? i18n.t('k3e41e5bf', { p0: name }) : i18n.t('k91a67400', { p0: name }));
    void persistPresets(next);
  };

  const removePreset = () => {
    const p = presets.find((x) => x.id === presetId);
    if (!p) return;
    setPresetId('');
    onToast?.(i18n.t('k5ef36234', { p0: p.name }));
    void persistPresets(presets.filter((x) => x.id !== presetId));
  };

  const exportPresets = () => {
    if (!presets.length) {
      onToast?.(i18n.t('keb4dbc03'));
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(new Blob([presetFileText(presets)], { type: 'application/json' }), i18n.t('kf7177b5d', { p0: stamp }));
    onToast?.(i18n.t('kb7a46ee3', { p0: presets.length }));
  };

  const importPresets = async (file: File) => {
    try {
      const { presets: incoming, skipped } = parsePresetFile(JSON.parse(await file.text()));
      if (!incoming.length) {
        onToast?.(skipped ? i18n.t('kcb60293f', { p0: skipped }) : i18n.t('k858bba1f'));
        return;
      }
      const { presets: next, added, replaced } = mergePresets(presets, incoming);
      await persistPresets(next);
      onToast?.(i18n.t('kd6ff289b', { p0: added, p1: replaced ? i18n.t('k357dc025', { p0: replaced }) : '', p2: skipped ? i18n.t('k169ce0ba', { p0: skipped }) : '' }));
    } catch (e) {
      onToast?.(i18n.t('kdfcff80b', { p0: (e as Error).message || i18n.t('kfcd0ef53') }));
    }
  };

  /* 字体下拉：内置的「跟随样式」+ 服务端给的字体 + 本机 242 种系统字体（可搜索） */
  const fontOptions = useMemo(() => {
    const list: SelectOption[] = [{ value: 'auto', label: i18n.t('kf935034e') }];
    (opt?.fonts || []).forEach((f) => list.push({ value: f.key, label: f.name, group: i18n.t('kf0fb9bdf') }));
    sysFonts.forEach((f) => list.push({ value: f.key, label: f.name, group: f.group }));
    return list;
  }, [opt, sysFonts]);

  /**
   * 型号候选：指定品牌后只列这个品牌的常见/热门型号；「自动识别」时把全品牌型号拍平分组，
   * 选中哪个型号就顺便把品牌定下来（省得用户先猜品牌再翻型号）。
   */
  const modelOptions = useMemo<SelectOption[]>(() => {
    const brands = opt?.brands || [];
    if (brand !== 'auto') {
      const b = brands.find((x) => x.key === brand);
      return (b?.models || []).map((m) => ({ value: m, label: m }));
    }
    return brands.flatMap((b) => (b.models || []).map((m) => ({ value: `${b.key}::${m}`, label: m, group: b.name })));
  }, [opt, brand]);

  /** 下拉里当前该高亮哪一项：品牌=自动时选项值是 `品牌::型号`，得反查回去 */
  const modelValue = useMemo(() => {
    if (!model) return '';
    if (brand !== 'auto') return model;
    const hit = (opt?.brands || []).find((b) => (b.models || []).includes(model));
    return hit ? `${hit.key}::${model}` : '';
  }, [opt, brand, model]);

  /** 选项值可能是 `品牌::型号`：顺手把品牌也切过去，省得先猜品牌再翻型号 */
  const pickModel = (v: string) => {
    if (v === CUSTOM_MODEL) {
      setModelFree(true);
      return;
    }
    const sep = v.indexOf('::');
    if (sep > 0) {
      setBrand(v.slice(0, sep));
      setModel(v.slice(sep + 2));
      return;
    }
    setModel(v);
  };

  /* 省 → 市 → 区：上一级变了要清空下一级，否则会出现「浙江省 / 杭州市 / 东城区」这种串味组合 */
  const setPlacePart = (k: keyof Place, v: string) => {
    const next: Place = { ...place, [k]: v };
    if (k === 'province') {
      next.city = '';
      next.district = '';
    } else if (k === 'city') {
      next.district = '';
    }
    setPlace(next);
    setLocation(composeLocation(next));
  };

  /**
   * 切到「直接手填」：把当前拼好的文字带过去，用户接着改就行。
   * 同时清掉三级选择，免得预设里存着「省市区 + 一段不相干的手填文字」，套用时分不清该信谁。
   */
  const toFreeLocation = () => {
    const text = composeLocation(place) || location;
    setLocFree(true);
    setLocation(text);
    setPlace(EMPTY_PLACE);
  };

  /** 切回三级选择：先试着从手填的文字里认出省/市/区，认不出就让用户重新选 */
  const toPickLocation = () => {
    const g = guessPlace(location, regions);
    setLocFree(false);
    setPlace(g);
    setLocation(composeLocation(g));
  };

  const provinceOptions = useMemo<SelectOption[]>(
    () => regions.map((p) => ({ value: p.name, label: p.name })),
    [regions]
  );

  const cityOptions = useMemo<SelectOption[]>(() => {
    const p = regions.find((x) => x.name === place.province);
    return (p?.cities || []).map((c) => ({ value: c.name, label: c.name }));
  }, [regions, place.province]);

  const districtOptions = useMemo<SelectOption[]>(() => {
    const p = regions.find((x) => x.name === place.province);
    const c = p?.cities.find((x) => x.name === place.city);
    return (c?.districts || []).map((d) => ({ value: d, label: d }));
  }, [regions, place.province, place.city]);

  /** 重新扫本机字体：用户刚在系统里装完字体重开也看不到时点这个 */
  const rescanFonts = useCallback(() => {
    setFontScanning(true);
    void api
      .watermarkFonts()
      .then((r) => {
        if (Array.isArray(r?.fonts)) setSysFonts(r.fonts);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setFontScanning(false));
  }, []);

  /** 字段 key → 中文名（服务端下发，提示文案统一用它） */
  const fieldLabel = useCallback(
    (k: string) => opt?.fields.find((f) => f.key === k)?.label || k,
    [opt]
  );

  /**
   * EXIF 里这一项有没有值（没有就标「无」，但仍允许勾选，由服务端给出明确报错）。
   *
   * 用 function 声明而不是 const 箭头：函数声明会提升，`usableFields` 的 useMemo
   * 在首次渲染就会调用它。写成 `const available = …` 且声明在 useMemo 之后，
   * 就是 `Cannot access 'available' before initialization` —— 整个面板白屏。
   */
  function available(k: string): boolean {
    if (k === 'camera' && model) return true;
    if (k === 'location' && location) return true;
    return exifHasField(exif, k);
  }

  /**
   * 当前「真的有数据」的字段：某款样式只吃其中某几项时，靠它判断能不能排出东西。
   * 有品牌 logo 也算有内容（大多数样式会给字标留位置）。
   */
  const usableFields = useMemo(() => {
    const keys = (opt?.fields || []).map((f) => f.key);
    return new Set(keys.filter((k) => fields.includes(k) && available(k)));
    // available 依赖 exif / model / location
  }, [opt, fields, exif, model, location]);

  const logoUsable = logo && (brand !== 'auto' || Boolean(exif?.make) || Boolean(model));

  /**
   * 这款样式排不排得出东西：uses 声明了它只吃某几项，
   * 而当前勾选里一项都没有 —— 以前这种情况会静默出图，用户只会觉得「水印没生效」。
   */
  const styleBlocked = useCallback(
    (s: { uses?: string[]; needs?: string[] }) => {
      if (logoUsable) return ''; // 有字标可画
      if (s.needs?.length) {
        if (!s.needs.some((k) => usableFields.has(k))) {
          return i18n.t('k7db680f4', { p0: s.needs.map(fieldLabel).join(' / ') });
        }
        return '';
      }
      if (!s.uses?.length) return '';
      if (s.uses.some((k) => usableFields.has(k))) return '';
      return i18n.t('kaaac02e9', { p0: s.uses.map(fieldLabel).join(' / ') });
    },
    [logoUsable, usableFields, fieldLabel]
  );

  /** 应用前的硬校验：这两个情况服务端也会拒，没必要先打一次请求 */
  const validate = useCallback((): string => {
    if (style === 'none' && frame === 'none') return i18n.t('ka6af1eeb');
    if (style !== 'none' && fields.length === 0 && !logo) {
      return i18n.t('k502f145d');
    }
    const s = opt?.watermarks.find((x) => x.id === style);
    const blocked = s ? styleBlocked(s) : '';
    if (s && blocked) {
      return i18n.t('k04ff91c4', { p0: s.name, p1: blocked });
    }
    return '';
  }, [style, frame, fields.length, logo, opt, styleBlocked]);

  /* 预览：参数变化后 350ms 再请求，拖动滑块不会打爆服务端。
     校验完全交给服务端：没有可显示的信息时它也会返回原图 + 一句说明，
     比前端拦下来「什么都不显示」有用得多。 */
  useEffect(() => {
    if (!open || !firstId) return;
    // style/frame 都没选时才是真的没内容可合成
    if (style === 'none' && frame === 'none') {
      setErr(i18n.t('ka6af1eeb'));
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = '';
      setPreview('');
      setNote('');
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void api
        .watermarkPreview(firstId, params)
        .then(({ blob, note: serverNote }) => {
          if (!alive) return;
          const url = URL.createObjectURL(blob);
          if (previewRef.current) URL.revokeObjectURL(previewRef.current);
          previewRef.current = url;
          setPreview(url);
          setNote(serverNote);
          setErr('');
        })
        .catch((e) => alive && setErr((e as Error).message || i18n.t('k6a3a5ef0')))
        .finally(() => alive && setLoading(false));
    }, 350);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [open, firstId, params, style, frame]);

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = '';
    },
    []
  );

  /* 批量进度走 SSE job 快照（与裁切/调色同一套任务）；SSE 断了才低频兜底 */
  const applyStatus = useCallback(
    (s: EditJobStatus) => {
      errCount.current = 0;
      setPollErr('');
      setJob(s);
      if (!s.running) {
        setPolling(false);
        setApplying(false);
        onDone?.();
        onToast?.(i18n.t('k50b2d991', { p0: s.done, p1: s.failed ? i18n.t('kfb601e6f', { p0: s.failed }) : '' }));
        onClose();
      }
    },
    [onDone, onToast, onClose]
  );

  const pollOnce = useCallback(async () => {
    try {
      applyStatus(await api.editJob());
    } catch (pollFailure) {
      errCount.current += 1;
      if (errCount.current >= 3) setPollErr((pollFailure as Error).message || i18n.t('ke033d67c'));
    }
  }, [applyStatus]);

  useJobProgress((d) => {
    if (d?.edit) applyStatus(d.edit as EditJobStatus);
  }, pollOnce, open && polling);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !applying) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, applying, onClose]);

  /* EXIF 到齐后自动纠正一次：默认勾的四项若一项都没数据（截图/导出图非常常见），
     换成这张图真正有的信息，否则一打开面板就是「读不到所选信息」。
     注意必须放在 `if (!open) return null` 之前——挂在它后面就是「有条件调用的 hook」，
     一开一关就会崩成白屏。 */
  const autoFixedRef = useRef(0);
  useEffect(() => {
    if (!exif || !opt || autoFixedRef.current === firstId) return;
    autoFixedRef.current = firstId;
    const ok = opt.fields.map((f) => f.key).filter((k) => exifHasField(exif, k));
    setFields((prev) => {
      if (!prev.length || prev.some((k) => exifHasField(exif, k))) return prev;
      return ok.length ? ok.slice(0, 4) : prev;
    });
  }, [exif, opt, firstId]);

  if (!open) return null;

  const toggleField = (k: string) =>
    setFields((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  const apply = async () => {
    const v = validate();
    if (v) {
      setErr(v);
      onToast?.(v);
      return;
    }
    setErr('');
    setApplying(true);
    const payload = {
      ...params,
      saveMode: save.saveMode,
      targetDir: save.saveMode === 'copy' ? save.targetDir.trim() : '',
      addToLibrary: save.addToLibrary,
    };
    try {
      if (ids.length === 1) {
        const r = await api.watermarkImage(ids[0], payload);
        onToast?.(
          r.copied ? i18n.t('kfad6b303', { p0: r.savedPath || i18n.t('kb239a804') }) : i18n.t('ked5db60f', { p0: r.width, p1: r.height, p2: r.note ? ` · ${r.note}` : '' })
        );
        onDone?.(r.item);
        onClose();
      } else {
        const r = await api.batchEdit(ids, 'watermark', payload);
        setJob(r.job);
        setPolling(true);
        onToast?.(i18n.t('k5450d2dd', { p0: ids.length }));
      }
    } catch (e) {
      setApplying(false);
      const msg = (e as Error).message || i18n.t('k68104ad0');
      setErr(msg);
      onToast?.(msg);
    }
  };

  const cancelJob = async () => {
    try {
      setJob(await api.cancelEditJob());
    } catch {
      /* 取消失败就继续跑 */
    }
  };

  const pct = job && job.total ? Math.round(((job.done + job.failed) / job.total) * 100) : 0;
  const styleNone = style === 'none';
  const frameNone = frame === 'none';

  return createPortal(
    <div className="wm-mask" onMouseDown={applying ? undefined : onClose}>
      <div className="wm-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="wm-head">
          <b>{i18n.t('kaa599e21')}</b>
          <span className="wm-sub">
            {ids.length > 1 ? i18n.t('k86ff7d6e', { p0: ids.length }) : i18n.t('kd6dcd722')}
          </span>
          <button className="btn sm ghost wm-close" disabled={applying} onClick={onClose} title={i18n.t('kb15d9127')}>
            <IconClose size={14} />
          </button>
        </div>

        <div className="wm-body">
          <div className="wm-preview">
            <div className="wm-stage">
              {preview ? <img src={preview} alt={i18n.t('k87899c5c')} /> : <div className="wm-empty">{i18n.t('k098e863b')}</div>}
              {(loading || applying) && (
                <div className="wm-stage-mask">
                  <span className="spinner" />
                  {applying ? i18n.t('k59ca1a8a') : i18n.t('kb1d3848e')}
                </div>
              )}
              {note && !err && <div className="wm-stage-note">{note}</div>}
              {err && <div className="wm-stage-err">{err}</div>}
            </div>
            <div className="wm-preview-foot">
              <span>{i18n.t('kf61c1327')}</span>
              <span className="wm-tag">{ids.length > 1 ? i18n.t('ka1433b53', { p0: ids.length }) : i18n.t('kfb43d5ff')}</span>
            </div>
            {job && job.running && (
              <div className="wm-progress">
                <div className="wm-progress-bar">
                  <i style={{ width: `${pct}%` }} />
                </div>
                <span>
                  {job.done + job.failed} / {job.total}（失败 {job.failed}）
                </span>
                <button className="btn sm ghost" onClick={cancelJob}>
                  {i18n.t('k625fb26b')}
                </button>
              </div>
            )}
            {pollErr && applying && (
              <div className="wm-preview-foot" style={{ color: 'var(--err, #e5484d)' }}>
                进度读取失败：{pollErr}（仍在重试）
              </div>
            )}
          </div>

          <div className="wm-panel">
            <section className="wm-sec">
              <h4>
                {i18n.t('k7d52ef52')} <em>{presets.length} 套</em>
              </h4>
              <div className="wm-row">
                <Select
                  className="wm-sel"
                  value={presetId}
                  onChange={applyPreset}
                  options={
                    presets.length
                      ? [{ value: '', label: i18n.t('ka1ed91aa') }, ...presets.map((p) => ({ value: p.id, label: p.name }))]
                      : [{ value: '', label: i18n.t('kaa68f2f7') }]
                  }
                  title={i18n.t('ke33ebddf')}
                />
                <button
                  className="btn sm ghost"
                  onClick={() => setSavingName(presets.find((p) => p.id === presetId)?.name || '')}
                  title={i18n.t('kbd0e6dbb')}
                >
                  {i18n.t('kbe5fbbe3')}
                </button>
                <button className="btn sm ghost" disabled={!presetId} onClick={removePreset}>
                  {i18n.t('k2f4aaddd')}
                </button>
              </div>
              {savingName !== null && (
                <div className="wm-row">
                  <input
                    className="wm-input"
                    autoFocus
                    value={savingName}
                    maxLength={40}
                    placeholder={i18n.t('k76dc750f')}
                    onChange={(e) => setSavingName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitPreset();
                      } else if (e.key === 'Escape') {
                        // 别让 Esc 冒泡把整个面板关掉
                        e.stopPropagation();
                        setSavingName(null);
                      }
                    }}
                  />
                  <button className="btn sm" onClick={commitPreset}>
                    {i18n.t('kbe5fbbe3')}
                  </button>
                  <button className="btn sm ghost" onClick={() => setSavingName(null)}>
                    {i18n.t('k625fb26b')}
                  </button>
                </div>
              )}
              <div className="wm-row">
                <button className="btn sm ghost" onClick={() => importRef.current?.click()}>
                  {i18n.t('k710086e2')}
                </button>
                <button className="btn sm ghost" onClick={exportPresets}>
                  {i18n.t('kcdb1737a')}
                </button>
                <input
                  ref={importRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = ''; // 同一个文件连点两次也要能触发
                    if (f) void importPresets(f);
                  }}
                />
              </div>
              <p className="wm-hint">{i18n.t('k47d48e5c')}</p>
            </section>

            <section className="wm-sec">
              <h4>
                {i18n.t('kef658ac0')} <em>{fields.length} 项</em>
              </h4>
              <div className="wm-fields">
                {(opt?.fields || []).map((f) => {
                  const on = fields.includes(f.key);
                  const has = available(f.key);
                  return (
                    <label key={f.key} className={`wm-field${on ? ' on' : ''}${has ? '' : ' void'}`}>
                      <input type="checkbox" checked={on} onChange={() => toggleField(f.key)} />
                      <span>{f.label}</span>
                      {!has && <i title={i18n.t('k323794a0')}>{i18n.t('kd81bb206')}</i>}
                    </label>
                  );
                })}
              </div>
              {/* 型号：EXIF 里的型号常常没有、或是 ILCE-7M4 这种机器名，
                  所以给一份「品牌常见型号」清单让用户选；清单外的点「自定义型号」手写 */}
              {fields.includes('camera') && (
                <>
                  <div className="wm-row">
                    <span className="wm-row-label">{i18n.t('k0b098228')}</span>
                    {modelFree ? (
                      <>
                        <input
                          className="wm-input"
                          value={model}
                          maxLength={60}
                          autoFocus
                          placeholder={i18n.t('k303f4677')}
                          onChange={(e) => setModel(e.target.value)}
                        />
                        <button
                          className="btn sm ghost"
                          title={i18n.t('k13c54727')}
                          onClick={() => {
                            setModelFree(false);
                            setModel('');
                          }}
                        >
                          {i18n.t('k3712972d')}
                        </button>
                      </>
                    ) : (
                      <Select
                        className="wm-sel"
                        value={modelValue}
                        onChange={pickModel}
                        options={[...modelOptions, { value: CUSTOM_MODEL, label: i18n.t('k3347c1d4') }]}
                        placeholder={available('camera') ? i18n.t('k47f35eae') : i18n.t('k3271c52d')}
                        title={i18n.t('kfbc975df')}
                        searchThreshold={20}
                      />
                    )}
                  </div>
                  {!modelFree && brand !== 'auto' && modelOptions.length === 0 && (
                    <p className="wm-tip">{i18n.t('ke4db9f27')}</p>
                  )}
                </>
              )}
              {/* 拍摄地点：省 → 市 → 区/县 三级选择，地名不在库里的可以切「手填」 */}
              {fields.includes('location') && (
                <>
                  {locFree ? (
                    <div className="wm-row">
                      <span className="wm-row-label">{i18n.t('k9fdaa35b')}</span>
                      <input
                        className="wm-input"
                        value={location}
                        maxLength={80}
                        placeholder={available('location') ? i18n.t('k2f8579bf') : i18n.t('ka6a2af4b')}
                        onChange={(e) => setLocation(e.target.value)}
                      />
                      <button className="btn sm ghost" title={i18n.t('kc0f5d553')} onClick={toPickLocation}>
                        {i18n.t('k58106438')}
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="wm-row">
                        <span className="wm-row-label">{i18n.t('k9fdaa35b')}</span>
                        <Select
                          className="wm-sel"
                          value={place.province}
                          onChange={(v) => setPlacePart('province', v)}
                          options={provinceOptions}
                          placeholder={i18n.t('kd7009d07')}
                          title={i18n.t('k08f8be38')}
                        />
                        <Select
                          className="wm-sel"
                          value={place.city}
                          onChange={(v) => setPlacePart('city', v)}
                          options={cityOptions}
                          placeholder={i18n.t('kf7d29dfa')}
                          disabled={!place.province}
                          title={i18n.t('k62b936b3')}
                        />
                      </div>
                      {place.city && (
                        <div className="wm-row">
                          <Select
                            className="wm-sel"
                            value={place.district}
                            onChange={(v) => setPlacePart('district', v)}
                            options={districtOptions}
                            placeholder={districtOptions.length ? i18n.t('kb26c5c02') : i18n.t('kf9bac778')}
                            title={i18n.t('k5ccc71d5')}
                          />
                          <input
                            className="wm-input"
                            value={place.detail}
                            maxLength={40}
                            placeholder={i18n.t('kcc114644')}
                            onChange={(e) => setPlacePart('detail', e.target.value)}
                          />
                        </div>
                      )}
                      <div className="wm-row wm-loc-foot">
                        <p className="wm-hint">
                          {i18n.t('k61dcbd94')}<b>{location || i18n.t('k1be9fc93')}</b>
                        </p>
                        <button className="btn sm ghost" title={i18n.t('k42f35843')} onClick={toFreeLocation}>
                          {i18n.t('kbd1f8309')}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
              <div className="wm-row">
                <label className="wm-switch">
                  <input type="checkbox" checked={logo} onChange={(e) => setLogo(e.target.checked)} />
                  <span>{i18n.t('kebf7851c')}</span>
                </label>
                {logo && (
                  <Select
                    className="wm-sel"
                    value={brand}
                    // 换品牌后型号清单整个换了，旧型号留着只会写出「NIKON EOS R5」
                    onChange={(v) => {
                      if (v !== brand) setModel('');
                      setBrand(v);
                    }}
                    options={[
                      { value: 'auto', label: i18n.t('k501b93e9') },
                      ...(opt?.brands || []).map((b) => ({
                        value: b.key,
                        label: b.name,
                        group: b.group,
                      })),
                    ]}
                  />
                )}
              </div>
              {logo && brand === 'auto' && exif && !exif.make && !exif.model && (
                <p className="wm-tip">{i18n.t('k66957e60')}</p>
              )}
            </section>

            <section className="wm-sec">
              <h4>
                {i18n.t('k42c43485')} <em>{opt ? opt.watermarks.length : 0} 款</em>
              </h4>
              <div className="wm-styles">
                <button
                  className={`wm-style plain${styleNone ? ' on' : ''}`}
                  onClick={() => setStyle('none')}
                  title={i18n.t('k39fd910c')}
                >
                  <b>{i18n.t('k27d71a1e')}</b>
                  <i>{i18n.t('k5060ad9f')}</i>
                </button>
                {(opt?.watermarks || []).map((s) => {
                  const blocked = styleBlocked(s);
                  return (
                    <button
                      key={s.id}
                      className={`wm-style${style === s.id ? ' on' : ''}${blocked ? ' lack' : ''}`}
                      onClick={() => setStyle(s.id)}
                      title={blocked ? i18n.t('kc639d803', { p0: s.desc, p1: blocked }) : s.desc}
                    >
                      <b>{s.name}</b>
                      <i>{s.desc}</i>
                      {/* 只吃某几项信息（日期戳要时间、落款只排型号…）：勾选对不上时先标出来 */}
                      {blocked && <em className="wm-style-lack">{i18n.t('ke9068e91')}</em>}
                    </button>
                  );
                })}
              </div>
              {(() => {
                const s = opt?.watermarks.find((x) => x.id === style);
                if (!s || (!s.uses?.length && !s.needs?.length)) return null;
                const only = s.uses?.length ? s.uses.map(fieldLabel).join(' / ') : '';
                const need = s.needs?.length ? s.needs.map(fieldLabel).join(' / ') : '';
                return (
                  <p className="wm-hint">
                    这款样式
                    {need ? i18n.t('k26f0b6b4', { p0: need }) : ''}
                    {need && only ? '；' : ''}
                    {only ? i18n.t('kdbe87d7f', { p0: only }) : ''}
                    {styleBlocked(s) ? i18n.t('k2530e07d') : ''}
                  </p>
                );
              })()}
            </section>

            <section className="wm-sec">
              <h4>
                {i18n.t('k57a3875d')} <em>{opt ? opt.frames.length : 0} 款</em>
              </h4>
              <div className="wm-styles">
                <button
                  className={`wm-style plain${frameNone ? ' on' : ''}`}
                  onClick={() => setFrame('none')}
                  title={i18n.t('k2982f3b0')}
                >
                  <b>{i18n.t('kda9c71c9')}</b>
                  <i>{i18n.t('k572b454f')}</i>
                </button>
                {(opt?.frames || []).map((f) => (
                  <button
                    key={f.id}
                    className={`wm-style${frame === f.id ? ' on' : ''}`}
                    onClick={() => setFrame(f.id)}
                    title={f.desc}
                  >
                    <b>{f.name}</b>
                    <i>{f.desc}</i>
                  </button>
                ))}
              </div>
            </section>

            <section className="wm-sec">
              <h4>{i18n.t('k58fd75c1')}</h4>
              <div className="wm-slider">
                <span>{i18n.t('kfc55aff8')}</span>
                <input type="range" min={0.5} max={2} step={0.05} value={size} onChange={(e) => setSize(Number(e.target.value))} />
                <b>{Math.round(size * 100)}%</b>
              </div>
              <div className="wm-slider">
                <span>{i18n.t('kc9ede7da')}</span>
                <input type="range" min={0.2} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
                <b>{Math.round(opacity * 100)}%</b>
              </div>
              <div className="wm-row">
                <span className="wm-row-label">{i18n.t('k7ec907e7')}</span>
                <Select className="wm-sel" value={color} onChange={setColor} options={COLOR_OPTS} />
              </div>
              <div className="wm-row">
                <span className="wm-row-label">{i18n.t('ka2ed0418')}</span>
                <Select
                  className="wm-sel"
                  value={font}
                  onChange={setFont}
                  options={fontOptions}
                  title={i18n.t('k82ccbbf0')}
                />
                <button
                  className="btn ghost wm-font-scan"
                  onClick={rescanFonts}
                  disabled={fontScanning}
                  title={i18n.t('k573be648')}
                >
                  {fontScanning ? i18n.t('k68c15533') : i18n.t('k694fc5ef')}
                </button>
              </div>
              {sysFonts.length > 0 && (
                <p className="wm-hint">已识别本机 {sysFonts.length} 种字体，可在上面下拉里搜索选择。</p>
              )}
            </section>

            <section className="wm-sec">
              <h4>{i18n.t('k9b15e2d9')}</h4>
              <SaveModeBlock
                value={save}
                onChange={(p) => setSave((s) => ({ ...s, ...p }))}
                disabled={applying}
                count={ids.length}
                overwriteHint={i18n.t('kf97f8139', { p0: ids.length })}
              />
            </section>
          </div>
        </div>

        <div className="wm-foot">
          <span className={`wm-hint${err ? ' bad' : ''}`}>
            {err || i18n.t('kc0304744')}
          </span>
          <button className="btn sm ghost" disabled={applying} onClick={onClose}>
            {i18n.t('k625fb26b')}
          </button>
          <button className="btn sm" disabled={applying || (job?.running ?? false)} onClick={apply}>
            {applying ? i18n.t('kcf978c02') : ids.length > 1 ? i18n.t('kd9067042', { p0: ids.length }) : i18n.t('k5b0520a9')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
