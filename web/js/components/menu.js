/* ==========================================================================
   AIbum · 下拉菜单键盘层  web/js/components/menu.js
   --------------------------------------------------------------------------
   设计系统的 `.menu`（css/components.css 598-731）**只有样式与 ARIA 契约**，
   没有一行脚本：哪些属性、哪些键该干什么，全都要调用方自己接。这里把那份契约
   收成一处，F17 是第一个用户（顶栏账号面板）。

   契约（components.css 的用法注释 + docs/前端-行为清单.md §0A 的浮层纪律）：
     触发按钮  aria-haspopup="menu" + aria-expanded="false"
     面板      .menu + role="menu"（靠 .menu[data-open="true"] 显示）
     条目      .menu__item + role="menuitem" / "menuitemradio"

   本模块负责（F17 硬验收 ①）：
     打开    点触发按钮 / ↓ / ↑ / Enter / 空格
     走条目  ↑ ↓ Home End（只走 [role^="menuitem"]、跳过 disabled 与 aria-busy）
     typeahead  可打印字符跳条目（设计系统的 `.menu` 文档里没写，但它是 role=menu 的常规行为）
     关闭    Esc / 点面板外 / 点条目 / 调用方 close()
     焦点    **关闭后归还触发按钮**（Esc 与点面板外两条路径都归还）
     Tab     不拦：它是"离开菜单"，浏览器默认行为即可

   为什么要建这个文件而不是在 app.js 里写：`.menu` 的另一张落实卡（5 处原生
   `<select>` → `.menu`）需要同一套键位；两份实现迟早漂移。

   不做什么：没有任何内联样式/脚本（CSP §0A E1）、不碰 localStorage、不碰网络。
   本文件不碰 document / window 的全局状态，可在 node 里直接 import 做单测。
   ========================================================================== */

/** 面板里"可走"的条目：菜单项角色、未禁用、不忙。 */
export const ITEM_SELECTOR = '[role^="menuitem"]';

const isDisabled = item =>
  item.disabled === true ||
  item.getAttribute('aria-disabled') === 'true' ||
  item.getAttribute('aria-busy') === 'true';

/** 当前获得焦点的元素（常规是 document.activeElement；影子根下退回根节点）。 */
function activeElement() {
  if (typeof document !== 'undefined' && document.activeElement) return document.activeElement;
  return menu.getRootNode().activeElement;
}

/** 按 DOM 顺序列出当前可走的条目（样式上不可见的也要滤掉：display:none 的条目不该被焦点走到）。 */
export function enabledItems(menu) {
  return Array.from(menu.querySelectorAll(ITEM_SELECTOR)).filter(item => {
    if (isDisabled(item)) return false;
    // offsetParent 对 position:fixed 恒为 null（§0A 的教训），所以用矩形 + display 判可见
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(item) : null;
    if (style && style.display === 'none') return false;
    const rect = typeof item.getBoundingClientRect === 'function' ? item.getBoundingClientRect() : null;
    return !rect || rect.width > 0;
  });
}

/** 可打印字符（typeahead 用；修饰键组合与空格不算）。 */
function printableChar(event) {
  if (event.ctrlKey || event.altKey || event.metaKey) return '';
  const key = event.key;
  if (typeof key !== 'string' || key.length !== 1) return '';
  return key.trim() ? key : '';
}

/**
 * 装配一个 .menu 下拉。
 * @param {{
 *   trigger: HTMLElement,
 *   menu: HTMLElement,
 *   onOpen?: () => void,
 *   onClose?: () => void,
 *   restoreFocus?: boolean,
 *   document?: Document,
 * }} options
 */
