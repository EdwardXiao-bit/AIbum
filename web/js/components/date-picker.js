/* ==========================================================================
   AIbum · 日期选择（设计系统 .datepicker / .popover.calendar / .cal__*）
   web/js/components/date-picker.js
   --------------------------------------------------------------------------
   为什么有这个文件：审计（docs/设计系统落实差距.md）里「`.cal` / `calendar` / `datepicker`
   14 类、六态」在应用里**一次都没用过** —— 筛选栏的两个日期一直是**原生 `<input type=date>`**，
   后果就是用户反馈 ⑦：桌面侧栏里「日」被浏览器自带的「年/月/日」+ 右侧日历图标挤掉
   （F9 之后实测：框 104px，而"文本 56.77 + 内边距 32 + 边框 2 + 图标预留 24" ≈ 114.8px 才够）。

   本文件 = 那个原生控件的**最小可替换形态**，形状与 select-menu.js（F18）刻意保持一致：
     · 读写入口是 `getValue()/setValue()`，与 `input.value` 同形（值恒为 ISO `YYYY-MM-DD`，
       与旧的原生日期框**逐字同格式**，所以筛选参数、store、后端都不用动）
     · `control.onChange = (value) => …` 通知"用户改了值"；程序化 setValue **不**通知
       （与原生 change、与 select-menu 同一约定）

     DOM 形状（每处一致，验收脚本因此可以用同一个选择器）：
       <div class="datepicker" data-role="datepicker">
         <input class="input datepicker__input" id="…" type="text" readonly
                placeholder="选择日期" data-role="…">
         <button class="input__affix" type="button" aria-haspopup="dialog"
                 aria-expanded="false" aria-controls="<id>-cal" data-role="datepicker-toggle">▦</button>
         <div class="popover calendar" id="<id>-cal" role="dialog" aria-label="…"
              data-role="datepicker-pop">
           <div class="cal__head">
             <button class="cal__nav" data-nav="-1" aria-label="上个月">‹</button>
             <span class="cal__title" aria-live="polite">2026 年 9 月</span>
             <button class="cal__nav" data-nav="1" aria-label="下个月">›</button>
           </div>
           <div class="cal__dow" aria-hidden="true"><span>一</span>…<span>日</span></div>
           <div class="cal__grid" role="grid">
             <button class="cal__day" data-value="2026-09-12" tabindex="0|−1"
                     aria-selected="true" | data-in-range="true" | data-outside="true" | data-today="true">12</button>
             … 42 格（固定 6 周，高度不跳）
           </div>
           <div class="cal__foot">
             <button class="btn btn--sm btn--ghost" data-role="datepicker-clear">清除</button>
             <button class="btn btn--sm" data-role="datepicker-today">今天</button>
           </div>
         </div>
       </div>

     图标用字符 `▦`（与 components.css §12 的用法示例一致）：应用里没有任何内联 SVG 的地方，
     dom.js 只 createElement —— 走 SVG 要另引一套 createElementNS，收益不抵成本。

     键盘（**不许比原生 `<input type=date>` 退步**，本卡的硬验收之一）：
       输入框上   Enter / 空格 / ↓ / ↑ 打开日历（↓ 从当前值起、↑ 从今天起；没有值就用今天）
       日历里     ←→ 前后一天 · ↑↓ 前后一周 · Home/End 本行首/末（周一/周日）
                  PageUp/PageDown 前后一月 · Enter/空格 选中并关闭 · Esc 关闭
       关闭后     焦点**归还输入框**（Esc 与选完两条路径都归还，与 menu.js 同一纪律）
       Tab       不拦：那是"离开"，浏览器默认行为即可（同时收起面板）
       走格采用 roving tabindex：只有光标那一格 tabindex=0，其余 −1，整张表只占一个 Tab 位。

     为什么不用 menu.js 那套键盘层：它是"菜单项列表"（↑↓ 逐项、Home/End 首末）。日历要的是
     **二维**移动（±1 天 / ±7 天 / 翻月）与 roving tabindex，两套语义不一样；硬套会让
     Home/End 跳到"本月第一格/最后一格"。所以这里自己一份，但**关闭/归还焦点**的策略照抄 menu.js。

     浮层定位（本卡的另一个硬要求：窄屏不溢出、侧栏里不被裁）：
       设计系统的 `.popover` 是 `position: absolute`。放在**桌面侧栏**里就会出问题——
       `.library__side-body` 是 `overflow: auto` 的滚动容器，绝对定位的后代会**在它的 padding box
       被裁掉**（⑦ 的「日」是横向被裁，日历是纵向 357px 高，比侧栏可视区还高）。
       所以打开时给面板挂 `data-floating="true"`：改成 `position: fixed`，坐标由**这里**用
       CSSOM 变量（--pop-x / --pop-y）写进去 —— CSP §0A E5：动态样式只能走 CSSOM，
       不许拼 `style="..."`。打开期间监听滚动/缩放重新贴回输入框，并做视口内夹取（四边都留 8px）。

     不做什么：没有任何内联样式/脚本（CSP §0A E1）、不碰 localStorage、不发请求、
     不读 store（视图把 onClose/onChange 接起来）。要在 node 里单测纯日期算法时，
     直接 import 本文件用 toIso/parseIso/addMonths/monthGrid（它们不碰 DOM）。
   ========================================================================== */

