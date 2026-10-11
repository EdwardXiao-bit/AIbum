/* ==========================================================================
   AIbum · 应用装配  web/js/app.js
   --------------------------------------------------------------------------
   阶段 3：把骨架（api / store / router / theme / main）与视图接起来。
   web/app.html 只引这一个模块（外加 <head> 里的防 FOUC 外置同步脚本）。

   分工（**不要混**）：
     main.js        骨架装配：入口判定、路径别名、路由监听、启动鉴权（0.8）
     app.js（本文件）应用外壳：顶栏、视图挂载、浮层、登出（1.5）
     views/auth.js  认证视图（1.1 - 1.4、1.10）
     views/account.js 账户浮层（1.6 - 1.9）
     views/admin.js  管理后台（8.5 - 8.9 + 9.4 不轮询）：#/admin 与 pathname /admin 两条入口都落到它
     views/library.js 相册主界面（第 2 / 3 / 5 节 + 第 9 节轮询）
     views/detail.js  照片详情**抽屉**（第 6 节）—— 不是并列视图，而是叠在主界面之上的浮层：
                      store.view === 'photo' 时主界面仍然挂着（见下面的 activeView）。
                      理由：关掉抽屉要回到原来的结果集，卸载再挂回会把列表打回第 1 页。

   行为清单对应：
     1.5 登出 —— POST /auth/logout → 切回登录态，并**彻底清空**用户 / 照片 / 选中 /
         筛选 / 详情 / 用户列表。前三者与筛选、详情在 store.resetToLogin 里，
         用户列表（管理后台的数据，F7 会用）由 store 一并清掉，见 store.js 的 users。
     8.4（顺带）管理入口的顶栏与文档标题文案：入口靠路径判定（8.1），本文件只管切换。

   CSP 约束（行为清单 §0A）：不写内联 script / 内联 style / style 属性 / 内联事件。
   ========================================================================== */

import { api } from './api.js';
import * as main from './main.js';
import * as router from './router.js';
import * as store from './store.js';
import * as theme from './theme.js';
import { createModals } from './components/modal.js';
import { bindToast } from './components/toast.js';
import { createAccountOverlays } from './views/account.js';
import { createAuthView } from './views/auth.js';
import { createAdminView } from './views/admin.js';
import { createDetailView } from './views/detail.js';
import { createLibraryView } from './views/library.js';

/** 取节点，缺了就立刻报错（缺节点是最容易静默失效的一类 bug）。 */
function must(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error('外壳缺少节点：#' + id);
  return node;
}

const nodes = {
  brand: must('brand'),
  portalLink: must('portal-link'),
  account: must('account'),
  username: must('username'),
  libraryLink: must('library-link'),
  securityButton: must('security-button'),
  adminButton: must('admin-button'),
  logout: must('logout'),
  topbarUpload: must('topbar-upload'),
  topbarMenu: must('topbar-menu-toggle'),
  viewRoot: must('view-root'),
  scrim: must('scrim'),
  toast: must('toast'),
};

/* --------------------------------------------------------------------------
   浮层与视图
   -------------------------------------------------------------------------- */

const modals = createModals({ scrim: nodes.scrim });
const overlays = createAccountOverlays({ modals });
const authView = createAuthView({ template: must('tpl-auth'), overlays });
const libraryView = createLibraryView({ modals, navigate: (target, options) => router.navigate(target, options) });

/**
 * 照片详情抽屉（第 6 节）。它是浮层不是视图：挂在 <body> 上（position: fixed 的抽屉
 * 不该受 .container 的排版影响），由 render() 里的 detailView.sync() 按路由开关。
 * runSimilar / onSaved / onRetried 直接复用主界面已有的入口，避免第二套实现：
 *   6.10 → library.runSimilar(id)（相同的结果集容器，标题"相似照片（已排除参考图）"）
 *   6.7  → 保存后 refreshOptions + 重放当前查询（legacy L231）
 *   6.9  → 重新分析后重载（legacy L233）
 */
const detailView = createDetailView({
  modals,
  navigate: (target, options) => router.navigate(target, options),
  runSimilar: id => libraryView.runSimilar(id),
  onSaved: () => libraryView.refreshAll(),
  onRetried: () => libraryView.refreshAll(),
});

