/* ==========================================================================
   AIbum · 状态容器  web/js/store.js
   --------------------------------------------------------------------------
   阶段 1（新前端骨架）：只放"与界面无关"的状态与全局机制，不含任何视图。

   对照 docs/前端-行为清单.md 第 0 节：
     0.4 过期响应丢弃  → accountVersion 计数器（getAccountVersion / handleUnauthorized）
     0.5 结果版本控制  → resultVersion 计数器（newResultToken / isResultTokenCurrent）
     0.6 全局通知      → toast()，7 秒后自动消失，新消息重置计时
     0.7 统一异常包装  → guard()

   约定：
   - 本文件是唯一的状态写入点；视图只读（getState）不下手改字段，改动一律走导出的函数。
   - 任何改动都会 emit() 通知订阅者，订阅者自己去渲染（订阅式重渲染）。
   - 本文件不碰 document / window（除了存储和定时器），因此可以被 node 直接 import 做单测。
   ========================================================================== */

/* --------------------------------------------------------------------------
   1) 常量：限制与字典集中在此（行为清单 §11「一处写死，避免散落」）
   -------------------------------------------------------------------------- */

/** 通知自动消失时间（行为清单 0.6 / §11）。 */
export const NOTIFY_MS = 7000;

/** 可选标签上限（行为清单 2.5 / §11）。 */
export const MAX_SELECTED_TAGS = 30;

/** 单张图片上限（行为清单 4.4 / §11），单位字节。 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 参考图允许的类型（行为清单 3.11）。 */
export const REFERENCE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** 检索返回上限（行为清单 3.1 / §11）。 */
export const SEARCH_LIMIT = 100;

/** 健康状况轮询间隔（行为清单 9.1 / §11），页面隐藏时暂停由视图负责。 */
export const HEALTH_POLL_MS = 4000;

/** 账户切换后在途请求被丢弃时的提示（行为清单 0.4）。 */
export const MESSAGE_ACCOUNT_CHANGED = '账户状态已更新，请重试';

/** 照片状态字典（行为清单 §10）。 */
export const STATUS_LABELS = {
  pending: '等待分析',
  processing: '分析中',
  ready: '已分析',
  failed: '分析失败',
  deleting: '删除中',
};

/** 匹配严格度字典（行为清单 §10）。 */
export const STRICTNESS_LABELS = { broad: '宽松', balanced: '适中', strict: '严格' };

/** 排序字典（行为清单 2.2）。 */
export const ORDER_LABELS = { newest: '最新在前', oldest: '最早在前' };

/** 六个筛选维度（行为清单 2.2 / 2.3）：参数构造必须"先删这 6 个键再重新设置"。 */
export const FILTER_KEYS = ['album_id', 'location', 'start', 'end', 'favorite', 'tags'];

/** 状态名 → 中文（未知状态原样返回）。 */
export function statusName(status) {
  return STATUS_LABELS[status] || status || '';
}

/* --------------------------------------------------------------------------
   2) 状态本体
   -------------------------------------------------------------------------- */

/** 空的筛选条件（行为清单 2.10：排序回 newest、标签清空）。 */
function emptyFilters() {
  return { album_id: '', location: '', start: '', end: '', favorite: false, tags: [], order: 'newest' };
}

/** 空的结果集（浏览模式）。 */
function emptyResults() {
  return { items: [], total: 0, page: 1, mode: 'browse', query: null, summary: null, loading: false, error: null };
}

