import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type GeoProvince, type WatermarkOptions, type WatermarkParams } from '../api';
import type { EditJobStatus, ImageItem, WatermarkPreset } from '../types';
import Select, { type SelectOption } from './Select';
import SaveModeBlock, { SAVE_MODE_DEFAULT, type SaveModeState } from './SaveModeBlock';
import { downloadBlob } from '../lib/palette';
import { EMPTY_PLACE, cachedGeoRegions, composeLocation, guessPlace, loadGeoRegions, type Place } from '../lib/geo';
import { makePreset, mergePresets, parsePresetFile, presetFileText, sanitizePreset } from '../lib/watermark-preset';

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
  { value: 'auto', label: '跟随样式（自动反差）', group: '智能' },
  { value: 'light', label: '白色文字', group: '智能' },
  { value: 'dark', label: '深色文字', group: '智能' },
  { value: '#ffffff', label: '纯白', group: '常用色' },
  { value: '#f2f2f2', label: '浅灰', group: '常用色' },
  { value: '#9e9e9e', label: '中灰', group: '常用色' },
  { value: '#141414', label: '纯黑', group: '常用色' },
  { value: '#d4af37', label: '香槟金', group: '常用色' },
  { value: '#e8c37a', label: '浅金', group: '常用色' },
  { value: '#c0c8d0', label: '银灰', group: '常用色' },
  { value: '#ff5a5f', label: '珊瑚红', group: '常用色' },
  { value: '#4da3ff', label: '天蓝', group: '常用色' },
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
        onToast?.(`预设保存失败：${(e as Error).message || '未知错误'}`);
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
      onToast?.('给预设起个名字');
      return;
    }
    const made = makePreset(name, params);
    if (!made) {
      onToast?.('当前参数存不成预设（至少选一个水印或相框样式）');
      return;
    }
    const same = presets.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
    const next = same >= 0 ? presets.map((x, i) => (i === same ? { ...made, id: x.id } : x)) : [...presets, made];
    setSavingName(null);
    setPresetId(made.id);
    onToast?.(same >= 0 ? `已更新预设「${name}」` : `已保存预设「${name}」`);
    void persistPresets(next);
  };

  const removePreset = () => {
    const p = presets.find((x) => x.id === presetId);
    if (!p) return;
    setPresetId('');
    onToast?.(`已删除预设「${p.name}」`);
    void persistPresets(presets.filter((x) => x.id !== presetId));
  };

  const exportPresets = () => {
    if (!presets.length) {
      onToast?.('还没有预设可导出');
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(new Blob([presetFileText(presets)], { type: 'application/json' }), `水印预设-${stamp}.json`);
    onToast?.(`已导出 ${presets.length} 套预设`);
  };

  const importPresets = async (file: File) => {
    try {
      const { presets: incoming, skipped } = parsePresetFile(JSON.parse(await file.text()));
      if (!incoming.length) {
        onToast?.(skipped ? `文件里 ${skipped} 套预设都不完整，没有导入` : '文件里没有预设');
        return;
      }
      const { presets: next, added, replaced } = mergePresets(presets, incoming);
      await persistPresets(next);
      onToast?.(`导入完成：新增 ${added} 套${replaced ? `，覆盖同名 ${replaced} 套` : ''}${skipped ? `，跳过 ${skipped} 套` : ''}`);
    } catch (e) {
      onToast?.(`导入失败：${(e as Error).message || '文件读不出来'}`);
    }
  };

  /* 字体下拉：内置的「跟随样式」+ 服务端给的字体 + 本机 242 种系统字体（可搜索） */
  const fontOptions = useMemo(() => {
    const list: SelectOption[] = [{ value: 'auto', label: '跟随样式（推荐）' }];
    (opt?.fonts || []).forEach((f) => list.push({ value: f.key, label: f.name, group: '内置字体' }));
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
          return `要有${s.needs.map(fieldLabel).join(' / ')}才能排`;
        }
        return '';
      }
      if (!s.uses?.length) return '';
      if (s.uses.some((k) => usableFields.has(k))) return '';
      return `只排${s.uses.map(fieldLabel).join(' / ')}`;
    },
    [logoUsable, usableFields, fieldLabel]
  );

  /** 应用前的硬校验：这两个情况服务端也会拒，没必要先打一次请求 */
  const validate = useCallback((): string => {
    if (style === 'none' && frame === 'none') return '请至少选择一个水印样式或相框样式';
    if (style !== 'none' && fields.length === 0 && !logo) {
      return '一项信息都没选：请勾选要显示的拍摄信息，或打开「品牌 logo」';
    }
    const s = opt?.watermarks.find((x) => x.id === style);
    const blocked = s ? styleBlocked(s) : '';
    if (s && blocked) {
      return `「${s.name}」${blocked}，当前勾选的信息它排不出来：换一款样式，或改勾它支持的信息`;
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
      setErr('请至少选择一个水印样式或相框样式');
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
        .catch((e) => alive && setErr((e as Error).message || '预览失败'))
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

  /* 批量进度轮询（与批量裁切/调色同一套任务）：只在真的提交过批量任务时才开 */
  useEffect(() => {
    if (!open || !polling) return;
    const timer = window.setInterval(async () => {
      try {
        const s = await api.editJob();
        errCount.current = 0;
        setPollErr('');
        setJob(s);
        if (!s.running) {
          setPolling(false);
          setApplying(false);
          onDone?.();
          onToast?.(`水印完成：成功 ${s.done} 张${s.failed ? `，失败 ${s.failed} 张` : ''}`);
          onClose();
        }
      } catch (pollFailure) {
        // 连续读不到进度说明服务可能断了，别让面板一直假装在跑
        errCount.current += 1;
        if (errCount.current >= 3) setPollErr((pollFailure as Error).message || '无法连接服务');
      }
    }, 800);
    return () => window.clearInterval(timer);
  }, [open, polling, onDone, onToast, onClose]);

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
          r.copied ? `已另存到 ${r.savedPath || '指定目录'}` : `水印已应用（${r.width}×${r.height}）${r.note ? ` · ${r.note}` : ''}`
        );
        onDone?.(r.item);
        onClose();
      } else {
        const r = await api.batchEdit(ids, 'watermark', payload);
        setJob(r.job);
        setPolling(true);
        onToast?.(`开始为 ${ids.length} 张图加水印…`);
      }
    } catch (e) {
      setApplying(false);
      const msg = (e as Error).message || '水印合成失败';
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
          <b>水印 / 相框</b>
          <span className="wm-sub">
            {ids.length > 1 ? `批量处理 ${ids.length} 张（按同一套参数）` : '单张精修'}
          </span>
          <button className="btn sm ghost wm-close" disabled={applying} onClick={onClose} title="关闭">
            ✕
          </button>
        </div>

        <div className="wm-body">
          <div className="wm-preview">
            <div className="wm-stage">
              {preview ? <img src={preview} alt="水印预览" /> : <div className="wm-empty">选好样式后这里显示预览</div>}
              {(loading || applying) && (
                <div className="wm-stage-mask">
                  <span className="spinner" />
                  {applying ? '正在应用…' : '正在合成预览…'}
                </div>
              )}
              {note && !err && <div className="wm-stage-note">{note}</div>}
              {err && <div className="wm-stage-err">{err}</div>}
            </div>
            <div className="wm-preview-foot">
              <span>预览按长边 1400px 渲染，成品用原图分辨率</span>
              <span className="wm-tag">{ids.length > 1 ? `第 1 张 / 共 ${ids.length} 张` : '原图'}</span>
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
                  取消
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
                我的预设 <em>{presets.length} 套</em>
              </h4>
              <div className="wm-row">
                <Select
                  className="wm-sel"
                  value={presetId}
                  onChange={applyPreset}
                  options={
                    presets.length
                      ? [{ value: '', label: '选择一个预设套用…' }, ...presets.map((p) => ({ value: p.id, label: p.name }))]
                      : [{ value: '', label: '还没有保存过预设' }]
                  }
                  title="预设保存的是整套排版参数：样式、相框、信息项、品牌型号、字号颜色字体"
                />
                <button
                  className="btn sm ghost"
                  onClick={() => setSavingName(presets.find((p) => p.id === presetId)?.name || '')}
                  title="把当前这一套参数存成预设"
                >
                  保存
                </button>
                <button className="btn sm ghost" disabled={!presetId} onClick={removePreset}>
                  删除
                </button>
              </div>
              {savingName !== null && (
                <div className="wm-row">
                  <input
                    className="wm-input"
                    autoFocus
                    value={savingName}
                    maxLength={40}
                    placeholder="预设名字，如「白底商品 · 右下」"
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
                    保存
                  </button>
                  <button className="btn sm ghost" onClick={() => setSavingName(null)}>
                    取消
                  </button>
                </div>
              )}
              <div className="wm-row">
                <button className="btn sm ghost" onClick={() => importRef.current?.click()}>
                  导入预设
                </button>
                <button className="btn sm ghost" onClick={exportPresets}>
                  导出预设
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
              <p className="wm-hint">导出的是 JSON 文件，可以备份或发给别人；导入时同名预设会被覆盖。</p>
            </section>

            <section className="wm-sec">
              <h4>
                要显示的信息 <em>{fields.length} 项</em>
              </h4>
              <div className="wm-fields">
                {(opt?.fields || []).map((f) => {
                  const on = fields.includes(f.key);
                  const has = available(f.key);
                  return (
                    <label key={f.key} className={`wm-field${on ? ' on' : ''}${has ? '' : ' void'}`}>
                      <input type="checkbox" checked={on} onChange={() => toggleField(f.key)} />
                      <span>{f.label}</span>
                      {!has && <i title="这张图的 EXIF 里没有这一项">无</i>}
                    </label>
                  );
                })}
              </div>
              {/* 型号：EXIF 里的型号常常没有、或是 ILCE-7M4 这种机器名，
                  所以给一份「品牌常见型号」清单让用户选；清单外的点「自定义型号」手写 */}
              {fields.includes('camera') && (
                <>
                  <div className="wm-row">
                    <span className="wm-row-label">相机型号</span>
                    {modelFree ? (
                      <>
                        <input
                          className="wm-input"
                          value={model}
                          maxLength={60}
                          autoFocus
                          placeholder="直接写型号，如 ILCE-7M4"
                          onChange={(e) => setModel(e.target.value)}
                        />
                        <button
                          className="btn sm ghost"
                          title="回到型号清单"
                          onClick={() => {
                            setModelFree(false);
                            setModel('');
                          }}
                        >
                          列表
                        </button>
                      </>
                    ) : (
                      <Select
                        className="wm-sel"
                        value={modelValue}
                        onChange={pickModel}
                        options={[...modelOptions, { value: CUSTOM_MODEL, label: '✎ 自定义型号…' }]}
                        placeholder={available('camera') ? '留空则读 EXIF 型号' : '选一个型号'}
                        title="选定品牌后只列这个品牌的常见型号；清单里没有就选「自定义型号」自己写"
                        searchThreshold={20}
                      />
                    )}
                  </div>
                  {!modelFree && brand !== 'auto' && modelOptions.length === 0 && (
                    <p className="wm-tip">这个品牌没收录到型号，选「自定义型号」自己写即可。</p>
                  )}
                </>
              )}
              {/* 拍摄地点：省 → 市 → 区/县 三级选择，地名不在库里的可以切「手填」 */}
              {fields.includes('location') && (
                <>
                  {locFree ? (
                    <div className="wm-row">
                      <span className="wm-row-label">拍摄地点</span>
                      <input
                        className="wm-input"
                        value={location}
                        maxLength={80}
                        placeholder={available('location') ? '留空则读 EXIF' : '如：上海 · 外滩'}
                        onChange={(e) => setLocation(e.target.value)}
                      />
                      <button className="btn sm ghost" title="改用省/市/区选择" onClick={toPickLocation}>
                        选城市
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="wm-row">
                        <span className="wm-row-label">拍摄地点</span>
                        <Select
                          className="wm-sel"
                          value={place.province}
                          onChange={(v) => setPlacePart('province', v)}
                          options={provinceOptions}
                          placeholder="省份"
                          title="先选省份"
                        />
                        <Select
                          className="wm-sel"
                          value={place.city}
                          onChange={(v) => setPlacePart('city', v)}
                          options={cityOptions}
                          placeholder="城市"
                          disabled={!place.province}
                          title="再选城市"
                        />
                      </div>
                      {place.city && (
                        <div className="wm-row">
                          <Select
                            className="wm-sel"
                            value={place.district}
                            onChange={(v) => setPlacePart('district', v)}
                            options={districtOptions}
                            placeholder={districtOptions.length ? '区 / 县（可选）' : '区县（可手写详情）'}
                            title="第三级：区/县，选完还能在右边补详细地址"
                          />
                          <input
                            className="wm-input"
                            value={place.detail}
                            maxLength={40}
                            placeholder="详细地址（可选）"
                            onChange={(e) => setPlacePart('detail', e.target.value)}
                          />
                        </div>
                      )}
                      <div className="wm-row wm-loc-foot">
                        <p className="wm-hint">
                          水印上显示：<b>{location || '（还没选）'}</b>
                        </p>
                        <button className="btn sm ghost" title="地名不在列表里？直接手写" onClick={toFreeLocation}>
                          手填
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
              <div className="wm-row">
                <label className="wm-switch">
                  <input type="checkbox" checked={logo} onChange={(e) => setLogo(e.target.checked)} />
                  <span>显示品牌 logo</span>
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
                      { value: 'auto', label: '自动识别（按 EXIF 品牌）' },
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
                <p className="wm-tip">这张图的 EXIF 里没有品牌信息，自动识别会跳过 logo；可在右侧下拉里手动指定，或直接在「相机型号」里写上图里的机型。</p>
              )}
            </section>

            <section className="wm-sec">
              <h4>
                水印样式 <em>{opt ? opt.watermarks.length : 0} 款</em>
              </h4>
              <div className="wm-styles">
                <button
                  className={`wm-style plain${styleNone ? ' on' : ''}`}
                  onClick={() => setStyle('none')}
                  title="只要相框，不加水印"
                >
                  <b>不使用水印</b>
                  <i>只加相框时选这个</i>
                </button>
                {(opt?.watermarks || []).map((s) => {
                  const blocked = styleBlocked(s);
                  return (
                    <button
                      key={s.id}
                      className={`wm-style${style === s.id ? ' on' : ''}${blocked ? ' lack' : ''}`}
                      onClick={() => setStyle(s.id)}
                      title={blocked ? `${s.desc}（${blocked}，当前勾选的信息它用不上）` : s.desc}
                    >
                      <b>{s.name}</b>
                      <i>{s.desc}</i>
                      {/* 只吃某几项信息（日期戳要时间、落款只排型号…）：勾选对不上时先标出来 */}
                      {blocked && <em className="wm-style-lack">不含所选信息</em>}
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
                    {need ? `必须有：${need}` : ''}
                    {need && only ? '；' : ''}
                    {only ? `只排：${only}` : ''}
                    {styleBlocked(s) ? ' —— 当前勾选的信息都用不上，选了也出不来图' : ''}
                  </p>
                );
              })()}
            </section>

            <section className="wm-sec">
              <h4>
                相框样式 <em>{opt ? opt.frames.length : 0} 款</em>
              </h4>
              <div className="wm-styles">
                <button
                  className={`wm-style plain${frameNone ? ' on' : ''}`}
                  onClick={() => setFrame('none')}
                  title="不加相框"
                >
                  <b>不使用相框</b>
                  <i>原图尺寸不变时选这个</i>
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
              <h4>微调</h4>
              <div className="wm-slider">
                <span>字号</span>
                <input type="range" min={0.5} max={2} step={0.05} value={size} onChange={(e) => setSize(Number(e.target.value))} />
                <b>{Math.round(size * 100)}%</b>
              </div>
              <div className="wm-slider">
                <span>不透明度</span>
                <input type="range" min={0.2} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
                <b>{Math.round(opacity * 100)}%</b>
              </div>
              <div className="wm-row">
                <span className="wm-row-label">文字颜色</span>
                <Select className="wm-sel" value={color} onChange={setColor} options={COLOR_OPTS} />
              </div>
              <div className="wm-row">
                <span className="wm-row-label">字体样式</span>
                <Select
                  className="wm-sel"
                  value={font}
                  onChange={setFont}
                  options={fontOptions}
                  title="统一替换水印文字的字体；「本机字体」是本机已安装的全部字体，可搜索"
                />
                <button
                  className="btn ghost wm-font-scan"
                  onClick={rescanFonts}
                  disabled={fontScanning}
                  title="刚在系统里装完字体时点一下，重新扫描本机字体"
                >
                  {fontScanning ? '扫描中…' : '刷新'}
                </button>
              </div>
              {sysFonts.length > 0 && (
                <p className="wm-hint">已识别本机 {sysFonts.length} 种字体，可在上面下拉里搜索选择。</p>
              )}
            </section>

            <section className="wm-sec">
              <h4>保存方式</h4>
              <SaveModeBlock
                value={save}
                onChange={(p) => setSave((s) => ({ ...s, ...p }))}
                disabled={applying}
                count={ids.length}
                overwriteHint={`直接覆盖 ${ids.length} 张原图，可用「撤销」恢复。`}
              />
            </section>
          </div>
        </div>

        <div className="wm-foot">
          <span className={`wm-hint${err ? ' bad' : ''}`}>
            {err || '预览总会出图；这张图读不到信息时会提示原因，应用则不会生成空白水印'}
          </span>
          <button className="btn sm ghost" disabled={applying} onClick={onClose}>
            取消
          </button>
          <button className="btn sm" disabled={applying || (job?.running ?? false)} onClick={apply}>
            {applying ? '处理中…' : ids.length > 1 ? `应用到 ${ids.length} 张` : '应用'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