import { h as defaultH } from './dom.js';

/** 一格里显示的是"周一…周日"（与设计系统 .cal__dow 的示例一致）。 */
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

/** 固定 6 周 × 7 天：月与月之间高度不跳（4/5/6 行的月份切换时不会抖）。 */
const GRID_DAYS = 42;

/** 浮层与视口/输入框之间的最小间距。 */
const FLOAT_GAP = 8;

/* --------------------------------------------------------------------------
   纯日期算法（不碰 DOM —— 可在 node 里单测）
   -------------------------------------------------------------------------- */

export function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Date → `YYYY-MM-DD`（本地时区，与后端/旧控件的取值格式一致）。 */
export function toIso(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** `YYYY-MM-DD` → Date；非法/空 → null。**不接受"2026-02-31"这类越界值**。 */
export function parseIso(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text === undefined || text === null ? '' : text).trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

export function addDays(date, count) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
}

/** 加月：日号超出目标月长度时收到月末（1 月 31 日 + 1 月 → 2 月 28/29 日），不溢到下个月。 */
export function addMonths(date, count) {
  const target = new Date(date.getFullYear(), date.getMonth() + count, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return target;
}

/** 周一 = 0（设计系统的日历以周一为首列）。 */
export function mondayIndex(date) {
  return (date.getDay() + 6) % 7;
}

/** 以 cursor 所在月画一张 6×7 的网格，返回 42 个 Date（首格是"本月 1 号所在周的周一"）。 */
export function monthGrid(cursor) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = addDays(first, -mondayIndex(first));
  return Array.from({ length: GRID_DAYS }, (_, index) => addDays(start, index));
}

export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 今天的零时刻（本地时区）。 */
function today() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/* --------------------------------------------------------------------------
   控件
   -------------------------------------------------------------------------- */

/**
 * 建一个日期选择器。
 *
 * @param {{
 *   id?: string,                       // 挂在**输入框**上，供 <label for> 关联
 *   dataRole?: string,                 // 输入框的 data-role（沿用旧 DOM 的选择器）
 *   ariaLabel?: string,                // 没有可见 <label> 时给输入框的可及名字
 *   toggleLabel?: string,              // 右侧按钮的名字（默认「打开日历」）
 *   popoverLabel?: string,             // 日历面板的名字（role=dialog 的 aria-label）
 *   placeholder?: string,
 *   value?: string,                    // 初始值（ISO）
 *   className?: string,                // 附加到最外层 .datepicker 的类
 *   onChange?: (value: string) => any, // 用户改值（含清空 → ''）；程序化 setValue 不触发
 *   h?: typeof defaultH,               // 建元素（单测注入 jsdom 版的 h）
 *   document?: Document,               // 键盘/滚动层用的文档（单测注入）
 * }} [options]
 * @returns {{
 *   element: HTMLElement, input: HTMLInputElement, toggle: HTMLButtonElement,
 *   popover: HTMLElement, grid: HTMLElement, title: HTMLElement,
 *   getValue(): string, setValue(value: any): string,
 *   setRange(start: string, end: string): void,
 *   open(opts?: {focus?: 'value'|'today'|false}): void, close(opts?: {restoreFocus?: boolean}): void,
 *   isOpen(): boolean, place(): void,
 *   focusDate(): string,
 * }}
 */
