/**
 * App 拆分后各 hook / 组件共用的几个小类型。
 * 只放「签名」不放逻辑，避免各文件各自声明一份同形不同名的回调类型。
 */
export type Toast = (msg: string, kind?: 'info' | 'error') => void;

/** 图库列表加载：page 从 1 起，reset=true 表示替换而不是追加 */
export type LoadGallery = (page: number, reset: boolean) => Promise<void>;
