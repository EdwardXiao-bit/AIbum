/* ==========================================================================
   AIbum · 管理后台视图  web/js/views/admin.js
   --------------------------------------------------------------------------
   阶段 3.5。逐条对照 docs/前端-行为清单.md 第 8 节（8.2–8.9）与第 9 节 9.4：

     8.2 管理员登录    POST /admin/login —— 在 views/auth.js（本卡只复核，不改）
     8.3 非管理员拦截  —— main.js 的 applyRoute / bootAuthCheck（本卡只复核，不改）
     8.4 后台文案覆盖  —— views/auth.js 的 ADMIN_COPY + 外壳 app.js 的 applyPortalChrome
     8.5 统计卡片      GET /admin/overview → 用户总数/活跃数、照片总数/失败数、
                       模型是否安装、照片存储 MiB（文案逐字对齐 legacy/app.js L267-270）
     8.6 用户表        GET /admin/users → 用户名（管理员加「 · 管理员」后缀）、注册日期、
                       `${照片数} / 500`、正常/已停用（legacy L278）
     8.7 表格筛选      用户名关键字 + 状态（all/active/disabled）**纯前端过滤**（legacy L273-274）
     8.8 启停用户      PATCH /admin/users/{id} {active}；停用前必须确认
                       「停用后该用户将被退出登录，照片保留。确定继续？」（legacy L280）
     8.9 管理员不可操作自己 —— 管理员行不渲染按钮，显示「—」（legacy L280-281）
     9.4 管理台不轮询  —— 本文件里**没有** setInterval / 定时器；数据只在进入视图时加载一次，
                       之后靠「刷新数据」按钮（旧版 L236 的 `if (!state.user || adminPortal) return`
                       就等价于"后台不跑健康轮询"）

   三个实现取舍（写在这里，免得后来者以为是漏了）：

   1) 确认框用共享遮罩里的 .dialog，**不用原生 confirm()**。
      与 5.8（批量删除，views/library.js 的 confirmDelete）同一套做法，理由也一样：
      主题一致、可访问性统一，且验收脚本能直接读 DOM。
      文案本身逐字照抄 legacy：'停用后该用户将被退出登录，照片保留。确定继续？'
      （调用方没给 modals 时退回 window.confirm，行为等价。）

   2) 「已停用」筛选项的 value 取 legacy 的 'disabled'（web/index.html L47），
      而**行为清单 §8.7 把它写成了 'inactive'**。两者都接受（见 filterUsers 的最后一个分支），
      但 DOM 里的 value 以「已被真实后端验证过的旧前端」为准 —— 旧前端是一份可执行规格。

   3) 加载失败时**不清空**统计卡片：旧版刷新失败只弹通知、旧数字留在屏上（legacy L285
      的 guard(loadUsers) 直接抛出，renderUsers 不会跑）。首次加载失败时卡片本来就是
      「—」占位，所以两种情形都对。唯一主动清空的地方是 resetLocal()（登出/换账户）。

   CSP（行为清单 §0A）：全部 h()/createElement + addEventListener，没有内联脚本 / 内联样式 /
   style 属性 / 内联事件；动态样式只走切类名与 data-* 属性。
   ========================================================================== */

import { api } from '../api.js';
import * as store from '../store.js';
import { h, setText } from '../components/dom.js';
import { createSelectMenu } from '../components/select-menu.js';

/* --------------------------------------------------------------------------
   1) 文案与常量（逐字对齐 legacy/index.html L43-47 与 legacy/app.js L265-292）
   -------------------------------------------------------------------------- */

export const ADMIN_COPY = {
  eyebrow: 'ADMINISTRATION',
  title: '管理控制台',
  lead: '管理账户、查看使用情况与服务状态。',
  refresh: '刷新数据',
  usersHead: '用户管理',
  searchPlaceholder: '搜索用户名',
  searchLabel: '搜索用户名',
  statusLabel: '账户状态筛选',
  note: '停用账户后立即退出所有会话，用户照片会保留。',
  columns: ['用户', '注册日期', '照片数量', '状态', '操作'],
  empty: '没有符合条件的用户。',
  statLabels: { users: '注册用户', active: '正常账户', photos: '照片总量', failed: '分析失败' },
  modelInstalled: '图文模型已安装',
  modelMissing: '图文模型尚未安装',
  stateActive: '正常',
  stateInactive: '已停用',
  enable: '启用',
  disable: '停用',
  /** 管理员行的"不可操作"占位（legacy L281：action.textContent = '—'）。 */
  dash: '—',
  /** 管理员用户名的后缀（legacy L278）。注意是「空格 + 中点 + 管理员」。 */
  adminSuffix: ' · 管理员',
  confirmTitle: '停用账户',
  confirmSub: '停用会立即结束该用户的所有登录会话。',
  confirmSubmit: '确定停用',
};