/**
 * 管理后台（第 8 节 8.5 - 8.9）。它是**并列视图**（不是浮层）：store.view === 'admin' 时
 * 主界面卸载、后台挂上 —— 这样 9.4「管理台不轮询」是天然成立的（相册主界面的
 * 4 秒健康轮询在 unmount 里被清掉），不需要在轮询里再判一次入口。
 */
const adminView = createAdminView({ modals });

/** store.view → 视图。照片详情不是这里的一个条目（见 activeView）。 */
const views = {
  login: authView,
  library: libraryView,
  admin: adminView,
};

/**
 * 当前该挂哪个视图。**photo 路由下仍然挂主界面**，详情是叠在它上面的抽屉（D2 默认形态）：
 * 这样"打开详情 → 关闭"不会重建列表、不会丢滚动位置与翻页进度。
 */
function activeView(state) {
  return state.view === 'photo' ? views.library : views[state.view];
}

/** 同一时刻只挂一个视图。 */
let mounted = null;

function mountView(view) {
  if (mounted === view) return;
  if (mounted) mounted.unmount();
  view.mount(nodes.viewRoot);
  mounted = view;
}

/* --------------------------------------------------------------------------
   渲染：顶栏 + 主区
   -------------------------------------------------------------------------- */

function renderTopbar(state) {
  const loggedIn = Boolean(state.user);
  nodes.account.hidden = !loggedIn;
  nodes.portalLink.hidden = loggedIn;
  // 窄屏收纳（阶段 3.6）：菜单按钮只在登录后出现；上传常驻按钮只在"相册主界面 /
  // 照片详情"这两个真正有上传语义的视图里出现（管理后台、登录页没有上传入口）。
  // 宽屏下两者都被 mobile.css 的 display:none 藏起来，不影响桌面顶栏。
  nodes.topbarMenu.hidden = !loggedIn;
  nodes.topbarUpload.hidden = !(loggedIn && (state.view === 'library' || state.view === 'photo'));
  if (!loggedIn) {
    nodes.adminButton.hidden = true;
    setMenuOpen(false);
    return;
  }
  nodes.username.textContent = state.user.username;
  // 管理员入口下不再显示"管理后台"按钮（旧版同此：已经在后台了）；
  // "我的相册"链接反过来只在管理员入口出现。
  nodes.adminButton.hidden = state.portal === 'admin' || !state.user.is_admin;
  nodes.libraryLink.hidden = state.portal !== 'admin';
}

/**
 * 窄屏顶栏菜单（阶段 3.6）。
 * 为什么用 data-open 切 #account 而不是另建一份菜单 DOM：次级入口（我的相册 /
 * 账户安全 / 管理后台 / 退出）的**处理器与禁用逻辑都已经挂在现有节点上**
 * （见下面的顶栏交互与 renderUploadLock），复制一份 DOM 就等于复制这些规则，
 * 迟早漂移。这里只换摆法：宽屏横排，窄屏竖排下拉。
 */
function setMenuOpen(open) {
  nodes.account.dataset.open = open ? 'true' : 'false';
  nodes.topbarMenu.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function menuIsOpen() {
  return nodes.account.dataset.open === 'true';
}

nodes.topbarMenu.addEventListener('click', () => setMenuOpen(!menuIsOpen()));

// 点面板外面 / 点面板里的任一入口 → 收起。Esc 也收起并把焦点还给菜单按钮。
document.addEventListener('click', event => {
  if (!menuIsOpen()) return;
  if (nodes.account.contains(event.target) || nodes.topbarMenu.contains(event.target)) return;
  setMenuOpen(false);
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !menuIsOpen()) return;
  setMenuOpen(false);
  nodes.topbarMenu.focus();
});
// 视口变宽 → 面板形态不存在了，收起（否则转屏回窄屏时它会莫名其妙地开着）
const wideQuery = window.matchMedia('(min-width: 900px)');
wideQuery.addEventListener('change', event => { if (event.matches) setMenuOpen(false); });

/**
 * 4.8 上传期间锁定：**登出**与**账户安全**在上传进行中必须禁用。
 * 为什么要由外壳来做：这两个按钮属于顶栏（本文件），而上传说到底是相册主界面的事，
 * 主界面碰不到顶栏。共享的状态位（store.setUploading）是两边唯一的交汇点——
 * 上传时改状态，这里订阅同一个消息改按钮，谁也不越界去 hold 对方的 DOM。
 * 注意：不禁用"管理后台"与"我的相册"跳转（旧版也只锁这两个 + 上传输入框）。
 */
