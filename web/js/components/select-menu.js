/* ==========================================================================
   AIbum · 下拉选择（设计系统 .menu 的选择形态）
   web/js/components/select-menu.js
   --------------------------------------------------------------------------
   为什么有这个文件：用户反馈「这些菜单没有和风格统一」——应用里的下拉一直是**原生
   `<select>`**，`.select { appearance: none }` 只改掉了**收起状态**的外观，展开的系统
   弹层改不动（系统蓝底方角），与设计系统割裂。设计系统的 `.menu`（components.css
   §11）本来就带齐 `role=menu` / `menuitemradio` / `aria-checked` / `aria-expanded`
   契约，缺的只是"把它当选择器用"的这一层。

   本文件 = 原生 `<select>` 的**最小可替换形态**：把 `.value` 换成 `getValue()/setValue()`，
   其余（哪一项被选中、点选后回调、禁用）与 select 同形，于是视图里的读写点几乎不用改。

     DOM 形状（每处一致，验收脚本因此可以用同一个选择器）：
       <div class="selectmenu" id="<id>">                 ← 视图样式挂在它上面
         <div class="menu__wrap">
           <button class="btn selectmenu__trigger" aria-haspopup="menu"
                   aria-expanded="false" aria-labelledby="<id>-label">…文字 + ⌄</button>
           <div class="menu selectmenu__menu" role="menu" aria-labelledby="<id>-label">
             <button class="menu__item" role="menuitemradio" aria-checked="true|false" data-value="…">
               <span class="selectmenu__option">标签</span><span class="menu__mark" aria-hidden="true">✓</span>
             </button>
             …
           </div>
         </div>
       </div>

   键盘：**全部交给 menu.js**（↑↓ / Home / End / Esc / typeahead / 关闭后焦点归还），
   本文件不重复实现一遍——两份实现必然漂移。这也是 menu.js 文件头写下的理由。

   重复提交（本卡的硬要求）：**同一个值再点一次不算变化**，不回调也不发 change。
   理由：原生的 `change` 只在值真的变了才触发；换成一堆可点的 `menuitemradio` 之后，
   点"当前这一项"会照样触发一次回调 —— 直接接到 `store.setFilter(...)` 上就是一次多余
   的列表请求（重放检索时更贵：一次 multipart 检索）。
   视图侧还有第二道闸（比对 store 里已有的值），见 library.js 的 applyFilterValue。

   怎么知道"值变了"（两种都行，回调先发）：
     · `control.onChange = (value) => …`  ← 推荐。payload 里是新值本身
     · `control.trigger.addEventListener('change', …)`  ← 可当原生 <select> 用，
       但**事件不冒泡**，必须挂在 trigger 上（挂到外层 `.selectmenu` 上收不到，实测踩过）

   不做什么：没有任何内联样式/脚本（CSP §0A E1）、不碰 localStorage、不发请求、
   不碰 document 的全局状态。要在 node 里单测时，把 `h`（用 jsdom 的 document 建元素）
   与 `document`（键盘层用它听文档级的点击 / Esc）一起注入即可 —— 默认都走全局。
   ========================================================================== */

import { h as defaultH } from './dom.js';
import { createMenu } from './menu.js';

/** 触发按钮上的箭头（设计系统的 .menu__caret；由 [aria-expanded="true"] 旋转 180°）。 */
const CARET = '⌄';

/**
 * 建一个 `.menu` 形态的下拉选择。
 *
 * @param {{
 *   id?: string,
 *   options?: Array<{value: string|number, label: string}>,
 *   value?: string|number|null,
 *   label?: string,                      // 触发按钮的名字（没有可见 <label> 时用；无 labelledBy 时生效）
 *   labelledBy?: string,                 // 可见 <label> / <span class="label"> 的 id（优先于 label）
 *   dataRole?: string,                   // data-role 属性（沿用旧 DOM 的选择器）
 *   triggerClass?: string,               // 附加到触发按钮的类（如 selectmenu__trigger--sm）
 *   className?: string,                  // 附加到最外层容器的类
 *   disabled?: boolean,
 *   onChange?: (value: string, option: {value:string,label:string}|null) => any,
 *   h?: typeof defaultH,                  // 建元素（单测注入 jsdom 版的 h）
 *   document?: Document,                  // 交给 menu.js 的文档级监听（单测注入）
 *   menuFactory?: typeof createMenu,     // 单测注入点
 * }} [options]
 * @returns {{
 *   element: HTMLElement, trigger: HTMLButtonElement, menu: HTMLElement,
 *   getValue(): string, setValue(value: any): string,
 *   getLabel(): string, setOptions(options: Array<object>, opts?: {keepValue?: string|boolean}): void,
 *   get disabled(): boolean, set disabled(next: boolean): void,
 *   open(): void, close(): void, isOpen(): boolean,
 *   optionValues(): string[],
 * }}
 */