/** 8.8 的确认文案，逐字对齐 legacy/app.js L280。导出以便验收脚本逐字比对。 */
export const DISABLE_CONFIRM = '停用后该用户将被退出登录，照片保留。确定继续？';

/** 每账户照片上限（行为清单 §11：管理台显示 `N / 500`）。 */
export const PHOTO_QUOTA = 500;

/** 8.7 的状态筛选三档。value 取 legacy（'disabled'），label 取行文（全部/正常/已停用）。 */
export const STATUS_FILTERS = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '正常' },
  { value: 'disabled', label: '已停用' },
];

/* --------------------------------------------------------------------------
   2) 纯函数（无 DOM / 无请求 → 可被 node 直接 import 做单测）
   -------------------------------------------------------------------------- */

/** 数值 → 文本，非数字一律显示占位「—」（后端字段缺失时不显示 "NaN"）。 */
function numberText(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : ADMIN_COPY.dash;
}

/** 8.6：用户名（管理员加后缀）。 */
export function userLabel(user) {
  if (!user) return '';
  return String(user.username ?? '') + (user.is_admin ? ADMIN_COPY.adminSuffix : '');
}

/** 8.6：注册日期取前 10 位（legacy L278 的 `created_at.slice(0,10)`），即 YYYY-MM-DD。 */
export function createdDate(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return text ? text.slice(0, 10) : ADMIN_COPY.dash;
}

/** 8.6：`照片数 / 500`。 */
export function quotaLabel(count) {
  return `${numberText(count === undefined || count === null ? 0 : count)} / ${PHOTO_QUOTA}`;
}

/** 8.6：状态列文案。 */
export function stateLabel(active) {
  return active ? ADMIN_COPY.stateActive : ADMIN_COPY.stateInactive;
}

/** 8.5：`照片存储 N.N MiB`（legacy L270，toFixed(1) 必须保留）。 */
export function storageLabel(bytes) {
  const number = Number(bytes);
  const mib = Number.isFinite(number) ? number / 1024 / 1024 : 0;
  return `照片存储 ${mib.toFixed(1)} MiB`;
}

/** 8.5：模型是否安装（legacy L269）。 */
export function modelLabel(installed) {
  return installed ? ADMIN_COPY.modelInstalled : ADMIN_COPY.modelMissing;
}

/**
 * 8.5：GET /admin/overview → 界面上要显示的 6 个值。纯映射，便于单测与验收。
 * 后端形状（app/main.py L323-329）：
 *   {users:{total,active}, photos:{total,bytes,failed}, model:{installed,ready,...}}
 * @returns {{users: string, active: string, photos: string, failed: string, model: string, storage: string}}
 */
export function overviewView(overview) {
  const users = (overview && overview.users) || {};
  const photos = (overview && overview.photos) || {};
  const model = (overview && overview.model) || {};
  return {
    users: numberText(users.total),
    active: numberText(users.active),
    photos: numberText(photos.total),
    failed: numberText(photos.failed),
    model: modelLabel(Boolean(model.installed)),
    storage: storageLabel(photos.bytes),
  };
}

/**
 * 8.7：纯前端过滤。
 *   - 用户名：去空 + 小写 + 包含匹配（legacy L273-274）
 *   - 状态：'all' 全放；'active' 只留正常；其余（'disabled' / 'inactive' / 任何未知值）
 *     都按 legacy 的 `!u.active` 处理 —— 这样行为清单 §8.7 的 'inactive' 与
 *     旧前端的 'disabled' 两种写法都能工作，不会因为一个拼写差异静默筛出空表。
 * @param {Array<object>} users
 * @param {string} keyword
 * @param {string} status
 */