export function createMenu(options) {
  const { trigger, menu } = options;
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const restoreFocus = options.restoreFocus !== false;

  let open = false;
  let typed = '';          // typeahead 缓冲
  let typedTimer = 0;

  function isOpen() {
    return open;
  }

  /** 焦点进面板：优先"记忆中的那个条目"，没有就第一条。 */
  function focusItem(index = 0) {
    const items = enabledItems(menu);
    if (!items.length) return null;
    const bounded = ((index % items.length) + items.length) % items.length;
    items[bounded].focus();
    return items[bounded];
  }

  function openMenu({ focus = 'first' } = {}) {
    if (open) return;
    open = true;
    trigger.setAttribute('aria-expanded', 'true');
    menu.setAttribute('data-open', 'true');
    if (focus === 'first') focusItem(0);
    else if (focus === 'last') focusItem(-1);
    if (typeof options.onOpen === 'function') options.onOpen();
  }

  /**
   * 关面板。
   * @param {{restoreFocus?: boolean}} [opts] 默认归还焦点给触发按钮
   */
  function closeMenu(opts = {}) {
    if (!open) return;
    open = false;
    trigger.setAttribute('aria-expanded', 'false');
    menu.removeAttribute('data-open');
    typed = '';
    const giveBack = opts.restoreFocus !== undefined ? opts.restoreFocus : restoreFocus;
    // 归还焦点只在两种情况下做：
    //   ① 触发按钮还看得见（登出后面板与按钮一起消失，聚焦 hidden 元素等于把焦点丢给 body）
    //   ② **焦点没被别人拿走**。这一条是实测出来的：焦点在面板里时，同一个点击会依次触发
    //      「条目自己的监听」与「面板的监听」，如果条目打开了一个浮层，浮层已经把焦点移进对话框，
    //      面板再 focus() 一次就把焦点从对话框里**拽回顶栏按钮**——屏幕阅读器与 Tab 用户于是
    //      停在对话框外面（一次真实回归：从面板点「账户安全」，activeElement 变成了头像按钮）。
    //      native <dialog> 的 WAI-ARIA 菜单模式里，菜单关闭后焦点应停在触发按钮；打开浮层的场合
    //      则由浮层接管，两者不冲突。
    const active = doc ? doc.activeElement : null;
    const mine = !active || active === trigger || menu.contains(active) || active === doc.body;
    if (giveBack && !trigger.hidden && mine) trigger.focus();
    if (typeof options.onClose === 'function') options.onClose();
  }

  /* ---------- 触发按钮 ---------- */

  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');

  trigger.addEventListener('click', event => {
    event.stopPropagation();          // 别让文档级的"点外面就关"当场把它关回去
    if (open) closeMenu();
    else openMenu();
  });

  // ↓ / ↑ 在触发按钮上也能开（role=menu 的常规键位）：↓ 从第一条起，↑ 从最后一条起。
  // Enter / 空格不在这里处理 —— 原生 <button> 的 click 已经覆盖，重复处理会开了又关。
  trigger.addEventListener('keydown', event => {
    if (open) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openMenu({ focus: 'first' });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu({ focus: 'last' });
    }
  });

  /* ---------- 面板内的键盘 ---------- */

  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      // 停在这里：不让 Esc 冒泡出去把底下的对话框/侧栏也关掉
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      return;
    }

    const items = enabledItems(menu);
    if (!items.length) return;
    const index = items.indexOf(activeElement());

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItem(index < 0 ? 0 : index + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(index < 0 ? items.length - 1 : index - 1);
        return;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        return;
      case 'End':
        event.preventDefault();
        focusItem(items.length - 1);
        return;
      default:
        break;
    }

    const char = printableChar(event);
    if (!char) return;                  // Tab / 功能键：交给浏览器
    typed += char.toLowerCase();
    clearTimeout(typedTimer);
    typedTimer = setTimeout(() => { typed = ''; }, 600);
    const hit = items.find(item => (item.textContent || '').trim().toLowerCase().startsWith(typed));
    if (hit) {
      event.preventDefault();
      hit.focus();
    }
  });

  // 点条目：选中即收（关闭逻辑在文档级监听里统一做，这里不拦）
  menu.addEventListener('click', event => {
    const item = event.target.closest(ITEM_SELECTOR);
    if (!item || isDisabled(item)) return;
    closeMenu();
  });

  /* ---------- 外面：点一下 / Esc ---------- */

  doc.addEventListener('click', event => {
    if (!open) return;
    if (menu.contains(event.target) || trigger.contains(event.target)) return;
    closeMenu();
  });

  doc.addEventListener('keydown', event => {
    if (!open || event.key !== 'Escape') return;
    // 面板里的 Esc 已经在上面处理过（stopPropagation），走到这里说明焦点不在面板里
    closeMenu();
  });

  return {
    isOpen,
    open: openMenu,
    close: closeMenu,
    toggle: () => (open ? closeMenu() : openMenu()),
    focusItem,
    elements: { trigger, menu },
  };
}

export default { createMenu, enabledItems, ITEM_SELECTOR };