const state = {
  /** 'user' | 'admin'：由启动时的 location.pathname 决定（行为清单 8.1）。 */
  portal: 'user',
  /** 'loading' | 'login' | 'library' | 'photo' | 'admin'：当前视图，由 router 驱动。 */
  view: 'loading',
  /** {id, username, is_admin} 或 null。 */
  user: null,
  /** 登录/注册表单的错误文案（认证视图消费）。 */
  authError: '',
  /** 六维筛选 + 排序。 */
  filters: emptyFilters(),
  /** 选中集：照片 id 的 Set（行为清单 5.x）。 */
  selected: new Set(),
  /** 结果集：列表/检索共用一个容器，mode 区分。 */
  results: emptyResults(),
  /** 路由参数，例如 #/photo/:id 的 {id}。 */
  routeParams: {},
  /** 详情数据（阶段 3.3 填充）。 */
  detail: null,
  /** 管理后台的用户列表（阶段 3.4 填充）。登出必须清空它——行为清单 1.5 明写"用户列表"。 */
  users: [],
  /** GET /api/health 的结果（阶段 3.x 填充）。 */
  health: null,
  /** 是否有互斥的长任务在跑（上传/批量/检索）。 */
  busy: false,
  /** 顶部提示条：{text, visible, at}。 */
  toast: { text: '', visible: false, at: 0 },
  /** 0.4 账户版本：每次登录/登出/切回登录态递增，用于丢弃在途请求。 */
  accountVersion: 0,
  /** 0.5 结果版本：每次发起新的结果查询递增，用于丢弃旧响应。 */
  resultVersion: 0,
};

/** 只读快照入口。视图请只读，不要直接赋值。 */
export function getState() {
  return state;
}

/* --------------------------------------------------------------------------
   3) 订阅式通知
   -------------------------------------------------------------------------- */

const listeners = new Set();

/**
 * 订阅状态变化。
 * @param {(state, reason, detail) => void} listener
 * @param {{immediate?: boolean}} [options] immediate=true 时立即用当前状态回调一次
 * @returns {() => void} 取消订阅
 */
export function subscribe(listener, options = {}) {
  if (typeof listener !== 'function') throw new TypeError('subscribe 需要一个函数');
  listeners.add(listener);
  if (options.immediate) listener(state, 'subscribe', undefined);
  return () => listeners.delete(listener);
}

/**
 * 广播一次状态变化。reason 是给订阅者的粗粒度提示，例如
 * 'toast' | 'view' | 'session' | 'filters' | 'selection' | 'results'。
 */
export function emit(reason = 'update', detail) {
  for (const listener of [...listeners]) {
    try {
      listener(state, reason, detail);
    } catch (error) {
      // 一个订阅者出错不能影响其它订阅者，也不能静默吞掉。
      console.error('[store] 订阅者抛出异常', error);
    }
  }
}

/* --------------------------------------------------------------------------
   4) 全局通知（0.6）：7 秒后自动消失，新消息重置计时
   -------------------------------------------------------------------------- */

let toastTimer = null;

/**
 * 顶部提示条。同一条消息重复触发也会重置计时（先 clearTimeout）。
 * @param {string} text
 * @param {{timeout?: number}} [options] 仅测试用，可覆盖 7 秒
 */
export function toast(text, options = {}) {
  const timeout = Number.isFinite(options.timeout) ? options.timeout : NOTIFY_MS;
  state.toast = { text: String(text ?? ''), visible: true, at: Date.now() };
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = null;
    state.toast = { ...state.toast, visible: false };
    emit('toast', state.toast);
  }, timeout);
  emit('toast', state.toast);
  return state.toast;
}

/** 立即收起提示条（视图的"关闭"按钮用）。 */
export function dismissToast() {
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = null;
  state.toast = { ...state.toast, visible: false };
  emit('toast', state.toast);
}

/** 旧前端叫 notice()，这里保留同名别名，便于逐行对照 web/legacy/app.js。 */
export const notice = toast;

/**
 * 统一异常包装（0.7）：所有事件处理器包一层，异常转成通知条，不静默。
 * @param {(...args) => any} handler
 */
export function guard(handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      toast(error && error.message ? error.message : String(error));
      return undefined;
    }
  };
}

/* --------------------------------------------------------------------------
   5) 账户版本（0.4）与会话生命周期
   -------------------------------------------------------------------------- */

/** 读取当前账户版本，请求发出前记下它，响应回来后再比对。 */
export function getAccountVersion() {
  return state.accountVersion;
}

/** 手动递增账户版本（账户切换的通用出口，enterWorkspace / resetToLogin 内部也会调）。 */
export function bumpAccountVersion() {
  state.accountVersion += 1;
  state.resultVersion += 1;
  return state.accountVersion;
}

function clearSelectedSet() {
  state.selected = new Set();
}

function clearResults() {
  state.results = emptyResults();
}

