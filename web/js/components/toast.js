/* ==========================================================================
   AIbum · 通知条  web/js/components/toast.js
   --------------------------------------------------------------------------
   行为清单 0.6：顶部提示条，7 秒后自动消失，新消息重置计时。
   **计时与状态全在 store.toast 里**（store.js 已实现，NOTIFY_MS = 7000）；
   这里只负责把 state.toast 渲染到那一个 .toast 节点上——视图层不自己 setInterval。

   一句话用法（app.js 装配时调一次）：
     bindToast(document.getElementById('toast'));
   ========================================================================== */

import { subscribe } from '../store.js';

/**
 * 把通知条节点接到 store 上。
 * @param {HTMLElement} node .toast 节点
 * @returns {() => void} 取消订阅
 */
export function bindToast(node) {
  if (!node) throw new Error('bindToast 需要一个 .toast 节点');
  const render = state => {
    node.hidden = !state.toast.visible;
    node.textContent = state.toast.text;
  };
  return subscribe(render, { immediate: true });
}

export default { bindToast };