export function filterUsers(users, keyword = '', status = 'all') {
  const needle = String(keyword ?? '').trim().toLowerCase();
  return (users || []).filter(user => {
    if (!user) return false;
    const name = String(user.username ?? '').toLowerCase();
    if (needle && !name.includes(needle)) return false;
    // 只有字面量 'all'（以及"没给状态"的 undefined/null）才是"全部"。
    // 注意**不**把空串当"全部"：旧版 L274 的 else 分支是 `!u.active`，
    // 空串在旧版里筛出的是"已停用"。既然旧前端是可执行规格，就照它来。
    if (status === undefined || status === null || status === 'all') return true;
    if (status === 'active') return Boolean(user.active);
    return !user.active;
  });
}

/** 8.8：按钮文案。 */
export function actionLabel(active) {
  return active ? ADMIN_COPY.disable : ADMIN_COPY.enable;
}

/** 8.8：按钮 class。停用是危险操作（legacy L280：className = user.active ? 'danger' : ''）。 */
export function actionClass(active) {
  return active ? 'btn btn--sm btn--danger' : 'btn btn--sm';
}

/* --------------------------------------------------------------------------
   3) 视图
   -------------------------------------------------------------------------- */

/**
 * 建管理后台视图。
 * @param {{modals?: {register(d: HTMLElement, o?: object): any, open(d: HTMLElement): any,
 *          close(d?: HTMLElement): any}}} [options]
 */
