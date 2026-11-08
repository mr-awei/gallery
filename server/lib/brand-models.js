// 品牌 → 常见 / 热门型号清单。
//
// 为什么要这份清单：EXIF 里的型号经常是「ILCE-7M4」「Canon EOS R5」「SM-G9910」这种
// 机器名，截图和导出图干脆一条都没有。水印上要写的是「SONY A7 IV」这种人看得懂的型号，
// 所以给用户一份可选清单，选完直接覆盖水印文本；清单里没有的再自己写（自定义型号）。
//
// 约定：
//   · 只写型号本体，不带品牌前缀 —— 渲染时拼成「品牌 + 型号」，也方便字标剥前缀；
//   · 每个品牌从新到旧排，头部是当季热门，靠后的经典机型保留（老图还在用）；
//   · key 必须和 watermark-meta.js 的 LOGO_BRANDS.key 对齐，测试会盯着这一点；
//   · 只收「自己做机身/手机/无人机」的品牌；纯镜头厂（蔡司/腾龙/福伦达/三阳）不收，
//     镜头型号交给面板里的「镜头」输入框；
//   · 新增机型只加字符串，不要带「已停产」之类的备注，水印会原样印出来；
//   · 每年 9–10 月是新机潮（苹果/华为/小米/OPPO/vivo 秋季发布会 + 三星年初发布会），
//     换季时把各品牌头部型号补一遍，别让用户在下拉里只能看到去年的机器。
//     最近一次核对：2026-11（iPhone 18 Pro/Pro Max、iPhone Duo、Galaxy S26 / Z Fold8、
//     Mate 90、Pura 90、小米 18 Pro、Find X10、X400 Pro、Magic8、Pixel 11、一加 16）。
export const BRAND_MODELS = {
  /* ---------------- 相机 ---------------- */
  canon: [
    'EOS R1', 'EOS R3', 'EOS R5 Mark II', 'EOS R5 C', 'EOS R5', 'EOS R6 Mark III', 'EOS R6 Mark II', 'EOS R6',
    'EOS R8', 'EOS R7', 'EOS R10', 'EOS R50 V', 'EOS R50', 'EOS R100', 'EOS RP', 'EOS R',
    '1D X Mark III', '1D X Mark II', '1D Mark IV', '5D Mark IV', '5D Mark III', '5DS R', '5DS',
    '6D Mark II', '6D', '7D Mark II', '90D', '80D', '77D', '850D', '800D', '250D', '200D Mark II', '100D',
    'M6 Mark II', 'M50 Mark II', 'M50', 'M200', 'M5',
    'PowerShot G7 X Mark III', 'PowerShot G5 X Mark II', 'PowerShot G1 X Mark III', 'PowerShot G9 X Mark II',
    'PowerShot SX70 HS', 'PowerShot SX740 HS', 'PowerShot V1', 'PowerShot V10', 'PowerShot ZOOM', 'IXUS 285 HS',
  ],
  nikon: [
    'Z9', 'Z8', 'Z7 II', 'Z7', 'Z6 III', 'Z6 II', 'Z6', 'Z5 II', 'Z5', 'Zf', 'Zfc', 'Z50 II', 'Z50', 'Z30',
    'D6', 'D5', 'D4S', 'D850', 'D810', 'D800E', 'D780', 'D750', 'D700', 'D610', 'D600',
    'D500', 'D7500', 'D7200', 'D7100', 'D5600', 'D5500', 'D5300', 'D3500', 'D3400',
    'Coolpix P1100', 'Coolpix P1000', 'Coolpix P950', 'Coolpix P900', 'Coolpix A1000', 'Coolpix B600',
    '1 V3', '1 J5',
  ],
  sony: [
    'A1 II', 'A1', 'A9 III', 'A9 II', 'A9', 'A7R V', 'A7R IV', 'A7R III', 'A7R II',
    'A7S III', 'A7S II', 'A7 IV', 'A7 III', 'A7 II', 'A7C II', 'A7C', 'A6700', 'A6600', 'A6500', 'A6400',
    'A6300', 'A6100', 'A6000', 'A5100', 'NEX-7', 'NEX-6', 'NEX-5T',
    'ZV-E1', 'ZV-E10 II', 'ZV-E10', 'ZV-1 II', 'ZV-1', 'ZV-1F',
    'FX3', 'FX30', 'FX6', 'FX9', 'VENICE 2', 'VENICE',
    'RX100 VII', 'RX100 VI', 'RX100 V', 'RX10 IV', 'RX10 III', 'RX1R III', 'RX1R II', 'RX1R', 'HX99', 'HX400V',
    'A99 II', 'A77 II', 'A68', 'A58',
    // 手机也归在索尼：EXIF 只写 Sony，型号里带 Xperia 才分得清是手机还是相机
    'Xperia 1 VII', 'Xperia 1 VI', 'Xperia 1 V', 'Xperia 1 IV', 'Xperia 1 III', 'Xperia 1 II',
    'Xperia 5 V', 'Xperia 5 IV', 'Xperia 5 III', 'Xperia 10 VII', 'Xperia 10 VI', 'Xperia 10 V',
    'Xperia PRO-I', 'Xperia PRO',
  ],
  fujifilm: [
    'GFX100 II', 'GFX100S II', 'GFX100S', 'GFX100RF', 'GFX100', 'GFX 50S II', 'GFX 50S', 'GFX 50R',
    'X-H2S', 'X-H2', 'X-H1', 'X-T5', 'X-T50', 'X-T4', 'X-T3', 'X-T30 III', 'X-T30 II', 'X-T30',
    'X-T20', 'X-T200', 'X-T100', 'X-S20', 'X-S10', 'X-Pro3', 'X-Pro2', 'X-Pro1',
    'X100VI', 'X100V', 'X100F', 'X100T', 'X100S', 'X100', 'X-E5', 'X-E4', 'X-E3', 'X-M5', 'X-A7', 'X-A5',
    'XF10', 'XQ2', 'FinePix S1', 'FinePix XP140', 'instax mini Evo', 'instax mini LiPlay', 'instax SQ6',
  ],
  leica: [
    'M11', 'M11 Monochrom', 'M11-P', 'M10-R', 'M10 Monochrom', 'M10', 'M10-P', 'M9', 'M9-P', 'M8', 'M-A', 'M7',
    'Q3', 'Q3 43', 'Q2', 'Q2 Monochrom', 'Q', 'SL3', 'SL3-S', 'SL2-S', 'SL2', 'SL', 'CL', 'TL2', 'T',
    'D-Lux 8', 'D-Lux 7', 'C-Lux', 'V-Lux 5', 'S3', 'S2',
  ],
  hasselblad: [
    'X2D II 100C', 'X2D 100C', '907X & CFV 100C', '907X 50C', 'X1D II 50C', 'X1D-50c',
    'H6D-100c', 'H6D-50c', 'H5D-60', 'H5D-50c', 'H4D-60', '503CW', '501CM', 'SWC/M',
  ],
  phaseone: ['XT IQ4 150MP', 'XF IQ4 150MP', 'IQ4 150MP', 'IQ3 100MP', 'IQ3 80MP', 'IQ2 60MP', 'P65+', '645DF+'],
  mamiya: [
    '645DF+', '645DF', '645 Pro TL', '645 AF', 'RZ67 Pro II', 'RZ67 Pro', 'RB67 Pro SD',
    'C330 Professional', '7 II', '6 MF',
  ],
  contax: ['645', 'N1', 'NX', 'G2', 'G1', 'T3', 'T2', 'T', 'RX', 'RTS III', 'AX', '167MT', 'Aria'],
  bronica: ['SQ-Ai', 'SQ-B', 'ETRSi', 'GS-1', 'RF645', 'S2A'],
  rollei: ['2.8F', '2.8GX', '3.5F', 'SL66', 'SL66 SE', '6008 Integral', '35S', '35T', 'Prego 90', 'Hy6 Mod2'],
  minolta: [
    'DYNAX 9', 'DYNAX 7D', 'DYNAX 5D', 'ALPHA 9', 'ALPHA 7 Digital', 'ALPHA Sweet',
    'X-700', 'X-500', 'XG-1', 'SRT-101', 'TC-1', 'DiMAGE 7Hi', 'DiMAGE A2',
  ],
  pentax: [
    'K-3 III Monochrome', 'K-3 III', 'K-1 II', 'K-1', 'KP', 'KF', 'K-70', 'K-50', 'K-5 IIs', 'K-5', 'K-3', 'K-30',
    '645Z', '645D', 'Q-S1', 'Q7', 'Q10', 'MX-1', 'WG-8', 'WG-90', 'LX', 'MX', '67 II', '67', '645',
  ],
  ricoh: [
    'GR IV', 'GR IIIx HDF', 'GR IIIx', 'GR III HDF', 'GR III', 'GR II', 'GR',
    'GR Digital IV', 'GR Digital III', 'Theta Z1', 'Theta X', 'Theta SC2', 'GXR', 'CX6',
  ],
  olympus: [
    'OM-1 Mark II', 'OM-1', 'OM-5', 'OM-3', 'E-M1 Mark III', 'E-M1 Mark II', 'E-M1X',
    'E-M5 Mark III', 'E-M5 Mark II', 'E-M10 Mark IV', 'E-M10 Mark III', 'E-P7', 'PEN-F', 'E-PL10', 'E-PL9',
    'TG-7', 'TG-6', 'TG-5', 'XZ-2', 'SH-2', 'Stylus 1',
  ],
  panasonic: [
    'S1R II', 'S1 II', 'S1 IIE', 'S1R', 'S1', 'S1H', 'S5 II', 'S5 IIX', 'S5', 'S9',
    'GH7', 'GH6', 'GH5 II', 'GH5S', 'GH5', 'GH4', 'G9 II', 'G9', 'G100', 'G95', 'GX9', 'GX85',
    'LX100 II', 'LX100', 'LX10', 'FZ2500', 'FZ1000 II', 'FZ300', 'TZ220',
  ],
  sigma: [
    'BF', 'fp L', 'fp', 'sd Quattro H', 'sd Quattro',
    'dp0 Quattro', 'dp1 Quattro', 'dp2 Quattro', 'dp3 Quattro',
    'DP1 Merrill', 'DP2 Merrill', 'DP3 Merrill',
  ],
  casio: [
    'EX-ZR5100', 'EX-ZR5000', 'EX-ZR4100', 'EX-ZR3600', 'EX-ZS170',
    'EX-TR100', 'EX-TR80', 'EX-TR60', 'EX-10', 'EX-100', 'EX-FR200', 'EX-FR100',
  ],
  kodak: ['PIXPRO AZ528', 'PIXPRO AZ652', 'PIXPRO AZ401', 'PIXPRO FZ55', 'PIXPRO FZ45', 'PIXPRO WPZ2', 'EKTAR H35N', 'EKTAR H35', 'M35', 'M38', 'Charmera'],
  polaroid: ['Now+', 'Now', 'OneStep 2', 'OneStep+', 'Go', 'Go Gen 2', 'Pop', 'SX-70', 'Impulse AF', 'Sun 660', '636 CloseUp', 'Lab'],
  lomography: ['LC-A+', 'LC-Wide', 'LomoApparat', 'Sprocket Rocket', 'Diana F+', 'Diana Baby 110', 'Holga 120N', 'Holga 135', 'Fisheye No.2', 'Belair X 6-12', 'Simple Use'],
  yashica: ['Mat-124G', 'Electro 35', 'Electro 35 GSN', 'FX-3', 'T4 Super', 'Minister D', 'Atoron'],

  /* ---------------- 手机 ---------------- */
  apple: [
    // 2026 秋：Pro 系列先行，Duo 是首款折叠（7.6 英寸内屏）
    '18 Pro Max', '18 Pro', '18', 'Duo',
    '17 Pro Max', '17 Pro', '17 Air', '17', '16 Pro Max', '16 Pro', '16 Plus', '16', '16e',
    '15 Pro Max', '15 Pro', '15 Plus', '15', '14 Pro Max', '14 Pro', '14 Plus', '14',
    '13 Pro Max', '13 Pro', '13 mini', '13', '12 Pro Max', '12 Pro', '12 mini', '12',
    '11 Pro Max', '11 Pro', '11', 'XS Max', 'XS', 'XR', 'X', '8 Plus',
    'SE (第 3 代)', 'SE (第 2 代)', 'SE (第 1 代)',
  ],
  samsung: [
    'S26 Ultra', 'S26+', 'S26', 'S26 Edge', 'S25 Ultra', 'S25 Edge', 'S25+', 'S25', 'S24 Ultra', 'S24+', 'S24 FE', 'S24',
    'S23 Ultra', 'S23+', 'S23 FE', 'S23', 'S22 Ultra', 'S22+', 'S22', 'S21 Ultra', 'S21+', 'S21 FE', 'S21',
    'S20 Ultra', 'S20+', 'S20', 'Note 20 Ultra', 'Note 10+',
    'Z Fold8 Ultra', 'Z Fold8', 'Z Flip8',
    'Z Fold7', 'Z Fold6', 'Z Fold5', 'Z Fold4', 'Z Fold3', 'Z Flip7', 'Z Flip6', 'Z Flip5', 'Z Flip4', 'Z Flip3',
    'A56', 'A55', 'A36', 'A35', 'A26', 'A16', 'A15', 'M56', 'M35', 'S10', 'S9', 'Note 9',
  ],
  huawei: [
    'Mate 90 RS 非凡大师', 'Mate 90 Pro Max', 'Mate 90 Pro', 'Mate 90',
    'Mate 80 Pro Max', 'Mate 80 RS 非凡大师', 'Mate 80 Pro', 'Mate 80',
    'Mate X7', 'Mate X6', 'Mate XTs', 'Mate XT', 'Mate X5', 'Mate X3',
    'Mate 70 Pro+', 'Mate 70 Pro', 'Mate 70 Air', 'Mate 70', 'Mate 60 Pro+', 'Mate 60 Pro', 'Mate 60', 'Mate 50 Pro', 'Mate 40 Pro+', 'Mate 40 Pro',
    'Pura 90', 'Pura 80 Ultra', 'Pura 80 Pro', 'Pura 80', 'Pura 70 Ultra', 'Pura 70 Pro+', 'Pura 70 Pro', 'Pura 70',
    'P60 Pro', 'P60', 'P50 Pro', 'P50', 'P40 Pro+', 'P40 Pro', 'P40',
    'nova 16 Ultra', 'nova 16z', 'nova 14 Ultra', 'nova 13 Pro', 'nova 12', 'nova 11',
  ],
  honor: [
    'Magic8 RSR 保时捷设计', 'Magic8 Pro Air', 'Magic8 Pro', 'Magic8',
    'Magic7 Pro', 'Magic7 RSR', 'Magic7', 'Magic6 Pro', 'Magic6', 'Magic V3', 'Magic V2', 'Magic V',
    'Magic5 Pro', '400 Pro', '400', '300 Pro', '300', '200 Pro', '200', '90 GT', '90',
    'X60 Pro', 'X60', 'X50', 'X40',
  ],
  xiaomi: [
    '18 Pro Max', '18 Pro', '18',
    '17 Pro Max', '17 Pro', '17', '15 Ultra', '15 Pro', '15', '14 Ultra', '14 Pro', '14',
    '13 Ultra', '13 Pro', '13', '12S Ultra', '12 Pro', '12', '11 Ultra', '11',
    'MIX Fold 4', 'MIX Fold 3', 'MIX Fold 2', 'MIX Flip 2', 'MIX Flip', 'MIX 4',
    'Civi 5 Pro', 'Civi 4 Pro', 'Civi 3',
  ],
  redmi: [
    'K90 Pro Max', 'K90', 'K80 Pro', 'K80', 'K70 Ultra', 'K70 Pro', 'K70', 'K60 Ultra', 'K60 Pro',
    'Note 15 Pro+', 'Note 15 Pro', 'Note 14 Pro+', 'Note 14 Pro', 'Note 14', 'Note 13 Pro',
    'Note 12 Turbo', 'Turbo 5', 'Turbo 4 Pro', 'Turbo 4', '14C', '13C',
  ],
  oppo: [
    'Find X10 Pro Max', 'Find X10', 'Find X10 E',
    'Find X9 Pro', 'Find X9', 'Find X8 Ultra', 'Find X8 Pro', 'Find X8', 'Find X8s', 'Find X7 Ultra', 'Find X7',
    'Find N5', 'Find N3', 'Find N3 Flip', 'Find N2', 'Find N2 Flip',
    'Reno15 Pro', 'Reno15', 'Reno14 Pro', 'Reno14', 'Reno13 Pro', 'Reno13', 'Reno12 Pro', 'Reno12',
    'A5 Pro', 'A5', 'K13', 'K12',
  ],
  vivo: [
    'X400 Pro', 'X400', 'X300s',
    'X300 Pro', 'X300', 'X300 Pro mini', 'X200 Ultra', 'X200 Pro', 'X200 Pro mini', 'X200', 'X200s',
    'X100 Ultra', 'X100 Pro', 'X100', 'X90 Pro+', 'X90 Pro', 'X80 Pro',
    'S30 Pro', 'S30', 'S20 Pro', 'S20', 'Y300 Pro+', 'Y300 Pro', 'Y200', 'Y100',
    'X Fold5', 'X Fold3 Pro', 'X Flip',
  ],
  iqoo: [
    '15', '15 Ultra', '13', '13 Neo', '12 Pro', '12', 'Neo11', 'Neo10 Pro+', 'Neo10 Pro', 'Neo10',
    'Z10 Turbo Pro', 'Z10 Turbo', 'Z9 Turbo', 'Z9', 'T4 Pro',
  ],
  oneplus: [
    '16', '15', '13', '13R', '12', '12R', '11', '11R', '10 Pro', '10T', '9 Pro',
    'Open 2', 'Open', 'Ace 6 Pro', 'Ace 6', 'Ace 5 Pro', 'Ace 5', 'Ace 3 Pro', 'Nord 5', 'Nord 4', 'Nord 3',
  ],
  realme: [
    'GT8 Pro', 'GT8', 'GT7 Pro', 'GT7', 'GT6', 'GT Neo6', 'GT Neo5', 'GT5 Pro',
    '14 Pro+', '14 Pro', '14', '13 Pro+', '13 Pro', '13', '12 Pro+', '12 Pro', '12',
    'P4 Ultra', 'P3 Ultra', 'P2 Pro',
  ],
  meizu: ['22', '22 Note', '21 Pro', '21 Note', '21', '20 Infinity', '20 Pro', '20', '18 Pro', '18', '17 Pro', '16s Pro'],
  nubia: [
    'Z80 Ultra', 'Z70 Ultra', 'Z70S Ultra', 'Z60 Ultra', 'Z60S Pro', 'Z50S Pro', 'Z50 Ultra',
    'Flip 2', 'Flip', 'Red Magic 11 Pro', 'Red Magic 10 Pro',
  ],
  zte: ['Axon 60 Ultra', 'Axon 50 Ultra', 'Axon 40 Ultra', 'Axon 30 Ultra', 'Axon 30 Pro', 'Blade V60', 'Blade V50'],
  motorola: [
    'Edge 70 Ultra', 'Edge 60 Ultra', 'Edge 60 Pro', 'Edge 50 Ultra', 'Edge 50 Pro', 'Edge 50',
    'Razr 60 Ultra', 'Razr 60', 'Razr 50 Ultra', 'Razr 50', 'Razr 40 Ultra', 'Razr 40',
    'ThinkPhone 25', 'ThinkPhone', 'Moto G85', 'Moto G75', 'Moto G64', 'Moto G54', 'Moto X50 Ultra', 'Moto E14',
  ],
  nokia: ['X30', 'X20', 'XR21', '8.3 5G', '8.1', '7.2', '6.2', '9 PureView', 'G60', 'C32'],
  google: [
    '11 Pro XL', '11 Pro', '11', '10 Pro XL', '10 Pro', '10', '9 Pro XL', '9 Pro', '9 Pro Fold', '9', '8 Pro', '8', '8a',
    '7 Pro', '7', '7a', '6 Pro', '6', '6a', '5', '5a', '4 XL', '4', '4a', '3 XL', 'Fold',
  ],
  lg: ['V60 ThinQ', 'V50 ThinQ', 'V40 ThinQ', 'G8 ThinQ', 'G7 ThinQ', 'Wing', 'Velvet', 'G6', 'K92'],
  htc: ['U24 Pro', 'U23 Pro', 'U23', 'U20 5G', 'Desire 22 Pro', 'Desire 21 Pro', 'Wildfire E5 Plus'],
  asus: [
    'Zenfone 12 Ultra', 'Zenfone 11 Ultra', 'Zenfone 10', 'Zenfone 9', 'Zenfone 8',
    'ROG Phone 9 Pro', 'ROG Phone 8 Pro', 'ROG Phone 8', 'ROG Phone 7 Ultimate', 'ROG Phone 6',
    'ROG Phone 5s', 'ROG Phone 3',
  ],
  lenovo: ['Legion Y90', 'Legion Y70', 'Legion Duel 2', 'Legion Duel', 'K14 Plus', 'K13'],
  nothing: ['Phone (3)', 'Phone (3a) Pro', 'Phone (3a)', 'Phone (2a) Plus', 'Phone (2a)', 'Phone (2)', 'Phone (1)', 'CMF Phone 2 Pro'],
  sharp: [
    'AQUOS R10', 'AQUOS R9 Pro', 'AQUOS R9', 'AQUOS R8 Pro', 'AQUOS R8', 'AQUOS R7', 'AQUOS R6',
    'AQUOS sense10', 'AQUOS sense9', 'AQUOS wish5',
  ],
  infinix: ['Zero 40', 'Zero Flip', 'Note 50 Pro', 'Note 40 Pro', 'GT 20 Pro', 'Hot 60 Pro', 'Hot 50 Pro'],
  tecno: ['Camon 40 Pro', 'Camon 30 Pro', 'Phantom X2 Pro', 'Pova 6 Pro', 'Spark 30 Pro', 'Spark 20 Pro'],
  lava: ['Agni 3', 'Agni 2', 'Blaze Curve', 'Yuva 4', 'Storm 5G'],

  /* ---------------- 无人机 / 运动相机 ---------------- */
  dji: [
    'Mavic 4 Pro', 'Mavic 3 Pro', 'Mavic 3 Classic', 'Mavic 3', 'Mavic 2 Pro',
    'Air 3S', 'Air 3', 'Air 2S', 'Mini 4 Pro', 'Mini 3 Pro', 'Mini 3', 'Mini 2',
    'Neo', 'Avata 2', 'Avata', 'Inspire 3',
    'Osmo Pocket 3', 'Osmo Action 5 Pro', 'Osmo Action 4', 'Osmo Action 3', 'Osmo Mobile 7P',
  ],
  insta360: ['X5', 'X4', 'X3', 'X2', 'ONE X2', 'ONE RS', 'ONE R', 'GO 3S', 'GO 3', 'Ace Pro 2', 'Ace Pro', 'Ace'],
  gopro: [
    'HERO 13 Black', 'HERO 12 Black', 'HERO 11 Black', 'HERO 11 Black Mini', 'HERO 10 Black',
    'HERO 9 Black', 'HERO 8 Black', 'MAX 2', 'MAX', 'Fusion', 'HERO 7 Black',
  ],
};

/** 某个品牌的型号清单（未知品牌给空数组，前端就只会剩输入框） */
export function modelsForBrand(key) {
  return BRAND_MODELS[key] ? [...BRAND_MODELS[key]] : [];
}