export function createSelectMenu(options = {}) {
  const h = options.h || defaultH;
  const menuFactory = options.menuFactory || createMenu;

  const id = options.id || '';
  /* 可及名字的来源：
       ① 调用方给了 labelledBy  → 用那个（'<id>-label' 约定下视图会渲染 <span class="label" id="...">）
       ② 调用方给了 label       → 直接用 <label> 的文案当 aria-label
       ③ 都没有                 → 由当前值兜底（见 renderLabel）
     **绝不**默认拼 `${id}-label`：那个元素不一定存在，会留下一个指向空气的 aria-labelledby
     （B 版探针实测：batch-album 的 label_text 是 null）。 */
  const labelledBy = options.labelledBy || '';
  const triggerClassName = ['btn', 'selectmenu__trigger', options.triggerClass].filter(Boolean).join(' ');
  const menuClassName = ['menu', 'selectmenu__menu'].filter(Boolean).join(' ');
  const rootClassName = ['selectmenu', options.className].filter(Boolean).join(' ');

  /** 当前值恒为字符串（与 `el.value` 一致：select 的 value 也是字符串）。 */
  let value = options.value === undefined || options.value === null ? '' : String(options.value);
  let items = [];                       // 已呈现的条目（getLabel / setValue 用）
  /* 值变化回调。**故意不直接读 options.onChange**：视图习惯在控件建好之后才挂上去
     （`control.onChange = …`），读构造参数会让那次赋值静默失效（第一版就是这么错的：
     点条目只改了触发按钮的文字，store 与请求都没动）。 */
  let notify = typeof options.onChange === 'function' ? options.onChange : null;

  const labelNode = h('span', { className: 'selectmenu__label' });
  const caret = h('span', { className: 'menu__caret', 'aria-hidden': 'true', text: CARET });

  const triggerAttrs = {
    className: triggerClassName,
    type: 'button',
    'data-role': 'selectmenu-trigger',
  };
  if (id) triggerAttrs.id = id;
  if (options.dataRole) triggerAttrs['data-role'] = options.dataRole;
  if (labelledBy) triggerAttrs['aria-labelledby'] = labelledBy;
  const trigger = h('button', triggerAttrs, [labelNode, caret]);

  const menuAttrs = { className: menuClassName, role: 'menu' };
  if (labelledBy) menuAttrs['aria-labelledby'] = labelledBy;
  const menu = h('div', menuAttrs);

  const wrap = h('div', { className: 'menu__wrap' }, [trigger, menu]);
  const element = h('div', { className: rootClassName }, [wrap]);

  /* ---------- 值 ---------- */

  function findOption(next) {
    const text = next === undefined || next === null ? '' : String(next);
    return items.find(item => item.value === text) || null;
  }

  function getValue() {
    return value;
  }

  function getLabel() {
    const hit = findOption(value);
    return hit ? hit.label : '';
  }

  /** 同步触发按钮上的文字（选中的那一项的 label；没有则留空）。 */
  function renderLabel() {
    const text = getLabel();
    if (labelNode.textContent !== text) labelNode.textContent = text;
    // 没有可见 <label> 时给一个可及名字；有的话交给 aria-labelledby。
    if (labelledBy) trigger.removeAttribute('aria-label');
    else trigger.setAttribute('aria-label', text || options.label || '选择');
  }

  /** 程序化设值：找得到才生效（与 select 不同 **不回退到第一项**，找不到就当没有）。 */
  function setValue(next) {
    const hit = findOption(next);
    value = hit ? hit.value : '';
    for (const item of items) {
      item.node.setAttribute('aria-checked', item.value === value ? 'true' : 'false');
    }
    renderLabel();
    return value;
  }

  /* ---------- 选项 ---------- */

  function makeOption(option) {
    const optionValue = option.value === undefined || option.value === null ? '' : String(option.value);
    const label = option.label === undefined || option.label === null ? '' : String(option.label);
    const mark = h('span', { className: 'menu__mark', 'aria-hidden': 'true', text: '✓' });
    const node = h('button', {
      className: 'menu__item',
      type: 'button',
      role: 'menuitemradio',
      'aria-checked': 'false',
      'data-value': optionValue,
    }, [h('span', { className: 'selectmenu__option', text: label }), mark]);
    node.addEventListener('click', () => {
      if (node.disabled) return;
      // 同值不回调（见文件头"重复提交"）
      if (optionValue === value) return;      value = optionValue;
      // 面板已经被 menu.js 关掉了（它接管 menu 上的 click）——这里只同步选中态。
      for (const item of items) {
        item.node.setAttribute('aria-checked', item.value === value ? 'true' : 'false');
      }
      renderLabel();
      /* 回调是**属性**读的（不是构造时固化的）：视图可以在建好之后再挂 onChange
         （library.js 的 albumFilter.onChange = … 就是这么接的）。 */
      if (typeof notify === 'function') notify(value, { value: optionValue, label });
      /* 另外仍发一个 change 事件（在**触发按钮**上），让视图可以像用原生 <select> 一样
         只监听 `change`。注意事件不冒泡：必须监听 trigger（或 .selectmenu__trigger），
         监听到外层 .selectmenu 上是收不到的（F18 验收实测踩过）。
         用 dispatchEvent 的返回值判断是否被 preventDefault，尊重监听方的取消。 */
      const ok = trigger.dispatchEvent(new Event('change', { bubbles: false, cancelable: true }));
      if (!ok) return;
    });
    return { node, value: optionValue, label, option };
  }

  /**
   * 重建选项（`renderAlbumOptions` 每次拿回相册列表都要调）。
   * @param {Array<{value:any,label:string}>} next
   * @param {{keepValue?: boolean|string}} [opts] keepValue 为 string 时用它当"期望保留的值"；
   *        否则用当前 value。保留的值若已不在新列表里 → 归零（与旧 `fillAlbumSelect` 同语义）。
   */
  function setOptions(next, opts = {}) {
    const expected = typeof opts.keepValue === 'string' ? opts.keepValue : value;
    const list = Array.isArray(next) ? next : [];
    items = list.map(makeOption);
    menu.replaceChildren(...items.map(item => item.node));
    if (!items.length) {
      // 没有可选项时不留一个空面板：给一行只读说明（与视图里"暂无匹配标签"同思路）
      menu.append(h('div', { className: 'menu__status', 'data-role': 'selectmenu-empty', text: '暂无可选项' }));
    }
    setValue(expected);
    return items;
  }

  /* ---------- 禁用 ---------- */

  Object.defineProperty(element, 'disabled', {
    configurable: true,
    get() { return trigger.disabled; },
    set(next) { trigger.disabled = Boolean(next); },
  });

  /* ---------- 键盘层（menu.js） ---------- */

  const controller = menuFactory({ trigger, menu, document: options.document });

  /* ---------- 组装 ---------- */

  setOptions(options.options, { keepValue: value });
  if (options.disabled) trigger.disabled = true;

  return {
    element,
    trigger,
    menu,
    getValue,
    setValue,
    getLabel,
    setOptions,
    optionValues: () => items.map(item => item.value),
    open: () => controller.open(),
    close: (opts) => controller.close(opts),
    isOpen: () => controller.isOpen(),
    get disabled() { return trigger.disabled; },
    set disabled(next) { trigger.disabled = Boolean(next); },
    /** 值变化回调（可直接赋值；见文件头的"怎么知道值变了"）。 */
    get onChange() { return notify; },
    set onChange(fn) { notify = typeof fn === 'function' ? fn : null; },
  };
}

export default { createSelectMenu };
