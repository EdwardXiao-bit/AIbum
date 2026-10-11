/* ==========================================================================
   AIbum · 通知条  web/js/components/toast.js
   --------------------------------------------------------------------------
   行为清单 0.6：顶部提示条，7 秒后自动消失，新消息重置计时。
   **计时与状态全在 store.toast 里**（store.js 已实现，NOTIFY_MS = 7000）；
   这里只负责把 state.toast 渲染到那一个 .toast 节点上——视图层不自己 setInterval。

   一句话用法（app.js 装配时调一次）：
     bindToast(document.getElementById('toast'));

   ---- 语气变体（落实卡「轻量两项」②）----
   改动前这里只写 `hidden` + `textContent`，所以成功与失败**长得一模一样**。
   现在 store 会带来 `tone`（'' / 'ok' / 'danger'），它决定：
     · 容器上的 `toast--ok` / `toast--danger`（底色 / 描边 / 文案色，见 components.css §10）
     · 图标位画什么字形（✓ / !，由 CSS 的 ::before 出，两种变体**不只靠颜色**）

   **DOM 结构在这里建，不在 app.html 里**：`app.html` 的 `#toast` 里一旦留了换行，
   那些空白文本节点就会进 `#toast.textContent`，而 textContent 是既有验收基线
   （`_verify-f3-auth.mjs:436/479/487` 做的是**全等**比较）。图标同样不进 textContent
   —— 它是空 `<span>`，字形走 CSS。于是 `#toast.textContent` 恒等于通知文案本身。
   ========================================================================== */

import { subscribe } from '../store.js';
import { h as defaultH } from './dom.js';

/** 语气 → 容器类名（其余语气一律落到"中性"，不带任何变体类）。 */
const TONE_CLASS = { ok: 'toast--ok', danger: 'toast--danger' };

/**
 * 把通知条节点接到 store 上。
 * @param {HTMLElement} node .toast 节点
 * @param {{ h?: typeof defaultH }} [options] h 仅单测注入用
 * @returns {() => void} 取消订阅
 */
export function bindToast(node, options = {}) {
  if (!node) throw new Error('bindToast 需要一个 .toast 节点');
  const h = options.h || defaultH;

  /* 结构只建一次（重复 bindToast 时复用已有节点，不叠加）：
       <p class="toast" role="status" aria-live="polite">
         <span class="toast__icon" aria-hidden="true"></span>   ← 字形走 CSS ::before
         <span class="toast__text">文案</span>
       </p>
     图标位 aria-hidden：它是**装饰**（语气本身由文案说了），读屏不必念一个 "✓"。 */
  let icon = node.querySelector(':scope > .toast__icon');
  let label = node.querySelector(':scope > .toast__text');
  if (!icon || !label) {
    icon = icon || h('span', { className: 'toast__icon', 'aria-hidden': 'true' });
    label = label || h('span', { className: 'toast__text' });
    node.replaceChildren(icon, label);
  }

  const render = state => {
    const { text, visible, tone } = state.toast;
    const next = text === undefined || text === null ? '' : String(text);
    node.hidden = !visible;
    // 两个变体类互斥地切：先清掉、再按当前语气加一个，避免残留上一次的语气。
    node.classList.remove(TONE_CLASS.ok, TONE_CLASS.danger);
    if (TONE_CLASS[tone]) node.classList.add(TONE_CLASS[tone]);
    // 只动文案位：写 node.textContent 会把图标位一起冲掉。
    if (label.textContent !== next) label.textContent = next;
  };
  return subscribe(render, { immediate: true });
}

export default { bindToast };
