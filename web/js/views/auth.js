/* ==========================================================================
   AIbum · 认证视图  web/js/views/auth.js
   --------------------------------------------------------------------------
   阶段 3.1。逐条对照 docs/前端-行为清单.md 第 1 节：

     1.1 登录/注册切换 —— 同步改标题 / 提交按钮文字 / 切换按钮文字 /
         autocomplete（new-password ↔ current-password）/ 清空错误
     1.2 提交登录/注册 —— POST /auth/login 或 /auth/register，体 {username,password}；
         用户名 1–20、密码 ≥ 8 的约束在 HTML 层（template 里的 required/maxlength/minlength）
     1.3 注册返回 recovery_code → 弹恢复码对话框（交给 views/account.js 的浮层）
     1.4 管理员在**用户入口**登录成功 → 跳 #/admin（旧版是 location.assign('/admin')；
         新前端是 hash 路由，同一页面内切到管理员入口）
     1.10 登录页文案 —— 左侧品牌区在 HTML 模板里（app.html 的 #tpl-auth），
          与 web/index.html L13 逐字一致；本文件只管随入口/模式变化的那些字

   不在本文件：登出（外壳 app.js，1.5）· 恢复码下载（views/account.js，1.9）·
   账户安全 / 忘记密码（views/account.js，1.6/1.7/1.8）。
   ========================================================================== */

import { api } from '../api.js';
import * as router from '../router.js';
import * as store from '../store.js';

/** 登录 / 注册两种形态的文案与其 autocomplete（1.1，逐字对齐 legacy/app.js L46）。 */
export const MODE_TEXTS = {
  login: {
    title: '登录你的相册',
    submit: '登录',
    toggle: '还没有账户？创建一个',
    autocomplete: 'current-password',
  },
  register: {
    title: '创建你的相册',
    submit: '创建账户',
    toggle: '已有账户？返回登录',
    autocomplete: 'new-password',
  },
};

/**
 * 管理员入口的文案覆盖（行为清单 8.4，逐字对齐 legacy/app.js L288-292）。
 * 表单部分在这里；顶栏入口链接与 document.title 属于外壳，在 app.js 里。
 */
export const ADMIN_COPY = {
  title: '管理员登录',
  submit: '登录管理台',
  sub: '仅管理员账号可进入控制台。',
  hero: '相册管理，从这里开始。',
  intro: '使用已配置的管理员账号和密码登录，查看账户与服务运行情况。',
};

/**
 * 建认证视图。节点从 HTML 的 <template id="tpl-auth"> 克隆，本文件不拼 HTML 字符串。
 * @param {{template: HTMLTemplateElement, overlays: {showRecovery(code: string): void,
 *          openForgot(options?: {username?: string}): void}, document?: Document}} options
 * @returns {{element: HTMLElement, mount(parent: Element): void, unmount(): void,
 *            setMode(register: boolean): void, isRegisterMode(): boolean}}
 */
