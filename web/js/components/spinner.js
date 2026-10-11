/* ==========================================================================
   AIbum · 加载指示（**装饰性**）  web/js/components/spinner.js
   --------------------------------------------------------------------------
   为什么有这个文件：设计系统里有两个加载指示，之前应用里**一个都没用**
   （审计 `docs/设计系统落实差距.md`：「`.spinner` / `.loader` / `.skel`：基本没有；
   模型加载是自造脉动圆点」）。做落实卡「轻量两项」③ 时，6 处异步场景各写一遍
   `h('span', { className: 'spinner', 'aria-hidden': 'true' })` 必然漂移——
   最容易漏的就是 `aria-hidden`。把这条契约收在一个地方，漏不掉。

   两条硬规矩（落实卡明确要求）：

   1) **指示器恒为装饰**：`aria-hidden="true"`。
      加载语义一律由**宿主控件 / 区域**的 `aria-busy="true"` 表达
      （`.btn[aria-busy]` / `.table[aria-busy]` / `.upload__zone[aria-busy]` 都已就位）。
      **绝不在指示器上再挂一次 aria-busy**：同一件事标注两处，读屏会念两遍。

   2) **`prefers-reduced-motion: reduce` 下不动**。
      `components.css` §0 的静止名单已经包含 `.spinner` 与 `.loader`
      （后者是本卡补进去的——它原来漏在外面，点半跳动的三点会继续动）。

   用哪个：
     · `.spinner`（旋转弧）——**控件内部**的短等待：按钮里、状态行前面。
     · `.loader`（三点 + 文案）——**区域级**的等待：列表"正在加载更多"。
       components.css §13 的原话就是「三点跳动（比 spinner 轻，用在"正在加载更多"）」。

   用法（宿主自己负责 aria-busy）：
     const spin = createSpinner({ size: 'sm' });
     button.append(spin.element);          // 宿主按钮已经 aria-busy="true"
     spin.show(); … spin.hide();

     const dots = createLoader({ text: '正在加载更多…' });
     tail.append(dots.element);            // 默认隐藏，show()/hide() 切换
   ========================================================================== */

import { h as defaultH } from './dom.js';

/** 装饰性声明只写一次：所有指示器元素都必须带上它。 */
export const DECORATIVE = 'true';

/**
 * 旋转弧（设计系统 `.spinner`）。
 * @param {{ size?: ''|'sm'|'lg', className?: string, hidden?: boolean, h?: typeof defaultH }} [options]
 *        size 走 `.spinner--sm` / `.spinner--lg`（默认 `sm`：塞进按钮里不撑高控件）。
 * @returns {{ element: HTMLElement, show(): HTMLElement, hide(): HTMLElement, visible: boolean }}
 */
export function createSpinner(options = {}) {
  const h = options.h || defaultH;
  const size = options.size === undefined ? 'sm' : options.size;
  const className = [
    'spinner',
    size ? `spinner--${size}` : '',
    options.className || '',
  ].filter(Boolean).join(' ');
  // hidden 默认 true：调用方拿到它时先不显示，由宿主的状态变化决定何时 show()。
  const element = h('span', { className, 'aria-hidden': DECORATIVE, hidden: options.hidden !== false });
  return {
    element,
    show() { element.hidden = false; return element; },
    hide() { element.hidden = true; return element; },
    get visible() { return !element.hidden; },
  };
}

/**
 * 区域级加载行（设计系统 `.loader`：三点 + 一句文案）。
 *
 * 三点用 `aria-hidden`，文案**保持可读**（它是真的写给人看的一句话，
 * 与装饰性的三点不同；宿主不需要再标一次 aria-busy 才能让用户知道在等）。
 *
 * @param {{ text?: string, hidden?: boolean, h?: typeof defaultH }} [options]
 * @returns {{ element: HTMLElement, label: HTMLElement, setText(t: string): HTMLElement,
 *            show(): HTMLElement, hide(): HTMLElement, visible: boolean }}
 */
export function createLoader(options = {}) {
  const h = options.h || defaultH;
  const dots = h('span', { className: 'loader__dots', 'aria-hidden': DECORATIVE }, [h('i'), h('i'), h('i')]);
  const label = h('span', { className: 'loader__text', text: options.text === undefined ? '正在加载…' : options.text });
  const element = h('div', { className: 'loader', 'data-role': 'loader', hidden: options.hidden !== false }, [dots, label]);
  return {
    element,
    label,
    setText(text) {
      const next = text === undefined || text === null ? '' : String(text);
      if (label.textContent !== next) label.textContent = next;
      return label;
    },
    show() { element.hidden = false; return element; },
    hide() { element.hidden = true; return element; },
    get visible() { return !element.hidden; },
  };
}

export default { createSpinner, createLoader, DECORATIVE };