/** 进入登录态（0.3 / 1.5）：清空用户、照片、选中、筛选、详情、用户列表。 */
export function resetToLogin() {
  bumpAccountVersion();
  state.user = null;
  state.view = 'login';
  state.busy = false;
  state.detail = null;
  state.health = null;
  state.users = [];
  state.filters = emptyFilters();
  clearSelection();
  clearResults();
  emit('session', { view: 'login' });
  return state;
}

/** 已登录却收到 401 时的处理（api.js 调用）——立刻切回登录态。 */
export function handleUnauthorized() {
  resetToLogin();
  return state;
}

/**
 * 进入工作区（登录成功 / 启动时 /auth/me 成功）。
 * 递增双计数器，保证上一个账户的在途请求与旧结果全部作废。
 */
export function enterWorkspace(user) {
  bumpAccountVersion();
  state.user = user
    ? { id: user.id, username: user.username, is_admin: Boolean(user.is_admin) }
    : null;
  state.authError = '';
  state.view = state.portal === 'admin' ? 'admin' : 'library';
  state.busy = false;
  state.detail = null;
  state.health = null;
  state.users = [];
  state.filters = emptyFilters();
  state.routeParams = {};
  clearSelection();
  clearResults();
  emit('session', { view: state.view });
  return state;
}

/* --------------------------------------------------------------------------
   6) 视图 / 入口 / 路由参数
   -------------------------------------------------------------------------- */

/** 'user' | 'admin'：管理员入口靠路径判定（行为清单 8.1），启动时注入。 */
export function setPortal(portal) {
  state.portal = portal === 'admin' ? 'admin' : 'user';
  emit('portal', state.portal);
  return state.portal;
}

export function setView(view) {
  if (state.view === view) return state.view;
  state.view = view;
  emit('view', view);
  return view;
}

export function setRouteParams(params) {
  state.routeParams = params || {};
  emit('route', state.routeParams);
  return state.routeParams;
}

export function setAuthError(message) {
  state.authError = message || '';
  emit('authError', state.authError);
  return state.authError;
}

export function setBusy(busy) {
  state.busy = Boolean(busy);
  emit('busy', state.busy);
  return state.busy;
}

/* --------------------------------------------------------------------------
   7) 筛选条件（行为清单 2.2 / 2.5 / 2.10）
   -------------------------------------------------------------------------- */

export function getFilters() {
  return state.filters;
}

/** 单一维度写入；favorite 统一成布尔，tags 不走这里（用 toggleTag）。 */
export function setFilter(key, value) {
  if (key === 'tags') throw new Error('标签请使用 toggleTag / setTags');
  if (!Object.prototype.hasOwnProperty.call(state.filters, key)) throw new Error('未知筛选维度：' + key);
  state.filters[key] = key === 'favorite' ? Boolean(value) : value == null ? '' : String(value);
  emit('filters', state.filters);
  return state.filters;
}

export function setTags(names) {
  state.filters.tags = [...new Set((names || []).map(String))].slice(0, MAX_SELECTED_TAGS);
  emit('filters', state.filters);
  return state.filters.tags;
}

/**
 * 勾选/取消一个标签。超出上限时抛错，由调用方 guard() 转成通知条
 * （行为清单 2.5：超出则取消勾选并报"最多选择 30 个标签"）。
 */
export function toggleTag(name, checked) {
  const tags = new Set(state.filters.tags);
  if (checked) {
    if (!tags.has(name) && tags.size >= MAX_SELECTED_TAGS) throw new Error(`最多选择 ${MAX_SELECTED_TAGS} 个标签`);
    tags.add(name);
  } else {
    tags.delete(name);
  }
  state.filters.tags = [...tags];
  emit('filters', state.filters);
  return state.filters.tags;
}

/** 清空所有筛选（行为清单 2.10）：六个维度 + 排序回 newest + 标签清空。 */
export function resetFilters() {
  state.filters = emptyFilters();
  emit('filters', state.filters);
  return state.filters;
}

/* --------------------------------------------------------------------------
   8) 选中集（行为清单 5.1 - 5.5）
   -------------------------------------------------------------------------- */

export function getSelectedIds() {
  return [...state.selected];
}

export function isSelected(id) {
  return state.selected.has(id);
}

