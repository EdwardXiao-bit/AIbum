/* ==========================================================================
   AIbum · 浮层基元  web/js/components/modal.js
   --------------------------------------------------------------------------
   设计系统（css/components.css §10）里的浮层是 **div + 共享遮罩**：
     <div class="scrim" id="scrim" hidden></div>
     <div class="dialog" role="dialog" aria-modal="true" hidden>…</div>
   不是原生 <dialog>：样张与 web/styleguide.html 都用这一套，视图必须跟着它，
   否则同一个"对话框"在两处长得不一样。

   原生 <dialog> 白送的几件事（Esc 关闭、焦点陷阱、焦点归还、遮罩点击）这里手工补齐，
   并且是 **同一份实现**给三个对话框用（账户安全 / 找回密码 / 恢复码）。

   不使用内联事件、不用 eval；全部 addEventListener（CSP：script-src 'self'）。

   用法：
     const modals = createModals({ scrim: document.getElementById('scrim') });
     modals.open(document.getElementById('dialog-security'));
     modals.close();                 // 关掉当前打开的那个
     modals.closeAll();
   ========================================================================== */

/** 可获得焦点的元素（用于首焦点与 Tab 循环）。 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(node => !node.hidden && node.offsetParent !== null);
}

/**
 * 建一个"同一时刻最多一个"的浮层管理器。
 * @param {{scrim: HTMLElement, root?: Document}} options
 */
export function createModals(options) {
  const scrim = options.scrim;
  const doc = options.root || scrim.ownerDocument;
  /** 当前打开的那个（null = 全部关闭）。 */
  let current = null;
  /** 打开前的焦点，关闭时归还（阶段 4.6 的焦点管理，先在这里落地）。 */
  let restoreFocus = null;
  /** dialog → { onClose, closeOnScrim } */
  const registry = new Map();

  function show(dialog) {
    if (current === dialog) return dialog;
    // 同屏只留一个浮层：先把上一个关掉（走 close()，好让它自己的 onClose 生效，
    // 例如恢复码对话框关闭时要清空码）
    if (current) close(current);
    restoreFocus = doc.activeElement;
    current = dialog;
    scrim.hidden = false;
    dialog.hidden = false;
    const first = focusableWithin(dialog)[0];
    if (first) first.focus();
    return dialog;
  }

  function hide(dialog) {
    if (!dialog) return;
    dialog.hidden = true;
    if (current === dialog) current = null;
    if (!current) scrim.hidden = true;
    if (restoreFocus && typeof restoreFocus.focus === 'function' && doc.contains(restoreFocus)) {
      restoreFocus.focus();
    }
    restoreFocus = null;
  }

  /**
   * 登记一个对话框：接上遮罩点击、[data-close] 按钮、Esc、Tab 循环。
   * @param {HTMLElement} dialog
   * @param {{onClose?: () => void, closeOnScrim?: boolean}} [opts]
   */
  function register(dialog, opts = {}) {
    registry.set(dialog, { onClose: opts.onClose || null, closeOnScrim: opts.closeOnScrim !== false });
    dialog.addEventListener('click', event => {
      if (event.target.closest('[data-close]')) close(dialog);
    });
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const items = focusableWithin(dialog);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && doc.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && doc.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    return dialog;
  }

  function close(dialog = current) {
    if (!dialog || dialog.hidden) return;
    const entry = registry.get(dialog);
    hide(dialog);
    if (entry && typeof entry.onClose === 'function') entry.onClose();
  }

  function closeAll() {
    for (const dialog of registry.keys()) close(dialog);
  }

  // 点遮罩关闭（current 那个自己声明了 closeOnScrim 才关）
  scrim.addEventListener('click', () => {
    const entry = current ? registry.get(current) : null;
    if (!entry || entry.closeOnScrim) close();
  });
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape' && current && !current.hidden) close();
  });

  return {
    register,
    open: show,
    close,
    closeAll,
    get current() { return current; },
    isOpen: dialog => Boolean(dialog) && !dialog.hidden,
    /** 当前是否有任何浮层打开（视图用它决定要不要"打扰"用户，例如自动重载列表）。 */
    isOpenAll: () => Boolean(current) && !current.hidden,
  };
}

export default { createModals };