export function createDatePicker(options = {}) {
  const h = options.h || defaultH;
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const id = options.id || '';
  const popoverId = id ? `${id}-cal` : '';

  /** 当前值（ISO），恒为字符串（与 `input.value` 一致）。 */
  let value = options.value ? String(options.value) : '';
  if (value && !parseIso(value)) value = '';
  /** 光标（键盘走格 / 决定显示哪个月）。 */
  let cursor = parseIso(value) || today();
  /** 范围（另一端的值）——只用于把区间里的日格标成 data-in-range。 */
  let rangeStart = '';
  let rangeEnd = '';
  let openFlag = false;
  let notify = typeof options.onChange === 'function' ? options.onChange : null;

  /* ---------- DOM ---------- */

  const inputAttrs = {
    className: 'input datepicker__input',
    type: 'text',
    readonly: true,
    autocomplete: 'off',
    placeholder: options.placeholder || '选择日期',
    'data-role': 'datepicker-input',
  };
  if (id) inputAttrs.id = id;
  if (options.dataRole) inputAttrs['data-role'] = options.dataRole;
  if (options.ariaLabel) inputAttrs['aria-label'] = options.ariaLabel;
  const input = h('input', inputAttrs);
  input.value = value;

  const toggleAttrs = {
    className: 'input__affix',
    type: 'button',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    'aria-label': options.toggleLabel || '打开日历',
    'data-role': 'datepicker-toggle',
    text: '▦',
  };
  if (popoverId) toggleAttrs['aria-controls'] = popoverId;
  const toggle = h('button', toggleAttrs);

  const title = h('span', { className: 'cal__title', 'aria-live': 'polite' });
  const prev = h('button', { className: 'cal__nav', type: 'button', 'aria-label': '上个月', 'data-nav': '-1', text: '‹' });
  const next = h('button', { className: 'cal__nav', type: 'button', 'aria-label': '下个月', 'data-nav': '1', text: '›' });
  const head = h('div', { className: 'cal__head' }, [prev, title, next]);
  const dow = h('div', { className: 'cal__dow', 'aria-hidden': 'true' }, WEEKDAYS.map(label => h('span', { text: label })));
  const grid = h('div', { className: 'cal__grid', role: 'grid', 'data-role': 'datepicker-grid' });
  const clearButton = h('button', {
    className: 'btn btn--sm btn--ghost', type: 'button', 'data-role': 'datepicker-clear', text: '清除',
  });
  const todayButton = h('button', {
    className: 'btn btn--sm', type: 'button', 'data-role': 'datepicker-today', text: '今天',
  });
  const foot = h('div', { className: 'cal__foot' }, [clearButton, todayButton]);

  const popoverAttrs = {
    className: 'popover calendar',
    role: 'dialog',
    'data-role': 'datepicker-pop',
  };
  if (popoverId) popoverAttrs.id = popoverId;
  popoverAttrs['aria-label'] = options.popoverLabel || options.ariaLabel || '选择日期';
  const popover = h('div', popoverAttrs, [head, dow, grid, foot]);

  const element = h('div', { className: ['datepicker', options.className].filter(Boolean).join(' '), 'data-role': 'datepicker' }, [input, toggle, popover]);

  /* ---------- 渲染 ---------- */

  const inRange = isoText => Boolean(rangeStart && rangeEnd && isoText > rangeStart && isoText < rangeEnd);

  /** 重画标题 + 42 个日格。`cursor` 决定显示哪个月、哪一格带 tabindex=0。 */
  function render() {
    const cursorIso = toIso(cursor);
    title.textContent = `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月`;
    const todayIso = toIso(today());
    const cells = monthGrid(cursor).map(date => {
      const isoText = toIso(date);
      const attrs = {
        className: 'cal__day',
        type: 'button',
        'data-value': isoText,
        tabindex: isoText === cursorIso ? '0' : '-1',
        text: String(date.getDate()),
      };
      if (date.getMonth() !== cursor.getMonth()) attrs['data-outside'] = 'true';
      if (isoText === todayIso) attrs['data-today'] = 'true';
      if (isoText === value) attrs['aria-selected'] = 'true';
      else if (inRange(isoText)) attrs['data-in-range'] = 'true';
      return h('button', attrs);
    });
    grid.replaceChildren(...cells);
  }

  /** 把焦点放到某一格（渲染之后调；找不到就退回第一格）。 */
  function focusCell(isoText) {
    if (!grid.querySelector) return null;
    const cell = grid.querySelector(`[data-value="${isoText}"]`) || grid.querySelector('.cal__day');
    if (cell && typeof cell.focus === 'function') cell.focus();
    return cell;
  }

  /** 移动光标（键盘走格）并重画、重新聚焦。 */
  function moveCursor(next) {
    cursor = next;
    render();
    focusCell(toIso(cursor));
  }

  /* ---------- 值 ---------- */

  function getValue() {
    return value;
  }

  /** 程序化设值：只改显示，**不触发 onChange**（与原生 `input.value = …` 同语义）。 */
  function setValue(next) {
    const text = next === undefined || next === null ? '' : String(next);
    value = parseIso(text) ? text : '';
    if (input.value !== value) input.value = value;
    if (openFlag) {
      const parsed = parseIso(value);
      if (parsed) cursor = parsed;
      render();
    }
    return value;
  }

  /** 范围的另一端（用来标 data-in-range）。空值 = 不标。 */
  function setRange(start, end) {
    rangeStart = parseIso(start) ? String(start) : '';
    rangeEnd = parseIso(end) ? String(end) : '';
    if (openFlag) render();
  }

  /** 用户真的选了一个日期（或清空）。 */
  function commit(isoText) {
    const changed = value !== isoText;
    setValue(isoText);
    if (typeof notify === 'function' && changed) notify(value);
    return value;
  }

  /* ---------- 浮层定位 ---------- */

  /**
   * 贴着输入框摆（视口内夹取）。
   * 为什么不用 CSS 的 `top: 100%`：`position: fixed` 之后就是视口坐标了（见文件头"浮层定位"）。
   * 坐标走 CSSOM 变量 —— CSP 下不许写 `style="..."` 字符串。
   */
  function place() {
    if (!openFlag || typeof input.getBoundingClientRect !== 'function') return;
    const anchor = input.getBoundingClientRect();
    const box = popover.getBoundingClientRect();
    const viewportW = doc.documentElement.clientWidth || 0;
    const viewportH = doc.documentElement.clientHeight || 0;
    if (!viewportW || !viewportH) return;
    const width = box.width;
    const height = box.height;
    // 水平：默认左对齐输入框；右边装不下就往左收，再装不下就贴左边距。窄屏因此不会溢出。
    let left = Math.min(anchor.left, viewportW - width - FLOAT_GAP);
    left = Math.max(FLOAT_GAP, left);
    // 垂直：优先向下；下面装不下且上面更宽裕就翻上去；两边都装不下就贴顶（面板自己可滚）。
    let top = anchor.bottom + FLOAT_GAP;
    const above = anchor.top - FLOAT_GAP - height;
    if (top + height > viewportH - FLOAT_GAP && above >= FLOAT_GAP) top = above;
    if (top + height > viewportH - FLOAT_GAP) top = Math.max(FLOAT_GAP, viewportH - FLOAT_GAP - height);
    if (top < FLOAT_GAP) top = FLOAT_GAP;
    popover.style.setProperty('--pop-x', `${Math.round(left)}px`);
    popover.style.setProperty('--pop-y', `${Math.round(top)}px`);
  }

  /* ---------- 开 / 关 ---------- */

  function isOpen() {
    return openFlag;
  }

  function onScrollOrResize() {
    if (openFlag) place();
  }

  function open(opts = {}) {
    if (openFlag) return;
    openFlag = true;
    popover.setAttribute('data-open', 'true');
    popover.setAttribute('data-floating', 'true');
    toggle.setAttribute('aria-expanded', 'true');
    const parsed = parseIso(value);
    cursor = opts.focus === 'today' ? today() : (parsed || today());
    render();
    place();
    if (opts.focus !== false && typeof requestAnimationFrame === 'function') {
      // 下一帧再聚焦：面板刚 display:block，先让它完成布局（也顺手把 --pop-x/y 落定）
      requestAnimationFrame(() => { place(); focusCell(toIso(cursor)); });
    }
    if (doc) {
      doc.addEventListener('click', onDocumentClick);
      doc.addEventListener('keydown', onDocumentKeydown);
      if (typeof doc.addEventListener === 'function') {
        // 滚动可能来自任意滚动容器（侧栏 .library__side-body / 抽屉 / 页面本身）→ 捕获阶段听
        doc.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
      }
      if (typeof window !== 'undefined') window.addEventListener('resize', onScrollOrResize);
    }
  }

  function close(opts = {}) {
    if (!openFlag) return;
    openFlag = false;
    popover.removeAttribute('data-open');
    popover.removeAttribute('data-floating');
    toggle.setAttribute('aria-expanded', 'false');
    if (doc) {
      doc.removeEventListener('click', onDocumentClick);
      doc.removeEventListener('keydown', onDocumentKeydown);
      doc.removeEventListener('scroll', onScrollOrResize, { capture: true });
      if (typeof window !== 'undefined') window.removeEventListener('resize', onScrollOrResize);
    }
    /* 焦点归还，但**只在焦点本来就还在我这一摊里**时做（照抄 menu.js 的判据）：
       如果这一下点击把焦点交给了别处（比如选完日期后视图重渲染、或打开了别的浮层），
       再去 focus() 就是把别人的焦点抢回来。 */
    const restore = opts.restoreFocus !== false;
    const active = doc ? doc.activeElement : null;
    const mine = !active || active === doc.body || active === input || active === toggle || popover.contains(active);
    if (restore && mine && typeof input.focus === 'function' && !input.hidden) input.focus();
  }

  function toggleOpen() {
    if (openFlag) close();
    else open();
  }

  /* ---------- 事件 ---------- */

  function onDocumentClick(event) {
    if (!openFlag) return;
    if (element.contains(event.target)) return;
    close({ restoreFocus: false });
  }

  function onDocumentKeydown(event) {
    if (!openFlag || event.key !== 'Escape') return;
    // 面板里的 Esc 由 onKeydown 处理（那里 stopPropagation），走到这里说明焦点不在面板里
    close();
  }

  input.addEventListener('click', () => { if (!openFlag) open(); });
  input.addEventListener('keydown', event => {
    if (openFlag) return;
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      open();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      open({ focus: parseIso(value) ? 'value' : 'today' });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      open({ focus: 'today' });
    }
  });

  toggle.addEventListener('click', event => {
    event.stopPropagation();
    toggleOpen();
  });

  prev.addEventListener('click', () => moveCursor(addMonths(cursor, -1)));
  next.addEventListener('click', () => moveCursor(addMonths(cursor, 1)));

  grid.addEventListener('click', event => {
    const cell = event.target.closest ? event.target.closest('.cal__day') : null;
    if (!cell) return;
    commit(cell.getAttribute('data-value'));
    close();
  });

  clearButton.addEventListener('click', () => {
    cursor = today();
    commit('');
    close();
  });

  todayButton.addEventListener('click', () => {
    // 「今天」是**导航**快捷键（跳到本月并聚焦今天），不代替用户做选择 —— 想选就回车/点一下。
    moveCursor(today());
    place();
  });

  popover.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      // 不拦 Tab，但离开时收起（WAI-ARIA 日期选择器的常规行为）
      close({ restoreFocus: false });
      return;
    }
    switch (event.key) {
      case 'ArrowLeft': event.preventDefault(); moveCursor(addDays(cursor, -1)); return;
      case 'ArrowRight': event.preventDefault(); moveCursor(addDays(cursor, 1)); return;
      case 'ArrowUp': event.preventDefault(); moveCursor(addDays(cursor, -7)); return;
      case 'ArrowDown': event.preventDefault(); moveCursor(addDays(cursor, 7)); return;
      case 'Home': event.preventDefault(); moveCursor(addDays(cursor, -mondayIndex(cursor))); return;
      case 'End': event.preventDefault(); moveCursor(addDays(cursor, 6 - mondayIndex(cursor))); return;
      case 'PageUp': event.preventDefault(); moveCursor(addMonths(cursor, -1)); return;
      case 'PageDown': event.preventDefault(); moveCursor(addMonths(cursor, 1)); return;
      case 'Enter':
      case ' ':
      case 'Spacebar': {
        event.preventDefault();
        const cell = event.target.closest ? event.target.closest('.cal__day') : null;
        commit(cell ? cell.getAttribute('data-value') : toIso(cursor));
        close();
        return;
      }
      default:
        break;
    }
  });

  // 焦点离开"输入框 + 面板"这一摊 → 收起（不抢焦点：Tab 出去时焦点该留给下一个控件）
  element.addEventListener('focusout', event => {
    if (!openFlag) return;
    const next = event.relatedTarget;
    if (next && element.contains(next)) return;
    if (!next) return;              // relatedTarget 为空交给文档级 click 判定（点空白处）
    close({ restoreFocus: false });
  });

  render();

  return {
    element,
    input,
    toggle,
    popover,
    grid,
    title,
    getValue,
    setValue,
    setRange,
    open,
    close,
    isOpen,
    place,
    /** 当前光标所在日期（ISO）——验收脚本用它核对键盘走格的结果。 */
    focusDate: () => toIso(cursor),
    get onChange() { return notify; },
    set onChange(fn) { notify = typeof fn === 'function' ? fn : null; },
  };
}

export default { createDatePicker, toIso, parseIso, addDays, addMonths, monthGrid, mondayIndex, sameDay };
