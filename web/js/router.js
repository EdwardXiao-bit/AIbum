/* ==========================================================================
   AIbum · 路由层  web/js/router.js
   --------------------------------------------------------------------------
   阶段 1（新前端骨架）。hash 路由单页（重构计划 D6 已定）：
     #/login     登录 / 注册 / 找回密码
     #/library   相册主界面（默认）
     #/photo/:id 照片详情
     #/admin     管理后台

   硬性要求（阶段 1 第 8 条 / 行为清单 Q1）：
     后端把同一个 HTML 也挂在 /admin 路径上，所以访问 /admin（pathname 是 /admin、
     hash 为空）时必须自动补成 #/admin —— 旧书签不能失效。
     实现见 pathAliasHash() / applyPathAlias()，boot 时调用一次。

   本文件的解析函数是纯函数，可被 node 直接 import 做单测；
   只有 start()/navigate() 才碰 window.location。
   ========================================================================== */

/** 默认路由（hash 为空且非 /admin 时用）。 */
export const DEFAULT_HASH = '#/library';

/** 管理员入口的 pathname（后端挂载点）。 */
export const ADMIN_PATH = '/admin';

/**
 * 路由表。pattern 里 ':name' 是路径参数。
 * @type {{name: string, pattern: string}[]}
 */
export const ROUTES = [
  { name: 'login', pattern: '#/login' },
  { name: 'library', pattern: '#/library' },
  { name: 'photo', pattern: '#/photo/:id' },
  { name: 'admin', pattern: '#/admin' },
];

/** 视图名 → 默认 hash（main.js 装配路由用）。 */
export function hrefFor(name, params = {}) {
  const route = ROUTES.find(item => item.name === name);
  if (!route) throw new Error('未知路由：' + name);
  return route.pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    const value = params[key];
    if (value === undefined || value === null || value === '') throw new Error(`路由 ${name} 缺少参数 ${key}`);
    return encodeURIComponent(String(value));
  });
}

function splitPattern(pattern) {
  return pattern.replace(/^#\/?/, '').split('/').filter(Boolean);
}

/**
 * 解析 hash。
 * @param {string} hash 例如 '#/photo/abc?x=1'（允许省略前导 #）
 * @returns {{hash: string, path: string, name: string|null, params: Record<string,string>,
 *           query: Record<string,string>, known: boolean}}
 */
export function parseHash(hash) {
  const raw = String(hash || '');
  const withoutHash = raw.startsWith('#') ? raw.slice(1) : raw;
  const [pathPart, queryPart] = withoutHash.split('?');
  const path = '/' + pathPart.replace(/^\/+/, '').replace(/\/+$/, '');
  const query = {};
  if (queryPart) {
    for (const [key, value] of new URLSearchParams(queryPart)) query[key] = value;
  }
  const segments = path.split('/').filter(Boolean);
  for (const route of ROUTES) {
    const pattern = splitPattern(route.pattern);
    if (pattern.length !== segments.length) continue;
    const params = {};
    const matched = pattern.every((token, index) => {
      if (token.startsWith(':')) {
        params[token.slice(1)] = decodeURIComponent(segments[index]);
        return true;
      }
      return token === segments[index];
    });
    if (matched) return { hash: '#/' + segments.join('/'), path, name: route.name, params, query, known: true };
  }
  // 空 hash 视为"还没路由"，不算未知
  if (!segments.length) return { hash: '', path: '/', name: null, params: {}, query, known: false };
  return { hash: '#/' + segments.join('/'), path, name: null, params: {}, query, known: false };
}

/**
 * /admin 路径别名（阶段 1 第 8 条）：
 * pathname 是 /admin 且 hash 为空 → 应补成 '#/admin'。纯函数，便于单测。
 * @returns {string|null} 需要补的 hash；不需要补时为 null
 */
export function pathAliasHash(pathname, hash) {
  const isAdminPath = String(pathname || '').replace(/\/+$/, '') === ADMIN_PATH;
  const emptyHash = hash === '' || hash === '#' || hash === undefined || hash === null;
  return isAdminPath && emptyHash ? '#/admin' : null;
}

/**
 * 在浏览器里执行上面的别名规则。
 * 用 location.replace('#/admin') 而不是跳转新地址：路径仍是 /admin，只是补上 hash，
 * 不产生多余的历史记录、也不重新加载页面（书签 /admin 与 /admin#/admin 都能落到同一视图）。
 * @returns {boolean} 是否补过
 */
export function applyPathAlias(loc = typeof location !== 'undefined' ? location : null) {
  if (!loc) return false;
  const target = pathAliasHash(loc.pathname, loc.hash);
  if (!target) return false;
  loc.replace(target);
  return true;
}

/* --------------------------------------------------------------------------
   浏览器侧：监听与跳转
   -------------------------------------------------------------------------- */

let listener = null;
let handler = null;

/** 当前路由（未启动时也能调用）。 */
export function current(loc = typeof location !== 'undefined' ? location : null) {
  return parseHash(loc ? loc.hash : '');
}

/**
 * 开始监听 hash 变化，并立即回调一次当前路由。
 * @param {{onChange: (route: ReturnType<typeof parseHash>) => void,
 *          fallback?: string, loc?: Location, win?: Window}} options
 * @returns {() => void} 停止监听
 */
export function start(options = {}) {
  const loc = options.loc || (typeof location !== 'undefined' ? location : null);
  const win = options.win || (typeof window !== 'undefined' ? window : null);
  if (!loc || !win) return () => {};
  handler = options.onChange || (() => {});
  listener = () => {
    const route = parseHash(loc.hash);
    if (!route.name && options.fallback) {
      navigate(options.fallback, { replace: true, loc });
      return;
    }
    handler(route);
  };
  win.addEventListener('hashchange', listener);
  win.addEventListener('popstate', listener);
  listener();
  return stop;
}

/** 停止监听（幂等）。 */
export function stop() {
  if (!listener || typeof window === 'undefined') {
    listener = null;
    handler = null;
    return;
  }
  window.removeEventListener('hashchange', listener);
  window.removeEventListener('popstate', listener);
  listener = null;
  handler = null;
}

/**
 * 跳转。replace=true 时不产生历史记录。
 * 传 'library' 这种视图名也行，传 '#/photo/abc' 也行。
 */
export function navigate(target, options = {}) {
  const loc = options.loc || (typeof location !== 'undefined' ? location : null);
  if (!loc) return false;
  const hash = target.startsWith('#') ? target : hrefFor(target, options.params || {});
  if (loc.hash === hash) {
    // hash 没变不会触发 hashchange，手动补一次回调
    if (handler) handler(parseHash(hash));
    return true;
  }
  if (options.replace) loc.replace(hash);
  else loc.hash = hash;
  return true;
}

export default {
  ROUTES, DEFAULT_HASH, ADMIN_PATH,
  hrefFor, parseHash, pathAliasHash, applyPathAlias,
  current, start, stop, navigate,
};