export function createAdminView(options = {}) {
  const modals = options.modals || null;

  /* ---------------- 8.5 统计卡片（4 张 + 服务行两项） ---------------- */

  /**
   * 一张统计卡。id 沿用旧前端的 id（stat-users / stat-active / stat-photos / stat-failed），
   * 好处是"新旧前端同一份验收脚本"能直接复用选择器。
   */
  function statCard(key, id) {
    const value = h('strong', { className: 'admin__stat-value', id, 'data-role': `stat-${key}-value`, text: ADMIN_COPY.dash });
    const card = h('div', { className: 'admin__stat', 'data-role': `stat-${key}` }, [
      h('span', { className: 'admin__stat-label', text: ADMIN_COPY.statLabels[key] }),
      value,
    ]);
    return { card, value };
  }

  const statNodes = {
    users: statCard('users', 'stat-users'),
    active: statCard('active', 'stat-active'),
    photos: statCard('photos', 'stat-photos'),
    failed: statCard('failed', 'stat-failed'),
  };
  const statKeys = Object.keys(statNodes);

  const modelStatus = h('span', {
    className: 'badge', id: 'admin-model-status', 'data-role': 'model-status',
    'data-state': 'unknown', text: ADMIN_COPY.dash,
  });
  const storage = h('span', { className: 'admin__storage', id: 'admin-storage', 'data-role': 'storage', text: ADMIN_COPY.dash });

  /* ---------------- 8.7 工具条：关键字 + 状态 ---------------- */

  const search = h('input', {
    className: 'input', id: 'admin-search', type: 'search', autocomplete: 'off',
    placeholder: ADMIN_COPY.searchPlaceholder, 'aria-label': ADMIN_COPY.searchLabel,
    'data-role': 'admin-search',
  });
  /* 8.7 状态筛选：设计系统的 .menu 形态（原生 <select> 的展开弹层是系统画的）。
     value 仍是 legacy 的 'all' / 'active' / 'disabled'，DOM id 不变。 */
  const statusFilter = createSelectMenu({
    id: 'admin-status-filter',
    label: ADMIN_COPY.statusLabel,
    dataRole: 'admin-status-filter',
    options: STATUS_FILTERS.map(item => ({ value: item.value, label: item.label })),
    value: 'all',
    document: options.document || document,
  });

  const refreshButton = h('button', {
    className: 'btn', id: 'admin-refresh', type: 'button',
    'data-role': 'admin-refresh', text: ADMIN_COPY.refresh,
  });
  /* ---------------- 8.6 用户表 ---------------- */

  const tbody = h('tbody', { id: 'admin-users', 'data-role': 'admin-users' });
  const table = h('table', { className: 'table admin__table', id: 'admin-table', 'data-role': 'admin-table' }, [
    h('thead', {}, [h('tr', {}, ADMIN_COPY.columns.map(text => h('th', { text })))]),
    tbody,
  ]);
  const emptyNode = h('p', {
    className: 'admin__empty', id: 'admin-empty', 'data-role': 'admin-empty',
    hidden: true, text: ADMIN_COPY.empty,
  });

  /* ---------------- 8.8 停用确认框（共享遮罩里的 .dialog） ---------------- */

  const confirmMessage = h('p', { className: 'admin__confirm-text', 'data-role': 'confirm-message', text: '' });
  const confirmForm = h('form', { className: 'stack', id: 'admin-confirm-form', 'data-role': 'confirm-form' }, [
    confirmMessage,
    h('div', { className: 'dialog__foot' }, [
      h('button', { className: 'btn btn--danger', type: 'submit', 'data-role': 'confirm-submit', text: ADMIN_COPY.confirmSubmit }),
      h('button', { className: 'btn btn--ghost', type: 'button', 'data-close': '', text: '取消' }),
    ]),
  ]);
  const confirmDialog = h('div', {
    className: 'dialog', id: 'dialog-admin-confirm', role: 'dialog', 'aria-modal': 'true',
    'aria-labelledby': 'admin-confirm-title', 'data-role': 'confirm-dialog', hidden: true,
  }, [
    h('div', { className: 'dialog__head' }, [
      h('div', {}, [
        h('div', { className: 'dialog__title', id: 'admin-confirm-title', text: ADMIN_COPY.confirmTitle }),
        h('div', { className: 'dialog__sub', text: ADMIN_COPY.confirmSub }),
      ]),
      h('button', {
        className: 'btn btn--icon btn--ghost dialog__close', type: 'button', 'data-close': '',
        'aria-label': '关闭', text: '✕',
      }),
    ]),
    confirmForm,
  ]);
  if (modals) modals.register(confirmDialog);

  /* ---------------- 组装 ---------------- */

  const root = h('section', { className: 'admin', id: 'admin-workspace', 'data-role': 'admin' }, [
    h('div', { className: 'admin__head' }, [
      h('div', { className: 'admin__head-text' }, [
        h('p', { className: 'eyebrow', text: ADMIN_COPY.eyebrow }),
        h('h1', { className: 'hero admin__title', text: ADMIN_COPY.title }),
        h('p', { className: 'lead admin__lead', text: ADMIN_COPY.lead }),
      ]),
      refreshButton,
    ]),
    h('div', {
      className: 'grid admin__stats', id: 'admin-stats', 'data-role': 'admin-stats',
      role: 'group', 'aria-label': '服务概况',
    }, statKeys.map(key => statNodes[key].card)),
    h('div', { className: 'admin__service', id: 'admin-service', 'data-role': 'admin-service' }, [modelStatus, storage]),
    h('section', { className: 'panel admin__users' }, [
      h('div', { className: 'admin__toolbar' }, [
        h('h2', { className: 'admin__users-title', text: ADMIN_COPY.usersHead }),
        search,
        statusFilter.element,
      ]),
      h('p', { className: 'admin__note', text: ADMIN_COPY.note }),
      h('div', { className: 'admin__table-scroll' }, [table]),
      emptyNode,
    ]),
    confirmDialog,
  ]);

  const nodes = {
    root, refreshButton, search, statusFilter: statusFilter.element, tbody, table, emptyNode,
    modelStatus, storage, confirmDialog, confirmForm, confirmMessage,
    statValues: Object.fromEntries(statKeys.map(key => [key, statNodes[key].value])),
  };

  /* ---------------- 局部状态 ---------------- */

  /** 本次挂载内"最新一次 load"的令牌：连点刷新时旧响应不得覆盖新结果（0.5 的用法）。 */
  let loadToken = 0;
  /** 是否正在加载（刷新按钮禁用 + 表格 aria-busy）。 */
  let loading = false;
  /** 最近一次加载失败的文案（null = 没失败）。 */
  let lastError = null;
  /** 是否已经成功加载过一次 —— 决定空态能不能显示（loading 中不该先说"没有符合条件的用户"）。 */
  let loadedOnce = false;
  let unsubscribe = null;

  /* ---------------- 渲染 ---------------- */

  function renderBusy() {
    refreshButton.disabled = loading;
    refreshButton.setAttribute('aria-busy', loading ? 'true' : 'false');
    table.setAttribute('aria-busy', loading ? 'true' : 'false');
  }

  /** 8.5：把 overview 写进统计卡片与两行服务信息。 */
  function renderOverview(overview) {
    const view = overviewView(overview);
    for (const key of statKeys) setText(statNodes[key].value, view[key]);
    const installed = Boolean(overview && overview.model && overview.model.installed);
    setText(modelStatus, view.model);
    modelStatus.dataset.state = installed ? 'ok' : 'warn';
    modelStatus.className = installed ? 'badge badge--ok' : 'badge badge--warn';
    setText(storage, view.storage);
  }

  /** 统计卡片退回占位（登出 / 换账户时用；加载失败**不**清空，见文件头的取舍 3）。 */
  function clearOverview() {
    for (const key of statKeys) setText(statNodes[key].value, ADMIN_COPY.dash);
    setText(modelStatus, ADMIN_COPY.dash);
    modelStatus.className = 'badge';
    modelStatus.dataset.state = 'unknown';
    setText(storage, ADMIN_COPY.dash);
  }

  /** 8.8：一行用户的操作单元格。管理员不渲染按钮，只放「—」（8.9）。 */
  function actionCell(user) {
    const cell = h('td', { 'data-role': 'action' });
    if (user.is_admin) {
      cell.append(h('span', { className: 'admin__dash', 'data-role': 'action-none', text: ADMIN_COPY.dash }));
      return cell;
    }
    const button = h('button', {
      className: actionClass(user.active),
      type: 'button',
      'data-role': 'toggle-user',
      'data-active': String(Boolean(user.active)),
      'aria-label': `${actionLabel(user.active)}账户 ${user.username}`,
      text: actionLabel(user.active),
    });
    button.addEventListener('click', store.guard(async () => {
      // 8.8：停用前必须确认；启用不需要（legacy 同此）。
      if (user.active) {
        const agreed = await confirmDisable();
        if (!agreed) return;
      }
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      try {
        await api.patch(`/admin/users/${encodeURIComponent(user.id)}`, { active: !user.active });
        await load();                 // 改完重新拉取（legacy L280：await loadUsers()）
      } finally {
        // 注意：await load() 之后本行可能已被重建、button 已脱离文档；
        // 对脱离文档的节点置位无害，留着是为了"请求失败时按钮必须恢复可点"。
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    }));
    cell.append(button);
    return cell;
  }

  /** 8.6：一行。data-* 供验收脚本按用户名 / id 定位，不参与展示。 */
  function buildRow(user) {
    const row = h('tr', {
      'data-role': 'user-row',
      'data-user-id': user.id,
      'data-username': user.username,
      'data-admin': String(Boolean(user.is_admin)),
      'data-active': String(Boolean(user.active)),
    });
    row.append(
      h('td', { className: 'admin__user', 'data-role': 'username', text: userLabel(user) }),
      h('td', { className: 'admin__date', 'data-role': 'created-at', text: createdDate(user.created_at) }),
      h('td', { className: 'admin__quota', 'data-role': 'photo-count', text: quotaLabel(user.photo_count) }),
      h('td', { 'data-role': 'state' }, [
        h('span', {
          className: user.active ? 'badge badge--ok' : 'badge',
          'data-role': 'state-badge',
          text: stateLabel(user.active),
        }),
      ]),
      actionCell(user),
    );
    return row;
  }

  /** 8.6 / 8.7：按当前筛选重画表体。筛选是**纯前端**的 —— 不发请求（legacy L273-274）。 */
  function render() {
    const rows = filterUsers(store.getState().users, search.value, statusFilter.getValue());
    tbody.replaceChildren(...rows.map(buildRow));
    // legacy L275：没有符合条件的用户时才显示空态。
    // 「加载中」与「一次都没成功过」不显示 —— 否则首屏会先说一句"没有符合条件的用户"再变成有。
    emptyNode.hidden = rows.length > 0 || !loadedOnce;
    table.dataset.filtered = String(rows.length);
    return rows;
  }

  /** 登出 / 账户切换后把本视图的本地状态清干净（行为清单 1.5 的"彻底清空"）。 */
  function resetLocal() {
    search.value = '';
    statusFilter.setValue('all');
    lastError = null;
    loading = false;
    loadedOnce = false;
    tbody.replaceChildren();
    emptyNode.hidden = true;
    clearOverview();
    renderBusy();
  }

  /* ---------------- 8.5 / 8.6 加载 ---------------- */

  async function load() {
    const token = ++loadToken;
    loading = true;
    renderBusy();
    try {
      // 旧版也是并行（legacy L266：Promise.all），两个请求各自独立、都是只读的。
      const [users, overview] = await Promise.all([api.get('/admin/users'), api.get('/admin/overview')]);
      if (token !== loadToken) return;            // 已被更新的一次刷新取代
      loadedOnce = true;
      store.setUsers(users);                      // 写进 store → 订阅者 render()
      renderOverview(overview);
      lastError = null;
    } catch (error) {
      if (token !== loadToken) return;
      if (error && error.stale) return;           // 0.4：账户切换导致在途请求作废，静默丢弃
      lastError = error && error.message ? error.message : String(error);
      store.toast(lastError);
      render();
    } finally {
      if (token === loadToken) {
        loading = false;
        renderBusy();
      }
    }
  }

  /* ---------------- 8.8 确认框 ---------------- */

  /**
   * 停用前的确认。返回 Promise<boolean>。
   * 没有 modals 时退回原生 confirm（行为等价，只是长得不一样）。
   */
  function confirmDisable() {
    if (!modals) return Promise.resolve(window.confirm(DISABLE_CONFIRM));
    setText(confirmMessage, DISABLE_CONFIRM);
    modals.open(confirmDialog);
    return new Promise(resolve => {
      const done = value => {
        confirmForm.removeEventListener('submit', onSubmit);
        confirmDialog.removeEventListener('click', onClick);
        modals.close(confirmDialog);
        resolve(value);
      };
      const onSubmit = event => { event.preventDefault(); done(true); };
      const onClick = event => { if (event.target.closest('[data-close]')) done(false); };
      confirmForm.addEventListener('submit', onSubmit);
      confirmDialog.addEventListener('click', onClick);
    });
  }

  /* ---------------- 8.7 事件 ---------------- */

  search.addEventListener('input', () => render());
  /* 8.7 状态筛选变了就重画表体（纯前端过滤，不发请求）。用控件回调而不是 change 事件：
     8.7 只需要"值变了"这一个事实，而 render() 读的是 getValue()，两种接法等价，
     回调更直接（change 事件的派发点是 trigger，不冒泡，容易接错层）。 */
  statusFilter.onChange = () => render();
  refreshButton.addEventListener('click', store.guard(async () => { await load(); }));

  /* ---------------- 生命周期 ---------------- */

  function onStore(state, reason) {
    // store.setUsers 的唯一消费者（store.js 明写用户列表是"登出必须清空"的那一份）
    if (reason === 'users') render();
    if (reason === 'session' && !state.user) resetLocal();
  }

  return {
    element: root,
    nodes,
    mount(parent) {
      parent.replaceChildren(root);
      unsubscribe = store.subscribe(onStore);
      resetLocal();
      render();
      // 进入视图即加载一次（8.5 / 8.6）。失败已在 load 内部转成通知条，这里不再重复处理。
      load();
    },
    unmount() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      root.remove();
    },
    load,
    render,
    renderOverview,
    clearOverview,
    confirmDisable,
    resetLocal,
    /** 验收探针：当前筛选后的行（直接给数据，不依赖 DOM 结构）。 */
    filtered: () => filterUsers(store.getState().users, search.value, statusFilter.getValue()),
    /** 验收探针：一行用户表该显示的 5 个单元格文本。 */
    rowTexts: user => [userLabel(user), createdDate(user.created_at), quotaLabel(user.photo_count), stateLabel(user.active), user.is_admin ? ADMIN_COPY.dash : actionLabel(user.active)],
    get lastError() { return lastError; },
    get isLoading() { return loading; },
    get loadCount() { return loadToken; },
    get isLoaded() { return loadedOnce; },
    /** 8.8 的确认文案（验收脚本逐字比对用）。 */
    disableConfirmText: DISABLE_CONFIRM,
  };
}

export default {
  createAdminView, ADMIN_COPY, DISABLE_CONFIRM, PHOTO_QUOTA, STATUS_FILTERS,
  userLabel, createdDate, quotaLabel, stateLabel, storageLabel, modelLabel,
  overviewView, filterUsers, actionLabel, actionClass,
};