export function createAuthView(options) {
  const doc = options.document || document;
  const overlays = options.overlays;
  const node = options.template.content.firstElementChild.cloneNode(true);

  const el = {
    hero: node.querySelector('#auth-hero'),
    intro: node.querySelector('#auth-intro'),
    form: node.querySelector('#auth-form'),
    title: node.querySelector('#auth-title'),
    sub: node.querySelector('#auth-sub'),
    name: node.querySelector('#auth-name'),
    password: node.querySelector('#auth-password'),
    error: node.querySelector('#auth-error'),
    submit: node.querySelector('#auth-submit'),
    toggle: node.querySelector('#auth-toggle'),
    forgot: node.querySelector('#forgot-button'),
  };
  for (const [key, value] of Object.entries(el)) {
    if (!value) throw new Error(`认证视图缺少节点：${key}`);
  }

  let registerMode = false;
  let unsubscribe = null;

  /* ---------- 1.1 错误显示（唯一来源是 store.authError，便于验收脚本读状态） ---------- */

  function renderError(state = store.getState()) {
    el.error.textContent = state.authError || '';
    el.error.hidden = !state.authError;
  }

  /* ---------- 1.1 登录 / 注册切换 ---------- */

  /**
   * 模式文案 + 入口（8.4）覆盖，**每次都要一起算**。
   * 不能只在建视图时算一次：视图是在 main.boot() 之前建好的，那时 setPortal() 还没跑
   * （入口靠 location.pathname 判定，8.1），所以挂载时必须再刷一次。
   */
  function refreshCopy() {
    const texts = MODE_TEXTS[registerMode ? 'register' : 'login'];
    el.title.textContent = texts.title;
    el.submit.textContent = texts.submit;
    el.toggle.textContent = texts.toggle;
    el.password.autocomplete = texts.autocomplete;   // new-password / current-password
    applyPortalCopy();
  }

  function setMode(register) {
    registerMode = Boolean(register);
    refreshCopy();
    store.setAuthError('');                          // 切换时清空错误
    return registerMode;
  }

  /* ---------- 1.2 / 1.3 / 1.4 提交 ---------- */

  async function onSubmit(event) {
    event.preventDefault();
    el.submit.disabled = true;
    store.setAuthError('');
    try {
      const portal = store.getState().portal;
      const path = portal === 'admin'
        ? '/admin/login'
        : (registerMode ? '/auth/register' : '/auth/login');
      const user = await api.post(path, { username: el.name.value, password: el.password.value });

      // 1.4：管理员在用户入口登录成功 → 跳管理员入口（旧版 location.assign('/admin')）
      if (user.is_admin && portal !== 'admin') {
        store.enterWorkspace(user);
        router.navigate('#/admin');
        return;
      }

      store.enterWorkspace(user);
      // 1.3：注册（或管理员入口下注册？不存在）返回恢复码 → 弹恢复码对话框
      if (user.recovery_code) overlays.showRecovery(user.recovery_code);
    } catch (error) {
      // 认证失败走表单内联错误，不走向顶部通知条（旧版同此）
      store.setAuthError(error && error.message ? error.message : String(error));
    } finally {
      el.submit.disabled = false;
    }
  }

  /* ---------- 入口相关文案（8.4）与事件绑定 ---------- */

  /**
   * 管理入口的文案覆盖（8.4）。入口在页面生命周期内不变（由路径判定，8.1），
   * 所以这里只做"是管理员入口就覆盖"，用户入口的文案就是 HTML 模板里的原文。
   */
  function applyPortalCopy() {
    const admin = store.getState().portal === 'admin';
    el.toggle.hidden = admin;     // 管理员入口不提供注册
    if (!admin) return;
    el.title.textContent = ADMIN_COPY.title;
    el.submit.textContent = ADMIN_COPY.submit;
    el.sub.textContent = ADMIN_COPY.sub;
    el.hero.textContent = ADMIN_COPY.hero;
    el.intro.textContent = ADMIN_COPY.intro;
  }

  el.toggle.addEventListener('click', () => setMode(!registerMode));
  el.form.addEventListener('submit', event => { onSubmit(event); });
  el.forgot.addEventListener('click', () => overlays.openForgot({ username: el.name.value }));

  setMode(false);

  return {
    element: node,
    /** 挂载：算一次文案（此时 setPortal 已跑过），订阅错误状态。 */
    mount(parent) {
      parent.replaceChildren(node);
      refreshCopy();
      unsubscribe = store.subscribe(state => renderError(state));
      renderError();
    },
    unmount() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      node.remove();
    },
    /**
     * 登出 / 切回登录态时复位表单形态。
     * 只清密码（旧版进入工作区时就清了 auth-password，等价）；**保留用户名**——
     * 旧版 showAuth() 也不清它，而"忘记密码"要拿它预填用户名（1.8）。
     * 形态复位到"登录"是相对旧版的补强：旧版登出后仍停在注册形态、错误文案也不清。
     */
    reset() {
      el.password.value = '';
      setMode(false);
    },
    setMode,
    isRegisterMode: () => registerMode,
  };
}

export default { createAuthView, MODE_TEXTS, ADMIN_COPY };
