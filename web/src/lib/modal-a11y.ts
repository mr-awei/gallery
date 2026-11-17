/**
 * 弹窗无障碍与键盘支持（document 级统一增强）。
 *
 * 全项目 25 个弹窗都是 `<div class="modal-backdrop"><div class="modal-card">…`，
 * 但只有 4 个自己绑了 Esc，没有一个做焦点陷阱 —— 纯键盘用户按几下 Tab 就跑到
 * 背后的页面上回不来了，读屏也报不出「这是一个对话框」。
 *
 * 与其在 25 处逐个补属性（改漏一处就退化，且新写的弹窗又会忘），
 * 这里在 document 层做一次统一增强：新增的 .modal-card 自动获得
 * role/aria-modal/标题无障碍名、打开即聚焦、Tab 在弹窗内循环、Esc 关闭，
 * 关闭后焦点回到打开它的那个元素。
 */

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface Entry {
  card: HTMLElement;
  /** 点它等价于「点空白关闭」；全屏预览类没有遮罩，为 null */
  backdrop: HTMLElement | null;
  /** 是否由本模块代按 Esc 关闭（组件自己处理 Esc 的全屏层设为 false，只做焦点陷阱） */
  esc: boolean;
  /** 打开弹窗前的焦点元素，关闭后还给它 */
  prev: HTMLElement | null;
}

/** 后进先出：多层弹窗（对话框叠在设置页上）时只增强最上面那层 */
const stack: Entry[] = [];
let started = false;

function focusables(card: HTMLElement): HTMLElement[] {
  const all = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
  // offsetParent 为空的是被 CSS 隐藏的（如 tab 面板里的另一页），不该进 Tab 序列
  return all.filter((el) => el.offsetParent !== null && !el.hasAttribute('inert'));
}

function titleOf(card: HTMLElement): string {
  // 大部分弹窗标题在 .modal-head；命令面板这类没有，退到第一个标题类元素，
  // 都没有就用空（此时读屏只能报「对话框」，至少比什么都不报强）
  const raw =
    card.querySelector('.modal-head')?.textContent ||
    card.querySelector('h1,h2,h3,h4,.cmd-title,.modal-title,[class*="title"]')?.textContent ||
    '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 40);
}

function enhance(
  card: HTMLElement,
  backdrop: HTMLElement | null,
  esc: boolean,
  focusFirst = true
) {
  if (stack.some((e) => e.card === card)) return;
  if (!card.hasAttribute('role')) card.setAttribute('role', 'dialog');
  if (!card.hasAttribute('aria-modal')) card.setAttribute('aria-modal', 'true');
  if (!card.hasAttribute('aria-label') && !card.hasAttribute('aria-labelledby')) {
    const title = titleOf(card);
    if (title) card.setAttribute('aria-label', title);
  }
  // 卡片自身可聚焦：弹窗里一个可聚焦元素都没有时（纯展示），焦点也得落在弹窗上
  if (!card.hasAttribute('tabindex')) card.tabIndex = -1;

  const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  stack.push({ card, backdrop, esc, prev });

  // 打开就把焦点送进去，否则键盘用户还在背后列表里 Tab。
  // 全屏预览（灯箱/叠图）落在容器本身而不是第一个按钮：
  // 预览里空格是播放暂停、方向键是切图，焦点停在「关闭」按钮上会被按钮吞掉。
  const first = focusFirst ? focusables(card)[0] : null;
  (first || card).focus({ preventScroll: true });
}

/** 弹窗被卸载后出栈，并把焦点还给打开它的元素 */
function reconcile() {
  for (let i = stack.length - 1; i >= 0; i--) {
    const e = stack[i];
    if (e.card.isConnected) continue;
    stack.splice(i, 1);
    const active = document.activeElement;
    // 严格模式/连续切换时可能已经打开了另一个弹窗，那种情况不抢焦点
    const inAnotherDialog =
      active instanceof HTMLElement &&
      !!active.closest('.modal-card, [data-a11y-dialog]');
    if (!inAnotherDialog && e.prev && e.prev.isConnected) e.prev.focus({ preventScroll: true });
  }
}

function onKeyDown(e: KeyboardEvent) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    // 弹窗自己处理过 Esc（preventDefault / stopPropagation）就别再关一次
    if (e.defaultPrevented) return;
    // 下拉/富文本里的 Esc 是「收起候选或退出编辑」，不该顺手把整个弹窗关掉；
    // 普通文本框里按 Esc 仍然关弹窗（和系统对话框一致）
    const el = document.activeElement;
    if (el instanceof HTMLElement && (el.tagName === 'SELECT' || el.isContentEditable)) return;
    // 全屏预览类自己处理 Esc（还要考虑「正在编辑时先退出编辑」），这里不代按
    if (!top.esc || !top.backdrop) return;
    e.preventDefault();
    // 各弹窗的遮罩都绑了 onClick={onClose}，点它等价于用户点空白处关闭
    top.backdrop.click();
    return;
  }
  if (e.key !== 'Tab') return;
  const items = focusables(top.card);
  if (!items.length) {
    e.preventDefault();
    top.card.focus({ preventScroll: true });
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (!active || !top.card.contains(active)) {
    e.preventDefault();
    first.focus({ preventScroll: true });
    return;
  }
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function scan() {
  document.querySelectorAll<HTMLElement>('.modal-backdrop').forEach((backdrop) => {
    const card = backdrop.querySelector<HTMLElement>('.modal-card');
    if (card) enhance(card, backdrop, true);
  });
  // 全屏预览/自定义遮罩（灯箱、叠图查看器、对比视图…）只需焦点陷阱与对话框语义，
  // Esc 由组件自己处理；用 data-a11y-dialog 标记，元素自身即对话框容器。
  document.querySelectorAll<HTMLElement>('[data-a11y-dialog]').forEach((el) => {
    // data-a11y-dialog="esc"：元素自己绑了「点空白关闭」，Esc 代它点一下即可
    const byEscape = el.dataset.a11yDialog === 'esc';
    enhance(el, byEscape ? el : null, byEscape, false);
  });
  reconcile();
}

/** 只装一次；重复调用无副作用（React 严格模式会执两次 effect） */
export function installModalA11y() {
  if (started || typeof document === 'undefined') return;
  started = true;
  scan();
  let queued = false;
  const mo = new MutationObserver(() => {
    // 用微任务合并同一帧内的多次变动（列表刷新时子树变动非常密集）
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      scan();
    });
  });
  mo.observe(document.body, { childList: true, subtree: true });
  // capture：弹窗内部的 stopPropagation 不该影响全局的 Esc/Tab 兜底
  document.addEventListener('keydown', onKeyDown, true);
}
