/* ==========================================================================
   AIbum · 启动装配  web/js/main.js
   --------------------------------------------------------------------------
   阶段 1（新前端骨架）。只做"装配"：把 theme / router / store / api 接起来，
   不含任何具体界面（视图是阶段 3 的事）。boot() 是这个应用的唯一入口。

   对照 docs/前端-行为清单.md 第 0 节：
     0.8 启动流程 → GET /api/auth/me 成功进工作区，失败回登录态（bootAuthCheck）
   外加阶段 1 第 8 条（/admin 路径别名）与行为清单 8.3（管理员入口拦截非管理员）。

   启动顺序（每一步都有理由，别随意调换）：
     1. 读 location.pathname 定入口 user/admin（行为清单 8.1）
     2. 应用主题（尽量早，主题的防闪烁已在 <head> 内联脚本里做过一次）
     3. /admin 路径别名 → 补 #/admin（第 8 条）
     4. 起路由监听（此时才知道该显示哪个视图）
     5. GET /api/auth/me 定登录态（0.8）
     6. hash 为空时按登录态落到默认路由
   ========================================================================== */

import { ApiError, api } from './api.js';
import * as router from './router.js';
import * as store from './store.js';
import * as theme from './theme.js';

/** 管理员入口的 pathname（后端把同一个 HTML 挂在这里）。 */
export const ADMIN_PATH = router.ADMIN_PATH;

/** 路径 → 入口。非 /admin 一律算用户入口（行为清单 8.1）。 */
export function portalFromPath(pathname) {
  return String(pathname || '').replace(/\/+$/, '') === ADMIN_PATH ? 'admin' : 'user';
}

/** 视图名。store.view 的取值与路由同名，视图层按它挂载。 */
export const ROUTE_VIEWS = {
  login: 'login',
  library: 'library',
  photo: 'photo',
  admin: 'admin',
};

/** 登录后该去的 hash（管理员入口去 #/admin，用户入口去 #/library）。 */
export function workspaceHash(portal) {
  return portal === 'admin' ? '#/admin' : '#/library';
}

/** 启动期被暂存的路由（鉴权结果出来之前不做跳转判决，见 applyRoute 的说明）。 */
let deferredRoute = null;

/**
 * 把路由结果写进 store（视图层只订阅 store，不直接碰 hash）。
 * 未登录访问需要登录的路由 → 挡回 #/login；已登录访问 #/login → 送回工作区。
 */
export function applyRoute(route) {
  const state = store.getState();

  // 启动期暂存（0.8 的鉴权还没回来时不做跳转判决）。
  // 为什么必须有这一段：启动顺序是「先起路由监听、再问 /api/auth/me」，所以在鉴权结果
  // 回来之前 state.user 必然是 null，而这里的每一条"未登录就回 #/login"都会把用户
  // **直接深链进来的地址**冲掉——实测 #/photo/:id 会被改写成 #/library，详情再也打不开。
  // 注意 #/admin 那条路不会暴露这个问题（syncHashWithSession 会把它补回去），
  // 所以这个坑只在详情路由上显形。
  if (state.view === 'loading') {
    deferredRoute = route;
    return route;
  }

  // 未知 hash（含手输的错地址）→ 按登录态回默认路由
  if (!route.name) {
    router.navigate(state.user ? workspaceHash(state.portal) : '#/login', { replace: true });
    return route;
  }

  if (route.name === 'photo') store.setRouteParams(route.params);

  const view = ROUTE_VIEWS[route.name];
  if (view !== 'login' && !state.user) {
    store.setView('login');
    router.navigate('#/login', { replace: true });
    return route;
  }
  if (view === 'login' && state.user) {
    router.navigate(workspaceHash(state.portal), { replace: true });
    return route;
  }
  if (view === 'admin' && state.user && !state.user.is_admin) {
    // 行为清单 8.3：管理员入口下用非管理员账号 → 报错并回登录态
    store.resetToLogin();
    store.setAuthError('请使用管理员账号登录');
    router.navigate('#/login', { replace: true });
    return route;
  }
  store.setView(view);
  return route;
}

/** 登录态变化后把地址栏同步到对应路由（登出 → #/login，登录 → 工作区）。 */
function syncHashWithSession(state) {
  const route = router.current();
  if (state.user) {
    if (!route.name || route.name === 'login') {
      router.navigate(workspaceHash(state.portal), { replace: true });
    }
    return;
  }
  if (route.name !== 'login') router.navigate('#/login', { replace: true });
}

/**
 * 0.8 启动流程：GET /api/auth/me → 成功进工作区，失败回登录态。
 * @returns {Promise<object|null>} 用户对象或 null
 */
export async function bootAuthCheck() {
  try {
    const user = await api.get('/auth/me');
    if (store.getState().portal === 'admin' && user && !user.is_admin) {
      // 行为清单 8.3：管理员入口不接受普通账号
      store.resetToLogin();
      store.setAuthError('请使用管理员账号登录');
      return null;
    }
    store.enterWorkspace(user);
    return user;
  } catch (error) {
    store.resetToLogin();
    // 未登录（401）是启动时的正常分支，不打扰；其它错误（网络/500）要看得见。
    const expected = error instanceof ApiError && (error.status === 401 || error.status === 403);
    if (!expected) store.toast(error && error.message ? error.message : String(error));
    return null;
  }
}

/**
 * 应用启动入口。
 * @param {{location?: Location, stopRouter?: boolean}} [options]
 * @returns {Promise<{user: object|null, route: object, portal: string}>}
 */
export async function boot(options = {}) {
  const loc = options.location || (typeof location !== 'undefined' ? location : null);
  if (!loc) throw new Error('boot() 需要一个 location');
  deferredRoute = null;      // 重复 boot（自测页的"重启"按钮）不要沿用上一轮的暂存路由

  // 1. 入口：靠路径判定（8.1）
  store.setPortal(portalFromPath(loc.pathname));

  // 2. 主题：localStorage + 跟随系统（第 9 条）
  theme.initTheme();

  // 3. /admin 且 hash 为空 → 补 #/admin（第 8 条）
  router.applyPathAlias(loc);

  // 4. 路由：hash → store.view（重复 boot 时先摘掉旧监听，避免叠加）
  const unsubscribers = [store.subscribe((state, reason) => {
    if (reason === 'session') syncHashWithSession(state);
  })];
  router.stop();
  router.start({ onChange: applyRoute, loc });

  // 5. 登录态（0.8）
  const user = await bootAuthCheck();

  // 5b. 鉴权结果已就位：把启动期暂存的那条路由**用真实登录态**再判一次。
  //     不补这一步，直接深链进来的 #/photo/:id 会在第 4 步就被改写成 #/login，
  //     登录成功后又落到 #/library —— 详情地址等于打不开。
  if (deferredRoute) {
    const pending = deferredRoute;
    deferredRoute = null;
    applyRoute(pending);
  }

  // 6. hash 为空（非 /admin 场景）→ 按登录态落默认路由
  if (!loc.hash || loc.hash === '#') {
    router.navigate(user ? workspaceHash(store.getState().portal) : '#/login', { replace: true, loc });
  }

  return { user, route: router.current(loc), portal: store.getState().portal, unsubscribers };
}

/* 便于在 next.html 自测页里一次性拿到全部模块。 */
export const modules = { api, store, router, theme };

export default { boot, bootAuthCheck, applyRoute, portalFromPath, workspaceHash, modules };