function renderUploadLock(state) {
  const busy = state.uploading > 0;
  nodes.logout.disabled = busy;
  nodes.securityButton.disabled = busy;
  nodes.logout.setAttribute('aria-disabled', busy ? 'true' : 'false');
  nodes.securityButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
  // 窄屏的常驻上传按钮与设计系统的上传区是同一个动作（4.8：上传期间锁定）
  nodes.topbarUpload.disabled = busy;
  nodes.topbarUpload.setAttribute('aria-disabled', busy ? 'true' : 'false');
  if (busy) modals.close(overlays.elements.security);   // 上传中不许改密码：开着的安全面板直接收起
}

/** 入口文案（8.4）：管理员入口与用户入口共用一个 HTML，靠这里换字。 */
function applyPortalChrome(state) {
  const admin = state.portal === 'admin';
  nodes.portalLink.textContent = admin ? '普通用户入口' : '管理员入口';
  nodes.portalLink.href = admin ? '/' : '/admin';
  nodes.brand.href = admin ? '#/admin' : '#/library';
  document.title = admin ? 'AIbum · 管理后台' : 'AIbum · 智慧相册';
}

function render(state, reason) {
  // 1.5：登出/切回登录态时，浮层全关、认证表单复位（含切回"登录"形态）
  if (reason === 'session' && !state.user) {
    overlays.closeAll();
    authView.reset();
  }
  // 入口文案要在这里算：本模块比 main.boot() 先执行，boot 里才 setPortal()
  // （入口靠 location.pathname 判定，8.1），只在启动时算一次会永远停在 user 版文案。
  applyPortalChrome(state);
  renderTopbar(state);
  renderUploadLock(state);          // 4.8：上传期间禁用登出 / 账户安全
  const view = activeView(state);
  if (view) mountView(view);
  // 详情是浮层：它自己按 store.view / routeParams 决定开合，不参与 mountView 的单视图互斥
  detailView.sync(state);
}

/* --------------------------------------------------------------------------
   顶栏交互
   -------------------------------------------------------------------------- */

/** 1.5 登出：请求成功即切回登录态（清空交给 store.resetToLogin）。 */
nodes.logout.addEventListener('click', store.guard(async () => {
  setMenuOpen(false);
  await api.post('/auth/logout');
  store.resetToLogin();
}));

nodes.securityButton.addEventListener('click', () => {
  setMenuOpen(false);
  overlays.openSecurity();
});

nodes.adminButton.addEventListener('click', () => {
  setMenuOpen(false);
  router.navigate('#/admin');
});

// 窄屏菜单里的"我的相册"是个 <a href="#/library">：点它就走路由，顺手收起面板
nodes.libraryLink.addEventListener('click', () => setMenuOpen(false));

/**
 * 窄屏顶栏的上传按钮（阶段 3.6）：与相册主界面里的「选择照片…」是**同一个动作**，
 * 复用主界面暴露的入口，不另开一条上传路径（4.1 的 XHR / 4.2 的串行 / 4.5 的
 * 账户切换中断都只有一份实现）。
 */
nodes.topbarUpload.addEventListener('click', () => {
  if (typeof libraryView.pickUploadFiles !== 'function') return;
  libraryView.pickUploadFiles();
});

/* --------------------------------------------------------------------------
   启动
   -------------------------------------------------------------------------- */

// 首屏先按当前状态刷一遍（此时 portal 还是默认的 user，boot 里 setPortal 后 render 会再刷）
applyPortalChrome(store.getState());
renderUploadLock(store.getState());
bindToast(nodes.toast);
// 详情抽屉先进 DOM，再订阅：深链直接落在 #/photo/:id 时，启动的第一次 render 就能打开它
detailView.mount(document.body);
store.subscribe(render);

let bootResult = null;
let bootError = null;
try {
  bootResult = await main.boot();     // 0.8 启动流程：/auth/me → 工作区 / 登录态
} catch (error) {
  bootError = error;
  store.toast(error && error.message ? error.message : String(error));
}

// 验收钩子（阶段 1 的 next.html 用的是同一套命名）。正式视图不依赖它。
window.__aibum = {
  api, store, router, theme, main,
  modals, overlays, authView, libraryView, detailView, adminView, views,
  get bootResult() { return bootResult; },
  get bootError() { return bootError; },
};
window.__aibumReady = true;