export function toggleSelected(id, checked) {
  if (checked === undefined ? !state.selected.has(id) : checked) state.selected.add(id);
  else state.selected.delete(id);
  emit('selection', state.selected);
  return state.selected;
}

/** 全选当前已加载的全部（5.2）。 */
export function selectAll(ids) {
  state.selected = new Set(ids || state.results.items.map(item => item.id));
  emit('selection', state.selected);
  return state.selected;
}

export function clearSelection() {
  clearSelectedSet();
  emit('selection', state.selected);
}

/**
 * 选中集自动收敛（5.5）：重新渲染后剔除已不在当前结果集里的 id。
 * @param {Array<string|number>} ids 当前结果集里的 id
 */
export function pruneSelection(ids) {
  const alive = new Set(ids);
  const next = new Set([...state.selected].filter(id => alive.has(id)));
  if (next.size !== state.selected.size) {
    state.selected = next;
    emit('selection', state.selected);
  }
  return state.selected;
}

/* --------------------------------------------------------------------------
   9) 结果集 + 结果版本（0.5）
   -------------------------------------------------------------------------- */

/**
 * 发起一次新的结果查询前调用，拿到本次请求的 token。
 * 响应回来时用 isResultTokenCurrent(token) 判断是否已被更新的请求取代。
 */
export function newResultToken() {
  state.resultVersion += 1;
  return state.resultVersion;
}

/** 该 token 是否仍是最新的（false = 旧响应，必须丢弃，不得覆盖新结果）。 */
export function isResultTokenCurrent(token) {
  return token === state.resultVersion;
}

/** 作废所有在途结果（不发起新查询，例如清空筛选前）。 */
export function invalidateResults() {
  state.resultVersion += 1;
  return state.resultVersion;
}

/**
 * 直接把一次查询包成"最新者胜"：过期的响应会被丢弃并返回 {stale:true}。
 * 视图层用这个最省事：
 *   const out = await store.latest(() => api.get('/photos'));
 *   if (!out.stale) render(out.value);
 */
export async function latest(loader) {
  const token = newResultToken();
  const value = await loader(token);
  if (!isResultTokenCurrent(token)) return { stale: true, value: undefined, token };
  return { stale: false, value, token };
}

export function setResultsLoading(loading) {
  state.results.loading = Boolean(loading);
  emit('results', state.results);
}

export function setResultsError(error) {
  state.results.error = error ? (error.message || String(error)) : null;
  emit('results', state.results);
}

/**
 * 写入结果集。
 * @param {{items: any[], total: number, page?: number, mode?: string, query?: any, summary?: any, append?: boolean}} data
 */
export function setResults(data) {
  const items = data.append ? [...state.results.items, ...(data.items || [])] : (data.items || []);
  state.results = {
    items,
    total: Number.isFinite(data.total) ? data.total : items.length,
    page: data.page ?? 1,
    mode: data.mode || 'browse',
    query: data.query ?? null,
    summary: data.summary ?? null,
    loading: false,
    error: null,
  };
  pruneSelection(items.map(item => item.id));
  emit('results', state.results);
  return state.results;
}

export function setDetail(photo) {
  state.detail = photo || null;
  emit('detail', state.detail);
  return state.detail;
}

export function setHealth(health) {
  state.health = health || null;
  emit('health', state.health);
  return state.health;
}

/** 管理后台的用户列表（阶段 3.4 用；登出时由 resetToLogin 清空）。 */
export function setUsers(users) {
  state.users = Array.isArray(users) ? [...users] : [];
  emit('users', state.users);
  return state.users;
}

/* --------------------------------------------------------------------------
   10) 测试与调试用：整体重置（只给 next.html 自测页和单测用）
   -------------------------------------------------------------------------- */

export function __resetForTests() {
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = null;
  bumpAccountVersion();
  state.portal = 'user';
  state.view = 'loading';
  state.user = null;
  state.authError = '';
  state.filters = emptyFilters();
  clearSelection();
  clearResults();
  state.routeParams = {};
  state.detail = null;
  state.health = null;
  state.users = [];
  state.busy = false;
  state.toast = { text: '', visible: false, at: 0 };
  emit('reset');
}
