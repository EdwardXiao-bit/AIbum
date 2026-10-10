/* ==========================================================================
   AIbum · DOM 小工具  web/js/components/dom.js
   --------------------------------------------------------------------------
   为什么需要它：严格 CSP（行为清单 §0A E1）禁止内联脚本 / 内联样式，视图又必须全部用
   createElement 构造（不能拼 HTML 字符串，否则等于自己造了一个 innerHTML 注入面）。
   不做这个 6 行的小工具，视图层会退化成 400 行 createElement 噪音。

   规矩：
     - 只用 textContent 写文字，**没有** innerHTML / outerHTML / insertAdjacentHTML
     - 不写 style 属性（E5：动态样式走 CSSOM 或切类名）
     - on* 一律 addEventListener（CSP 禁内联事件）
   ========================================================================== */

/**
 * 建一个元素。
 * @param {string} tag 标签名
 * @param {Record<string, any>} [attrs] className / text / html 之外都当属性；`on` 开头的当事件
 *        - className: string
 *        - text: string             → textContent
 *        - data: Record<string,string> → dataset
 *        - on<Event>: handler        → addEventListener（事件名小写）
 * @param {Array<Node|string|null|undefined|false>} [children]
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'data') {
      for (const [dataKey, dataValue] of Object.entries(value)) {
        if (dataValue === undefined || dataValue === null) continue;
        node.dataset[dataKey] = String(dataValue);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') node.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'required' || key === 'readOnly') {
      node[key] = Boolean(value);
    } else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

/** 往节点里追加子节点（跳过 null / undefined / false / ''，便于写条件子节点）。 */
export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** `<span class="chip">文字</span>` 这类最常见的组合。 */
export function chip(text, attrs = {}) {
  return h('span', { ...attrs, text });
}

/** 只有 text 变化时替换文字（避免每次都重建子节点、丢焦点）。 */
export function setText(node, text) {
  const next = text === undefined || text === null ? '' : String(text);
  if (node && node.textContent !== next) node.textContent = next;
  return node;
}

export default { h, append, chip, setText };
