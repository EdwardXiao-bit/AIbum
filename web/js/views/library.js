/* ==========================================================================
   AIbum · 相册主界面  web/js/views/library.js
   --------------------------------------------------------------------------
   阶段 3.2（本卡）的**核心视图**。逐条对照 docs/前端-行为清单.md：

     第 2 节 列表与筛选
       2.1  列表请求 GET /photos?page&order&<筛选> → {total, items}
       2.2  六个筛选维度 album_id · location · start · end · favorite · tags + order
       2.3  参数构造：先删这 6 个键再重设、空值不发、tags 重复 append（api.appendFilters）
       2.4  日期校验：开始 > 结束 → "开始日期不能晚于结束日期"
       2.5  标签上限 30（store.toggleTag 抛错 → guard 转通知条）
       2.6  标签搜索：小写包含匹配，无匹配显示"暂无匹配标签"
       2.7  结果文案 `${total} 张照片 · 已显示 ${n} 张`
       2.8  加载更多：仅当 已显示 < total 时可用，点击追加下一页
       2.9  **空态文案分模式**（浏览 / 检索两套，逐字对齐 legacy L108-109）
       2.10 清空所有筛选：6 维 + 排序回 newest + 清空标签
       2.11 刷新：重拉相册/标签 + 重放当前查询 + 更新健康状态
       2.12 卡片信息（在 components/photo-card.js）
       2.13 副标题规则 —— **本卡按 Q3 决策改写**：检索结果不给小数，只给相对档位

     第 3 节 搜索与相似
       3.1  POST /search multipart：text|image 互斥 + 6 筛选 + strictness + limit=100
       3.2  选了参考图 → **停用并清空文字输入框**；text 字段传**空字符串**（不是省略）
       3.3  严格度三档 broad/balanced/strict
       3.4  结果摘要 `${模式} · 匹配 N 张，显示 n 张`（模式名 文搜图 / 图搜图）
       3.5  过滤说明（**按 Q3 改写**：不再写"相似度为原始分数"）
       3.6  检索态不显示"加载更多"
       3.7  检索中按钮禁用 + 文字"检索中…"
       3.8  相似照片 GET /photos/{id}/similar?strictness&limit=100&<筛选>
       3.9  严格度变更即重查（当前不是浏览模式时）
       3.10 重放查询：保存原始查询（文字/参考图），筛选变化时原样重发
       3.11 参考图校验：非空、≤ 20 MiB、仅 jpeg/png/webp
       3.12 参考图拖放：拖入高亮、拖离取消、只能一张
       3.13 参考图预览：createObjectURL + 文件名；清除时 revokeObjectURL
       3.14 拖放区可 Tab 聚焦，Enter/空格触发文件选择

     第 5 节 批量操作
       5.1 单卡选择（photo-card）  5.2 全选已加载的全部  5.3 `已选 N 张`
       5.4 批量按钮在 选中 0 / busy 时禁用
       5.5 重新渲染后选中集**收敛**（store.setResults 内部调 pruneSelection）
       5.6 批量收藏 PATCH {favorite:true}   5.7 批量移动 PATCH {album_id|null}
       5.8 批量删除 DELETE（先确认）        5.9 部分失败：计数 + 中断 + "已处理 N 张；错误"
       5.10 busy 期间禁止重入

     第 9 节 系统状态（本卡负责，见文件末尾的健康轮询）
       9.1 4 秒一次、页面隐藏时暂停
       9.2 状态文案
       9.3 计数变化自动重载 —— **按 Q4 决策改写**：节流 15 秒，且有选中/检索中/浮层打开时不动
       9.4 管理台不轮询

   Q3 / Q4 的实测依据在 docs/前端重构计划.md 决策台账。
   CSP（§0A）：全部 createElement + addEventListener，没有内联脚本/样式/style 属性/内联事件；
   动态样式只走 CSSOM（el.style.setProperty）或 data-* 属性 + CSS。
   ========================================================================== */

import { api } from '../api.js';
import * as router from '../router.js';
import * as store from '../store.js';
import { h, setText } from '../components/dom.js';
import { createPhotoCard } from '../components/photo-card.js';

/** 列表每页条数：后端 page_size 默认 40、上限 100（app/main.py L393）。 */
export const PAGE_SIZE = 40;

/** 自动重载的最小间隔（Q4 决策：轮询 4 秒，但列表重载最多每 15 秒一次）。 */
export const AUTO_RELOAD_MIN_MS = 15000;

/** 检索超过这么久还没回来，就提示"正在加载模型"（冷加载实测 54.3 秒）。 */
export const MODEL_HINT_MS = 2000;

/** 空态两套文案（行为清单 2.9，逐字对齐 legacy L108-109）。 */
export const EMPTY_COPY = {
  browse: { title: '这里还没有照片', desc: '上传一些照片，或调整当前筛选条件。' },
  search: {
    title: '没有找到符合条件的照片',
    desc: '没有达到当前匹配门槛的照片。可以调低严格度、调整描述或筛选，并确认照片已完成分析。',
  },
};

/** 参考图上限与类型（行为清单 3.11 / §11）。 */
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const REFERENCE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** 把筛选条件抄成后端要的形状（含排序，列表请求与检索共用）。 */
function filterSnapshot(filters) {
  return {
    album_id: filters.album_id,
    location: filters.location,
    start: filters.start,
    end: filters.end,
    favorite: filters.favorite,
    tags: [...filters.tags],
    order: filters.order,
  };
}

/** 日期校验（2.4）。返回错误文案或 null。 */
export function validateDates(filters) {
  if (filters.start && filters.end && String(filters.start) > String(filters.end)) {
    return '开始日期不能晚于结束日期';
  }
  return null;
}

/**
 * 建相册主界面。本文件只负责这一个视图：搜索区 + 筛选栏 + 结果网格 + 批量条 + 健康轮询。
 * @param {{
 *   modals?: {register(el: HTMLElement, opts?: object): HTMLElement, open(el: HTMLElement): any,
 *             close(el?: HTMLElement): any, isOpen(el?: HTMLElement): boolean},
 *   navigate?: (target: string, options?: object) => any,
 *   document?: Document,
 * }} [options]
 * @returns {{element: HTMLElement, mount(parent: Element): void, unmount(): void, nodes: object }}
 */
export function createLibraryView(options = {}) {
  const document_ = options.document || document;
  const modals = options.modals || null;
  const navigate = options.navigate || ((target, opts) => router.navigate(target, opts));

  /* ======================================================================
     0) 视图局部状态
     - 查询形状（3.10 重放用）：只存"用户意图"（文字 / 参考图 File / 相似照片 id），
       不存 FormData 快照。原因：FormData 里的 File 与整份表单是绑定的一次性载荷，
       重发时若沿用旧的 File 引用、又要换上新筛选，就得手工重建 multipart。
       存意图 + 每次按当前筛选重建 = 与旧版"原样重放同一查询"的语义一致，
       而且 text 字段永远存在（3.2 要求空字符串而非省略）。
     ====================================================================== */

  /** @type {{kind:'text'|'image', text:string, file:File|null, similarId:string|null}} */
  let queryIntent = null;
  let searching = false;
  let uploading = false;
  let healthBusy = false;
  /** 上次"因计数变化而自动重载列表"的时间（Q4 节流）。 */
  let lastAutoReloadAt = 0;
  /** 计数快照（对应 legacy 的 state.health 字符串）。 */
  let healthSnapshot = '';
  /** 上一次检索是否已经给过"正在加载模型"提示（只有第一次冷加载需要）。 */
  let modelHintShown = false;
  let unsubscribe = null;
  let pollTimer = null;
  /** 轮询定时器是不是本实例建的（视图可以重挂载，别把别人的定时器清掉）。 */
  let ownsPollTimer = false;
  let hintTimer = null;
  let albums = [];

  /* ======================================================================
     1) DOM 骨架
     ====================================================================== */

  const searchInput = h('input', {
    className: 'input library__search-input',
    id: 'library-query',
    type: 'search',
    maxlength: '500',
    autocomplete: 'off',
    placeholder: '例如：海边的日落、一起吃过的美食、可爱的猫咪',
    'aria-label': '用一句话描述你想找的照片',
  });

  const referenceInput = h('input', {
    className: 'sr-only',
    id: 'reference',
    type: 'file',
    accept: 'image/jpeg,image/png,image/webp',
    'data-role': 'reference-input',
  });
  const referencePreview = h('img', { className: 'library__ref-thumb', alt: '参考图预览', 'data-role': 'reference-preview' });
  const referenceName = h('span', { className: 'library__ref-name', 'data-role': 'reference-name' });
  const referenceClear = h('button', {
    type: 'button', className: 'btn btn--sm btn--ghost', 'data-role': 'reference-clear', text: '移除参考图',
  });
  const referenceInfo = h('div', { className: 'library__ref', hidden: true, 'data-role': 'reference-info' },
    [referencePreview, referenceName, referenceClear]);
  const dropPrompt = h('span', { className: 'library__drop-prompt', 'data-role': 'drop-prompt', text: '或拖入一张参考图片（以图搜图）' });
  const dropZone = h('div', {
    className: 'library__drop',
    id: 'reference-drop',
    role: 'button',
    tabindex: '0',
    'aria-label': '拖入或选择一张参考图片，以图搜图',
    'data-role': 'drop-zone',
  }, [dropPrompt, referenceInfo, referenceInput]);

  const searchButton = h('button', {
    className: 'btn btn--primary btn--lg library__submit', id: 'search-button', type: 'submit', text: '搜索',
  });
  const resetButton = h('button', {
    className: 'btn btn--lg btn--ghost', id: 'reset-search', type: 'button', text: '重置',
  });
  const searchForm = h('form', { className: 'library__search', id: 'search-form', 'data-role': 'search-form' },
    [h('div', { className: 'library__search-row' }, [
      h('div', { className: 'search library__search-field' }, [searchInput]),
      searchButton,
      resetButton,
    ]), dropZone]);

  const strictRadios = ['broad', 'balanced', 'strict'].map(value => {
    const input = h('input', {
      className: 'sr-only', type: 'radio', name: 'strictness', value, id: `strictness-${value}`,
      checked: value === 'balanced',
    });
    const label = h('label', { className: 'library__seg-item', for: `strictness-${value}`, 'data-role': 'strictness', 'data-value': value },
      [input, h('span', { text: store.STRICTNESS_LABELS[value] })]);
    return label;
  });

  const modelHint = h('p', { className: 'library__model-hint', id: 'model-hint', role: 'status', hidden: true, 'data-role': 'model-hint' });

  const hero = h('section', { className: 'library__hero' }, [
    h('p', { className: 'eyebrow', text: 'PERSONAL LIBRARY' }),
    h('h1', { className: 'hero library__title', text: '我的照片' }),
    h('p', { className: 'lead library__lead', text: '用一句话描述，或给一张参考图，找出你想看的那几张。' }),
    searchForm,
    h('div', { className: 'library__search-opts' }, [
      h('div', { className: 'library__seg', role: 'radiogroup', 'aria-label': '匹配严格度' }, [
        h('span', { className: 'library__seg-label', text: '严格度' }),
        ...strictRadios,
      ]),
      modelHint,
    ]),
  ]);

  /* ---------------- 筛选栏（侧栏；标签是标签云：已选优先 + 频次排序） ---------------- */

  const albumFilter = h('select', { className: 'select', id: 'album-filter', 'data-role': 'filter-album' });
  const locationFilter = h('input', { className: 'input', id: 'location-filter', type: 'search', placeholder: '例如：杭州', 'data-role': 'filter-location' });
  const startFilter = h('input', { className: 'input', id: 'start-filter', type: 'date', 'data-role': 'filter-start' });
  const endFilter = h('input', { className: 'input', id: 'end-filter', type: 'date', 'data-role': 'filter-end' });
  const favoriteFilter = h('button', {
    className: 'switch', id: 'favorite-filter', type: 'button', role: 'switch', 'aria-checked': 'false',
    'data-role': 'filter-favorite', 'aria-label': '只看收藏',
  });
  const orderSelect = h('select', { className: 'select', id: 'order', 'data-role': 'filter-order' }, [
    h('option', { value: 'newest', text: store.ORDER_LABELS.newest }),
    h('option', { value: 'oldest', text: store.ORDER_LABELS.oldest }),
  ]);
  const tagKeyword = h('input', {
    className: 'input', id: 'tag-keyword', type: 'search', placeholder: '筛选标签…', 'data-role': 'tag-keyword',
    'aria-label': '按关键字筛选标签',
  });
  const tagCloud = h('div', { className: 'library__tagcloud', id: 'tag-options', 'data-role': 'tag-cloud' });
  const clearTagsButton = h('button', { className: 'btn btn--sm btn--ghost', id: 'clear-tags', type: 'button', text: '清空标签' });
  const clearFiltersButton = h('button', { className: 'btn btn--ghost btn--block', id: 'clear-filters', type: 'button', text: '清空所有筛选' });
  const newAlbumButton = h('button', { className: 'btn btn--block', id: 'new-album', type: 'button', text: '新建相册' });
  const filtersToggle = h('button', {
    className: 'btn btn--ghost library__drawer-toggle', id: 'filters-toggle', type: 'button',
    'aria-expanded': 'true', 'aria-controls': 'library-filters', text: '筛选',
  });
  const modelStatus = h('p', { className: 'library__status', id: 'model-status', 'data-role': 'model-status', text: '' });

  const filterCount = h('span', { className: 'library__filter-count', id: 'filter-count', 'data-role': 'filter-count', text: '未设置筛选' });

  const sidebar = h('aside', { className: 'library__side', id: 'library-filters', 'data-role': 'sidebar', 'data-open': 'true' }, [
    h('div', { className: 'library__side-head' }, [
      h('h2', { className: 'library__side-title', text: '筛选' }),
      filterCount,
    ]),
    h('div', { className: 'library__side-body' }, [
      h('div', { className: 'field' }, [h('label', { for: 'album-filter', text: '相册' }), albumFilter]),
      h('div', { className: 'field' }, [h('label', { for: 'location-filter', text: '地点' }), locationFilter]),
      h('div', { className: 'library__dates' }, [
        h('div', { className: 'field' }, [h('label', { for: 'start-filter', text: '开始日期' }), startFilter]),
        h('div', { className: 'field' }, [h('label', { for: 'end-filter', text: '结束日期' }), endFilter]),
      ]),
      h('div', { className: 'library__switch-row' }, [
        h('span', { className: 'label', id: 'favorite-label', text: '只看收藏' }),
        favoriteFilter,
      ]),
      h('div', { className: 'field' }, [h('label', { for: 'order', text: '排序' }), orderSelect]),
      h('div', { className: 'field' }, [
        h('div', { className: 'library__tag-head' }, [
          h('label', { for: 'tag-keyword', text: '标签' }),
          clearTagsButton,
        ]),
        tagKeyword,
        tagCloud,
      ]),
    ]),
    h('div', { className: 'library__side-foot' }, [
      newAlbumButton,
      clearFiltersButton,
    ]),
  ]);

  /* ---------------- 结果区 ---------------- */

  const resultLabel = h('p', { className: 'library__count', id: 'result-label', 'data-role': 'result-label', text: '' });
  const searchSummary = h('p', { className: 'library__summary', id: 'search-summary', 'data-role': 'search-summary', hidden: true });
  const selectedCount = h('span', { className: 'library__selected', id: 'selected-count', 'data-role': 'selected-count', text: '已选 0 张' });
  const selectAll = h('button', {
    className: 'photo__sel library__select-all', id: 'select-all', type: 'button', role: 'checkbox',
    'aria-checked': 'false', 'aria-label': '全选当前已加载的照片', 'data-role': 'select-all',
  }, [h('span', { className: 'photo__sel-mark', 'aria-hidden': 'true', text: '✓' })]);

  const batchAlbum = h('select', { className: 'select select--sm', id: 'batch-album', 'data-role': 'batch-album' });
  const batchFavorite = h('button', { className: 'btn btn--sm', id: 'batch-favorite', type: 'button', text: '收藏', disabled: true });
  const batchMove = h('button', { className: 'btn btn--sm', id: 'batch-move', type: 'button', text: '移动', disabled: true });
  const batchDelete = h('button', { className: 'btn btn--sm btn--danger', id: 'batch-delete', type: 'button', text: '删除', disabled: true });

  const batchBar = h('div', { className: 'library__batch', 'data-role': 'batch-bar' }, [
    selectAll, selectedCount, batchFavorite, batchMove, batchAlbum, batchDelete,
  ]);

  const grid = h('div', { className: 'photo-grid library__grid', id: 'grid', 'data-role': 'grid' });
  const emptyTitle = h('p', { className: 'empty__title', id: 'empty-title', 'data-role': 'empty-title' });
  const emptyDesc = h('p', { className: 'empty__desc', id: 'empty-desc', 'data-role': 'empty-desc' });
  const emptyNode = h('div', { className: 'empty library__empty', id: 'empty', hidden: true, 'data-role': 'empty' }, [
    h('span', { className: 'empty__icon', 'aria-hidden': 'true', text: '🖼' }),
    emptyTitle, emptyDesc,
  ]);
  const loadMore = h('button', { className: 'btn loadmore', id: 'load-more', type: 'button', hidden: true, 'data-role': 'load-more', text: '加载更多' });

  const results = h('section', { className: 'library__results' }, [
    h('div', { className: 'library__results-head' }, [resultLabel, searchSummary]),
    batchBar, grid, emptyNode,
    h('div', { className: 'library__tail' }, [loadMore]),
  ]);

  const toastHost = h('div', { className: 'library__inline-note', 'data-role': 'upload-status', hidden: true }, [
    h('span', { 'data-role': 'upload-label' }),
    h('progress', { className: 'progress', id: 'progress', max: '100', value: '0' }),
  ]);
  const uploadButton = h('button', { className: 'btn btn--ghost', id: 'upload', type: 'button', text: '上传照片' });
  const uploadInput = h('input', {
    className: 'sr-only', id: 'upload-input', type: 'file', multiple: true,
    accept: 'image/jpeg,image/png,image/webp', 'data-role': 'upload-input',
  });
  const main = h('div', { className: 'library__main' }, [
    results,
    h('div', { className: 'library__main-foot' }, [uploadButton, uploadInput, toastHost]),
  ]);

  const root = h('div', { className: 'library', id: 'library-root', 'data-role': 'library' }, [
    hero,
    h('div', { className: 'library__toolbar' }, [filtersToggle, modelStatus]),
    h('div', { className: 'library__body' }, [sidebar, main]),
  ]);

  /* ---------------- 浮层：新建相册 / 删除确认（用外壳的共享遮罩，见 components/modal.js） ---------------- */

  const dialogTitle = h('div', { className: 'dialog__title', id: 'album-dialog-title' });
  const dialogBody = h('div', { className: 'dialog__body', 'data-role': 'album-dialog-body' });
  const dialog = h('div', {
    className: 'dialog', id: 'dialog-album', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'album-dialog-title', hidden: true,
  }, [
    h('div', { className: 'dialog__head' }, [
      dialogTitle,
      h('button', { className: 'btn btn--icon btn--ghost dialog__close', type: 'button', 'data-close': '', 'aria-label': '关闭', text: '✕' }),
    ]),
    dialogBody,
  ]);
  const albumName = h('input', { className: 'input', id: 'album-name', maxlength: '80', placeholder: '最多 80 字', autocomplete: 'off' });
  const albumForm = h('form', { className: 'stack', id: 'album-form' }, [
    h('div', { className: 'field' }, [h('label', { for: 'album-name', text: '相册名称' }), albumName]),
    h('div', { className: 'dialog__foot' }, [
      h('button', { className: 'btn btn--primary', type: 'submit', text: '创建' }),
      h('button', { className: 'btn btn--ghost', type: 'button', 'data-close': '', text: '取消' }),
    ]),
  ]);
  const deleteMessage = h('p', { className: 'library__confirm-text', 'data-role': 'delete-message' });
  const deleteForm = h('form', { className: 'stack', id: 'delete-form' }, [
    deleteMessage,
    h('div', { className: 'dialog__foot' }, [
      h('button', { className: 'btn btn--danger', type: 'submit', text: '永久删除' }),
      h('button', { className: 'btn btn--ghost', type: 'button', 'data-close': '', text: '取消' }),
    ]),
  ]);
  if (modals) modals.register(dialog, { onClose: () => { dialogBody.replaceChildren(); } });

  // 浮层放进视图根节点（不是 document.body）：视图卸载时跟着一起消失，
  // 不在 DOM 里留孤儿对话框。.dialog 是 position:fixed，挂在哪儿都不影响布局。
  root.append(dialog);

  const nodes = {
    root, hero, searchForm, searchInput, referenceInput, referencePreview, referenceName, referenceInfo,
    dropZone, searchButton, resetButton, strictRadios, modelHint, modelStatus,
    sidebar, sidebarToggle: filtersToggle, filtersToggle, albumFilter, locationFilter, startFilter, endFilter,
    favoriteFilter, orderSelect, tagKeyword, tagCloud, clearTagsButton, clearFiltersButton, newAlbumButton, filterCount,
    resultLabel, searchSummary, selectAll, selectedCount, batchBar, batchFavorite, batchMove, batchDelete, batchAlbum,
    grid, emptyNode, emptyTitle, emptyDesc, loadMore, uploadButton, uploadInput, uploadStatus: toastHost,
    progress: toastHost.querySelector('#progress'), uploadLabel: toastHost.querySelector('[data-role="upload-label"]'),
    dialog, albumForm, albumName, deleteForm, deleteMessage,
  };

  /* ======================================================================
     2) 小工具
     ====================================================================== */

  function currentStrictness() {
    const picked = strictRadios.map(label => label.querySelector('input')).find(input => input.checked);
    return picked ? picked.value : 'balanced';
  }

  function setStrictness(value) {
    for (const label of strictRadios) {
      const input = label.querySelector('input');
      input.checked = input.value === value;
      label.dataset.active = input.checked ? 'true' : 'false';
    }
  }

  function isSearchMode(state = store.getState()) {
    return state.results.mode === 'search' || state.results.mode === 'similar';
  }

  function overlayOpen() {
    if (!modals) return false;
    if (typeof modals.isOpenAll === 'function') return modals.isOpenAll();
    const scrim = document_.getElementById('scrim');
    return Boolean(scrim && !scrim.hidden);
  }

  /* ======================================================================
     3) 渲染
     ====================================================================== */

  function renderGrid(state = store.getState()) {
    const { items, mode } = state.results;
    grid.replaceChildren(...items.map((photo, index) => createPhotoCard(photo, {
      mode,
      rank: mode === 'search' || mode === 'similar' ? index + 1 : undefined,
      selected: store.isSelected(photo.id),
      onToggleSelect: (id, checked) => { store.toggleSelected(id, checked); },
      onOpen: id => { navigate(router.hrefFor('photo', { id })); },
      document: document_,
    })));
    grid.dataset.count = String(items.length);
    // 5.5：渲染后立刻收敛选中集（setResults 已做一次；这里是第二次保险，
    // 因为视图可能在别处渲染而结果集未变）
    store.pruneSelection(items.map(photo => photo.id));
  }

  function renderEmpty(state = store.getState()) {
    const { items, mode, loading } = state.results;
    const show = !loading && items.length === 0;
    emptyNode.hidden = !show;
    if (!show) return;
    const copy = mode === 'browse' ? EMPTY_COPY.browse : EMPTY_COPY.search;
    setText(emptyTitle, copy.title);
    setText(emptyDesc, copy.desc);
    emptyNode.dataset.mode = mode === 'browse' ? 'browse' : 'search';
  }

  function renderResultsBar(state = store.getState()) {
    const { items, total, mode, summary, loading } = state.results;
    if (mode === 'browse') {
      // 2.7 结果文案（逐字）：`${total} 张照片 · 已显示 ${n} 张`
      setText(resultLabel, `${total} 张照片 · 已显示 ${items.length} 张`);
    } else {
      const title = mode === 'search'
        ? (summary && summary.mode === 'image' ? '图搜图' : '文搜图')
        : '相似照片（已排除参考图）';
      setText(resultLabel, loading
        ? `${title} · 检索中…`
        : `${title} · 匹配 ${summary ? summary.matched_count : items.length} 张，显示 ${items.length} 张`);
    }
    resultLabel.dataset.mode = mode;

    // 3.5 过滤说明（Q3 改写：不出现小数、不说"相似度为原始分数"）
    if (mode === 'search' && summary) {
      const parts = [
        `已过滤 ${summary.filtered_count} 张低相关照片`,
        `${store.STRICTNESS_LABELS[summary.strictness] || summary.strictness}匹配`,
        summary.elapsed_ms !== undefined ? `${summary.elapsed_ms} ms` : null,
      ].filter(Boolean);
      setText(searchSummary, `${parts.join(' · ')}。结果按相关度排序，卡片上的"最匹配/较匹配"只是本次结果里的相对名次。`);
      searchSummary.hidden = false;
    } else if (mode === 'similar') {
      setText(searchSummary, '结果按相关度排序，卡片上的"最匹配/较匹配"只是本次结果里的相对名次。');
      searchSummary.hidden = false;
    } else {
      searchSummary.hidden = true;
      setText(searchSummary, '');
    }

    // 2.8 / 3.6：只有浏览模式、且还有没显示完的，才给"加载更多"
    const canLoadMore = mode === 'browse' && items.length < total && !loading;
    loadMore.hidden = !canLoadMore;
    loadMore.disabled = loading;
    loadMore.dataset.state = canLoadMore ? 'idle' : 'end';
    if (canLoadMore) setText(loadMore, `加载更多（还有 ${total - items.length} 张）`);
    else if (mode === 'browse' && items.length) setText(loadMore, `已显示全部 ${items.length} 张`);
  }

  function renderSelection(state = store.getState()) {
    const size = state.selected.size;
    setText(selectedCount, `已选 ${size} 张`);
    const items = state.results.items;
    const allChecked = items.length > 0 && size === items.length;
    selectAll.setAttribute('aria-checked', allChecked ? 'true' : 'false');
    selectAll.dataset.mixed = !allChecked && size > 0 ? 'true' : 'false';
    selectAll.disabled = items.length === 0;
    // 5.4：选中 0 或 busy 时，批量按钮禁用
    for (const button of [batchFavorite, batchMove, batchDelete]) button.disabled = size === 0 || state.busy;
    batchAlbum.disabled = size === 0 || state.busy;
    // 卡片上的选择框同步（避免只改 store 不改 DOM 造成视觉与状态不一致）
    for (const card of grid.querySelectorAll('.photo')) {
      const pressed = state.selected.has(card.dataset.photo);
      const mark = card.querySelector('[data-role="select"]');
      if (mark) mark.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      if (pressed) card.dataset.selected = 'true';
      else delete card.dataset.selected;
    }
  }

  function renderFilters(state = store.getState()) {
    const filters = state.filters;
    if (albumFilter.value !== filters.album_id) albumFilter.value = filters.album_id || '';
    if (locationFilter.value !== filters.location) locationFilter.value = filters.location || '';
    if (startFilter.value !== (filters.start || '')) startFilter.value = filters.start || '';
    if (endFilter.value !== (filters.end || '')) endFilter.value = filters.end || '';
    if (orderSelect.value !== filters.order) orderSelect.value = filters.order || 'newest';
    favoriteFilter.setAttribute('aria-checked', filters.favorite ? 'true' : 'false');
    renderTagCloud();
    const active = [
      filters.album_id ? '相册' : null,
      filters.location ? '地点' : null,
      (filters.start || filters.end) ? '日期' : null,
      filters.favorite ? '收藏' : null,
      filters.tags.length ? `标签 ${filters.tags.length}` : null,
      filters.order === 'oldest' ? '排序' : null,
    ].filter(Boolean);
    setText(filterCount, active.length ? active.join(' · ') : '未设置筛选');
  }

  /** 标签云：已选优先 + 频次排序（阶段 4.4 的落地）。 */
  function renderTagCloud(state = store.getState()) {
    const keyword = tagKeyword.value.trim().toLowerCase();
    const selected = new Set(state.filters.tags);
    const matched = (state.tags || [])
      .filter(tag => !keyword || String(tag.name).toLowerCase().includes(keyword));
    const sorted = [...matched].sort((a, b) => {
      const selectedDiff = (selected.has(b.name) ? 1 : 0) - (selected.has(a.name) ? 1 : 0);
      if (selectedDiff) return selectedDiff;
      const countDiff = (b.count || 0) - (a.count || 0);
      if (countDiff) return countDiff;
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    });
    tagCloud.replaceChildren(...sorted.map(tag => {
      const pressed = selected.has(tag.name);
      return h('button', {
        type: 'button',
        className: 'chip library__tag',
        'aria-pressed': pressed ? 'true' : 'false',
        'data-tag': tag.name,
        'data-count': tag.count,
        title: pressed ? `取消标签「${tag.name}」` : `按标签「${tag.name}」筛选（${tag.count} 张）`,
        onclick: () => applyFilterChange(() => store.toggleTag(tag.name, !pressed)),
      }, [
        h('span', { className: 'library__tag-name', text: tag.name }),
        h('span', { className: 'chip__count', text: ` ${tag.count}` }),
      ]);
    }));
    if (!sorted.length) {
      tagCloud.append(h('p', { className: 'text-muted library__tag-empty', 'data-role': 'tag-empty', text: '暂无匹配标签' }));
    }
  }

  /** 健康状态文案（9.2）。 */
  function renderHealth(state = store.getState()) {
    const health = state.health;
    if (!health) return;
    const counts = health.photos || {};
    const model = health.model || {};
    const modelText = model.ready
      ? '本地图文模型已就绪'
      : model.installed
        ? '本地图文模型（首次检索 / 上传需加载，约需一分钟）'
        : '模型未安装：请先运行模型准备脚本';
    setText(modelStatus, `${modelText} · 已分析 ${counts.ready || 0} · 待处理 ${(counts.pending || 0) + (counts.processing || 0)} · 失败 ${counts.failed || 0}`);
    modelStatus.dataset.ready = model.ready ? 'true' : 'false';
    modelStatus.dataset.installed = model.installed ? 'true' : 'false';
  }

  function render(state, reason) {
    if (reason === 'session') resetLocalState();
    if (reason === 'filters') renderFilters(state);
    if (reason === 'selection') renderSelection(state);
    if (reason === 'results') {
      renderResultsBar(state);
      renderGrid(state);
      renderEmpty(state);
      renderSelection(state);
    }
    if (reason === 'health') renderHealth(state);
    if (reason === 'tags' || reason === 'albums') {
      renderAlbumOptions();
      renderTagCloud(state);
    }
  }

  /* ======================================================================
     4) 查询：列表 / 检索 / 相似 + 重放（2.1、3.1、3.8、3.10）
     ====================================================================== */

  async function fetchBrowse({ append = false } = {}) {
    const state = store.getState();
    const error = validateDates(state.filters);
    if (error) throw new Error(error);
    const page = append ? (state.results.page || 1) + 1 : 1;
    const params = api.filterParams({ ...filterSnapshot(state.filters), page });
    const out = await store.latest(() => api.get('/photos?' + params.toString()));
    if (out.stale) return { stale: true };
    const data = out.value;
    store.setResults({
      items: data.items,
      total: data.total,
      page: data.page || page,
      mode: 'browse',
      query: null,
      summary: null,
      append,
    });
    return { stale: false };
  }

  /** 3.2：multipart 组装。text 字段**永远存在**，有参考图时是空字符串。 */
  function buildSearchForm(intent, filters, strictness) {
    const form = new FormData();
    form.set('text', intent.kind === 'image' ? '' : (intent.text || ''));
    if (intent.kind === 'image' && intent.file) form.set('image', intent.file);
    api.appendFilters(form, filterSnapshot(filters));
    form.set('strictness', strictness);
    form.set('limit', '100');
    return form;
  }

  /** 检索（3.1-3.7）。intent 为 null 表示用当前输入框新发起一次。 */
  async function runSearch(intent = null) {
    const state = store.getState();
    const error = validateDates(state.filters);
    if (error) throw new Error(error);
    const next = intent || {
      kind: referenceFile ? 'image' : 'text',
      text: referenceFile ? '' : searchInput.value.trim(),
      file: referenceFile,
      similarId: null,
    };
    if (next.kind === 'text' && !next.text) throw new Error('请输入描述或选择参考图片');
    if (searching) return { stale: true };

    const strictness = currentStrictness();
    searching = true;
    setSearchBusy(true);
    clearModelHint();
    // Q4/冷加载：模型还没就绪时的检索很可能要等模型加载（实测 54.3 秒）→ 2 秒后给明确提示。
    // 判据用"模型当前是否 ready"而不是"本次会话是否提示过"：模型就绪后就不再打扰，
    // 但如果服务端模型被卸载/重启（health 说 ready=false），下次检索还会提示。
    const modelReady = Boolean(store.getState().health && store.getState().health.model && store.getState().health.model.ready);
    if (!modelReady) {
      hintTimer = setTimeout(() => {
        showModelHint('正在加载本地图文模型，首次检索约需一分钟，请勿关闭页面…');
        modelHintShown = true;
      }, MODEL_HINT_MS);
    }
    try {
      const form = buildSearchForm(next, state.filters, strictness);
      const out = await store.latest(() => api.postForm('/search', form));
      if (out.stale) return { stale: true };
      const data = out.value;
      queryIntent = { ...next, file: next.file || null };
      store.setResults({
        items: data.items,
        total: data.matched_count,
        page: 1,
        mode: 'search',
        query: { kind: next.kind, text: next.text, similarId: null },
        summary: {
          mode: data.mode, matched_count: data.matched_count, filtered_count: data.filtered_count,
          candidate_count: data.candidate_count, strictness: data.strictness, elapsed_ms: data.elapsed_ms,
          threshold: data.threshold,
        },
      });
      return { stale: false };
    } finally {
      searching = false;
      setSearchBusy(false);
      clearModelHint();
    }
  }

  /** 3.8 相似照片（从详情发起或直接调用）。 */
  async function runSimilar(photoId) {
    const state = store.getState();
    const error = validateDates(state.filters);
    if (error) throw new Error(error);
    searching = true;
    setSearchBusy(true);
    clearModelHint();
    try {
      const params = new URLSearchParams({ strictness: currentStrictness(), limit: '100' });
      api.appendFilters(params, filterSnapshot(state.filters));
      const out = await store.latest(() => api.get(`/photos/${photoId}/similar?` + params.toString()));
      if (out.stale) return { stale: true };
      const data = out.value;
      queryIntent = { kind: 'similar', text: '', file: null, similarId: photoId };
      store.setResults({
        items: data.items,
        total: data.matched_count,
        page: 1,
        mode: 'similar',
        query: { kind: 'similar', similarId: photoId },
        summary: {
          mode: 'image', matched_count: data.matched_count, filtered_count: data.filtered_count,
          candidate_count: data.candidate_count, strictness: data.strictness, elapsed_ms: data.elapsed_ms,
          threshold: data.threshold,
        },
      });
      return { stale: false };
    } finally {
      searching = false;
      setSearchBusy(false);
      clearModelHint();
    }
  }

  /**
   * 重放当前查询（3.10）：保留原始查询意图，换上**当前**的筛选与严格度后原样重发。
   * 判定依据是**当前结果集模式**（与旧版 reload() 一致）：
   *   浏览模式 → 列表；检索 / 相似 → 原样重放。所以一旦回到了浏览模式，旧的查询意图就作废。
   */
  async function replayQuery() {
    if (!isSearchMode(store.getState())) return fetchBrowse();
    if (!queryIntent) return fetchBrowse();
    if (queryIntent.kind === 'similar' && queryIntent.similarId) return runSimilar(queryIntent.similarId);
    if (queryIntent.kind === 'image' && !queryIntent.file) return fetchBrowse();   // 参考图已经丢了 → 没有可重放的查询
    return runSearch(queryIntent);
  }

  /** 丢掉查询意图：清空筛选 / 重置搜索后调用，下一次重放就退回浏览列表。 */
  function discardQuery() {
    queryIntent = null;
    return null;
  }

  /** 2.11 / 筛选变化的总入口：清选中集，然后按模式重放。 */
  async function applyFilters() {
    store.clearSelection();
    const state = store.getState();
    if (isSearchMode(state) && queryIntent) await replayQuery();
    else await fetchBrowse();
  }

  /** 2.10 清空所有筛选：筛选、排序、搜索框、参考图、查询意图一起归零。 */
  async function resetAll() {
    searchForm.reset();
    clearReference();
    discardQuery();
    setStrictness('balanced');
    store.resetFilters();
    store.clearSelection();
    renderFilters();
    setStrictness('balanced');
    return fetchBrowse();
  }

  /**
   * 把一次 store 写入 + 重查包成事务：**写失败（如标签超 30）或者重查前置校验失败
   * （如开始日期 > 结束日期）都要把筛选回滚**，否则 store 里会留下一个从没查过的非法状态，
   * 界面（renderFilters 会把 DOM 对齐到 store）也会跟着显示非法值。
   */
  async function applyFilterChange(mutator) {
    const before = filterSnapshot(store.getState().filters);
    mutator();
    try {
      await applyFilters();
    } catch (error) {
      restoreFilters(before);
      throw error;
    }
  }

  /** 把筛选恢复成 before（逐个走 setFilter，DOM 也会跟着同步回来）。 */
  function restoreFilters(before) {
    for (const key of store.FILTER_KEYS.concat('order')) {
      const value = key === 'tags' ? [] : before[key];
      if (key === 'tags') store.setTags([]);
      else store.setFilter(key, value);
    }
    for (const tag of before.tags || []) store.toggleTag(tag, true);
    return store.getState().filters;
  }

  function setSearchBusy(busy) {
    searchButton.disabled = busy;
    setText(searchButton, busy ? '检索中…' : '搜索');
    root.dataset.searching = busy ? 'true' : 'false';
    // 检索中不自动重载列表（Q4 的"不打扰"条件之一）
    if (busy) lastAutoReloadAt = Date.now();
  }

  function showModelHint(text) {
    setText(modelHint, text);
    modelHint.hidden = false;
  }

  function clearModelHint() {
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = null;
    modelHint.hidden = true;
  }

  /* ======================================================================
     5) 选项加载（7.1 / 7.2 / 7.3）
     ====================================================================== */

  function fillAlbumSelect(node, entries, firstLabel, keepValue) {
    const previous = keepValue === undefined ? node.value : keepValue;
    node.replaceChildren(
      h('option', { value: '', text: firstLabel }),
      ...entries.map(album => h('option', {
        value: album.id,
        text: `${album.name} (${album.count !== undefined ? album.count : 0})`,
      })),
    );
    if ([...node.options].some(option => option.value === previous)) node.value = previous;
    return node;
  }

  function renderAlbumOptions() {
    const state = store.getState();
    fillAlbumSelect(albumFilter, albums, '所有相册', state.filters.album_id || '');
    fillAlbumSelect(batchAlbum, albums, '移出相册');
  }

  async function refreshOptions() {
    const [albumList, tagList] = await Promise.all([api.get('/albums'), api.get('/tags')]);
    albums = albumList;
    store.setTagOptions(tagList);
    renderAlbumOptions();
    renderTagCloud();
  }

  /* ======================================================================
     6) 参考图（3.11 - 3.14）+ 文字互斥（3.2）
     ====================================================================== */

  let referenceFile = null;
  let referenceUrl = null;

  function clearReference() {
    if (referenceUrl) URL.revokeObjectURL(referenceUrl);
    referenceFile = null;
    referenceUrl = null;
    referenceInput.value = '';
    referenceInfo.hidden = true;
    referencePreview.removeAttribute('src');
    dropPrompt.hidden = false;
    dropZone.dataset.state = 'idle';
    searchInput.disabled = false;              // 3.2 反向：移除参考图后文字框恢复可用
    searchInput.placeholder = '例如：海边的日落、一起吃过的美食、可爱的猫咪';
  }

  /** 3.11 校验 + 3.13 预览；3.2 选中后停用并清空文字输入框。 */
  function setReference(file) {
    if (!file) return;
    if (!file.size || file.size > MAX_REFERENCE_BYTES) throw new Error('参考图不能为空且不得超过 20 MiB');
    if (file.type && !REFERENCE_TYPES.includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片');
    clearReference();
    referenceFile = file;
    referenceUrl = URL.createObjectURL(file);
    referencePreview.src = referenceUrl;
    setText(referenceName, file.name);
    referenceInfo.hidden = false;
    dropPrompt.hidden = true;
    dropZone.dataset.state = 'set';
    searchInput.value = '';                    // 3.2：清空文字
    searchInput.disabled = true;               // 3.2：停用文字输入框
    searchInput.placeholder = '已选择参考图，文字输入已停用';
  }

  /* ======================================================================
     7) 批量操作（5.6 - 5.10）
     ====================================================================== */

  async function batch(action, body) {
    const state = store.getState();
    if (state.busy || !state.selected.size) return;
    const ids = [...state.selected];
    if (action === 'DELETE') {
      const ok = await confirmDelete(ids.length);
      if (!ok) return;
    }
    store.setBusy(true);
    let done = 0;
    try {
      for (const id of ids) {
        await api.request(`/photos/${id}`, action === 'DELETE' ? { method: 'DELETE' } : { method: 'PATCH', json: body });
        store.toggleSelected(id, false);
        done += 1;
      }
      store.toast(`已处理 ${done} 张照片`);
    } catch (error) {
      store.toast(`已处理 ${done} 张；${error && error.message ? error.message : String(error)}`);
    } finally {
      store.setBusy(false);
      await refreshOptions();
      await replayQuery();
    }
  }

  /** 5.8：先弹确认。用共享遮罩里的对话框（不用原生 confirm，便于验收与主题一致）。 */
  function confirmDelete(count) {
    if (!modals) return Promise.resolve(window.confirm(`确定永久删除所选 ${count} 张照片？此操作不可撤销。`));
    setText(deleteMessage, `确定永久删除所选 ${count} 张照片？此操作不可撤销。`);
    setText(dialogTitle, '删除照片');
    dialogBody.replaceChildren(deleteForm);
    modals.open(dialog);
    return new Promise(resolve => {
      const done = value => {
        deleteForm.removeEventListener('submit', onSubmit);
        dialog.removeEventListener('click', onClick);
        modals.close(dialog);
        resolve(value);
      };
      const onSubmit = event => { event.preventDefault(); done(true); };
      const onClick = event => { if (event.target.closest('[data-close]')) done(false); };
      deleteForm.addEventListener('submit', onSubmit);
      dialog.addEventListener('click', onClick);
    });
  }

  /* ======================================================================
     8) 上传（→ F6 卡片；本卡只给一个最小入口，接 api.upload 的进度回调）
     ====================================================================== */

  async function onUpload(files) {
    const list = [...files];
    if (!list.length || uploading) return;
    const state = store.getState();
    const owner = state.user && state.user.id;
    const album = state.filters.album_id || null;
    uploading = true;
    nodes.uploadStatus.hidden = false;
    uploadButton.disabled = true;
    let ok = 0;
    let duplicate = 0;
    const errors = [];
    try {
      for (let index = 0; index < list.length; index += 1) {
        const file = list[index];
        setText(nodes.uploadLabel, `上传 ${index + 1}/${list.length}：${file.name}`);
        try {
          if (file.size > MAX_REFERENCE_BYTES) throw new Error('超过 20 MiB');
          const form = new FormData();
          form.set('file', file);
          if (album) form.set('album_id', album);
          const result = await api.upload('/photos', form, {
            onProgress: fraction => { nodes.progress.value = ((index + fraction) / list.length) * 100; },
          });
          ok += 1;
          if (result && result.duplicate) duplicate += 1;
        } catch (error) {
          errors.push(`${file.name}：${error && error.message ? error.message : String(error)}`);
        }
        if (!store.getState().user || store.getState().user.id !== owner) break;   // 4.5
      }
      nodes.progress.value = 100;
      store.toast(`完成 ${ok}/${list.length} 张，重复 ${duplicate} 张。${errors.slice(0, 3).join('；')}`);
      await refreshOptions();
      await fetchBrowse();
      await updateHealth({ force: true });
    } finally {
      uploading = false;
      uploadButton.disabled = false;
      uploadInput.value = '';
      nodes.uploadStatus.hidden = true;
    }
  }

  /* ======================================================================
     9) 健康轮询（9.1 - 9.4）+ 计数变化自动重载（Q4 节流）
     ====================================================================== */

  /** Q4 的"不打扰"条件：有选中 / 检索中 / 上传中 / 浮层打开 / 页面隐藏。 */
  function shouldAutoReload(state) {
    if (document_.hidden) return false;
    if (state.selected.size) return false;                  // 有选中项 → 不重载（别把选中项弄丢）
    if (isSearchMode(state)) return false;                  // 正在看检索结果 → 不重载
    if (searching || uploading || state.busy) return false;
    if (overlayOpen()) return false;
    if (state.view !== 'library') return false;
    return true;
  }

  async function updateHealth({ force = false } = {}) {
    const state = store.getState();
    if (!state.user || state.portal === 'admin') return;    // 9.4 管理台不轮询
    if (healthBusy) return;
    healthBusy = true;
    let changed = false;
    try {
      const health = await api.get('/health');
      const snapshot = JSON.stringify(health.photos || {});
      changed = Boolean(healthSnapshot) && snapshot !== healthSnapshot;
      healthSnapshot = snapshot;
      store.setHealth(health);
    } finally {
      healthBusy = false;
    }
    if (!force && changed && shouldAutoReload(store.getState())) {
      // Q4：最多每 15 秒自动重载一次（旧版是"计数一变就重载"，列表会在眼前跳十几次）
      if (Date.now() - lastAutoReloadAt < AUTO_RELOAD_MIN_MS) {
        probe.throttled += 1;
        return;
      }
      lastAutoReloadAt = Date.now();
      probe.autoReloads += 1;
      probe.lastAutoReloadAt = lastAutoReloadAt;
      await refreshOptions();
      await replayQuery();
    }
  }

  /**
   * 验收探针（只读，不参与业务）。存在的理由：
   * Q4 的两条规则（15 秒节流 / 四类"不打扰"条件）是闭包里的私有逻辑，
   * 从外部只能通过"计时 + 计数"间接观察；留一组只读计数让验收脚本能拿到证据，
   * 而不是靠"读源码里有这个字符串"这种弱证据。
   */
  const probe = {
    /** 自动重载实际发生的次数（通过节流并执行了的）。 */
    autoReloads: 0,
    /** 因为 15 秒窗口未到而被跳过的次数。 */
    throttled: 0,
    /** 被"不打扰"条件挡下的次数。 */
    skipped: 0,
    /** 上次自动重载的时间戳（可写：验收脚本要造"上次重载在 N 秒前"这个前置条件）。 */
    lastAutoReloadAt: 0,
    /** 节流窗口（毫秒）。 */
    autoReloadWindow: AUTO_RELOAD_MIN_MS,
    /** 纯粹按"距上次自动重载过了多久"算还要等多少毫秒（0 = 现在就可以）。
     *  与 untilNextAutoReload 的区别是：这里不读任何实时状态，只做同一套算术，
     *  便于验收脚本在没有竞态的前提下核对窗口边界。 */
    throttleWait(elapsedMs) { return Math.max(0, AUTO_RELOAD_MIN_MS - Math.max(0, elapsedMs)); },
    /** 当前是否满足自动重载的条件（等价于内部 shouldAutoReload）。 */
    autoReloadCandidate() { return shouldAutoReload(store.getState()); },
    /** 距离下一次允许自动重载还差多少毫秒（0 = 现在就可以）。
     *  可以显式传 now：验收脚本要摆脱"页面上刚好也在重载"的竞态。 */
    untilNextAutoReload(now = Date.now()) { return Math.max(0, AUTO_RELOAD_MIN_MS - (now - lastAutoReloadAt)); },
    /** 当前状态下的"不打扰"原因（用于验收时看得见到底卡在哪一条）。 */
    blockReason(state = store.getState()) {
      if (document_.hidden) return 'hidden';
      if (state.selected.size) return 'selection';
      if (isSearchMode(state)) return 'search-mode';
      if (searching) return 'searching';
      if (uploading) return 'uploading';
      if (state.busy) return 'busy';
      if (overlayOpen()) return 'overlay';
      if (state.view !== 'library') return 'view';
      return null;
    },
  };

  /* ======================================================================
     10) 事件绑定（全部 addEventListener；CSP 禁内联事件）
     ====================================================================== */

  /** 3.1 - 3.3 提交检索 */
  searchForm.addEventListener('submit', async event => {
    event.preventDefault();
    queryIntent = null;
    try {
      await runSearch();
    } catch (error) {
      store.toast(error && error.message ? error.message : String(error));
    }
  });

  /** 3.2 文字输入与参考图互斥：输入框一有内容就把参考图去掉 */
  searchInput.addEventListener('input', () => {
    if (searchInput.value && referenceFile) {
      clearReference();
      store.toast('已改用文字搜索，参考图已移除');
    }
  });

  /** 3.11 / 3.12 选择与拖放 */
  dropZone.addEventListener('click', event => {
    if (!event.target.closest('button')) referenceInput.click();
  });
  dropZone.addEventListener('keydown', event => {
    if (event.target === dropZone && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      referenceInput.click();
    }
  });
  dropZone.addEventListener('dragover', event => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    dropZone.dataset.drag = 'true';
  });
  dropZone.addEventListener('dragleave', event => {
    if (!dropZone.contains(event.relatedTarget)) dropZone.dataset.drag = 'false';
  });
  dropZone.addEventListener('drop', store.guard(event => {
    event.preventDefault();
    dropZone.dataset.drag = 'false';
    const files = [...event.dataTransfer.files];
    if (files.length !== 1) throw new Error('每次请选择一张参考图片');
    setReference(files[0]);
  }));
  referenceInput.addEventListener('change', store.guard(() => setReference(referenceInput.files[0])));
  referenceClear.addEventListener('click', event => { event.stopPropagation(); clearReference(); });

  /** 3.9 严格度变更即重查（仅当当前不是浏览模式） */
  for (const label of strictRadios) {
    label.querySelector('input').addEventListener('change', store.guard(async () => {
      setStrictness(label.dataset.value);
      if (isSearchMode(store.getState())) await replayQuery();
    }));
  }

  /** 2.10 清空所有筛选 + 重置搜索（「重置」按钮：连查询意图一起清掉） */
  resetButton.addEventListener('click', store.guard(() => resetAll()));
  /** 2.10 「清空所有筛选」：只清筛选，但**也**要丢掉查询意图——
      否则界面已经回到浏览模式，下一次自动重载还会拿旧意图去重放检索。 */
  clearFiltersButton.addEventListener('click', store.guard(async () => {
    store.resetFilters();
    discardQuery();
    await applyFilters();
  }));
  clearTagsButton.addEventListener('click', store.guard(async () => {
    await applyFilterChange(() => store.setTags([]));
  }));

  /** 2.2 六个筛选维度 + 排序 */
  albumFilter.addEventListener('change', store.guard(() => applyFilterChange(() => store.setFilter('album_id', albumFilter.value))));
  locationFilter.addEventListener('input', () => { locationFilter.dataset.dirty = 'true'; });
  locationFilter.addEventListener('change', store.guard(() => applyFilterChange(() => store.setFilter('location', locationFilter.value))));
  locationFilter.addEventListener('keydown', store.guard(async event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    delete locationFilter.dataset.dirty;
    await applyFilterChange(() => store.setFilter('location', locationFilter.value));
  }));
  startFilter.addEventListener('change', store.guard(() => applyFilterChange(() => store.setFilter('start', startFilter.value))));
  endFilter.addEventListener('change', store.guard(() => applyFilterChange(() => store.setFilter('end', endFilter.value))));
  favoriteFilter.addEventListener('click', store.guard(() => applyFilterChange(() => {
    store.setFilter('favorite', favoriteFilter.getAttribute('aria-checked') !== 'true');
  })));
  orderSelect.addEventListener('change', store.guard(() => applyFilterChange(() => store.setFilter('order', orderSelect.value))));
  tagKeyword.addEventListener('input', () => renderTagCloud());

  /** 2.8 加载更多 */
  loadMore.addEventListener('click', store.guard(async () => {
    loadMore.disabled = true;
    try {
      await fetchBrowse({ append: true });
    } finally {
      loadMore.disabled = false;
    }
  }));

  /** 筛选栏收放（窄屏抽屉）。桌面恒开，窄屏默认收起，避免侧栏把结果挤到屏幕外。 */
  const NARROW_QUERY = '(max-width: 1080px)';
  let narrowQuery = null;

  function syncDrawerToViewport() {
    if (!narrowQuery) return;
    const open = !narrowQuery.matches;          // 宽屏恒开；窄屏默认收起（用户点过就以用户为准）
    sidebar.dataset.open = open ? 'true' : 'false';
    filtersToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  filtersToggle.addEventListener('click', () => {
    const open = sidebar.dataset.open === 'true';
    sidebar.dataset.open = open ? 'false' : 'true';
    filtersToggle.setAttribute('aria-expanded', open ? 'false' : 'true');
  });

  /** 5.2 全选 / 取消全选 */
  selectAll.addEventListener('click', () => {
    const items = store.getState().results.items;
    const allChecked = items.length > 0 && store.getState().selected.size === items.length;
    store.selectAll(allChecked ? [] : items.map(photo => photo.id));
    renderSelection();
  });

  /** 5.6 / 5.7 / 5.8 */
  batchFavorite.addEventListener('click', store.guard(() => batch('PATCH', { favorite: true })));
  batchMove.addEventListener('click', store.guard(() => batch('PATCH', { album_id: batchAlbum.value || null })));
  batchDelete.addEventListener('click', store.guard(() => batch('DELETE')));

  /** 7.4 新建相册（用模态框，不用 prompt；阶段 4.2） */
  newAlbumButton.addEventListener('click', () => {
    albumName.value = '';
    setText(dialogTitle, '新建相册');
    dialogBody.replaceChildren(albumForm);
    if (modals) modals.open(dialog);
    albumName.focus();
  });
  albumForm.addEventListener('submit', store.guard(async event => {
    event.preventDefault();
    const name = albumName.value.trim();
    if (!name) return;
    await api.post('/albums', { name: name.slice(0, 80) });
    if (modals) modals.close(dialog);
    await refreshOptions();
    store.toast('相册已创建');
  }));

  /** 上传入口（最小形态，完整队列归 F6） */
  uploadButton.addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', store.guard(() => onUpload(uploadInput.files)));

  /* ======================================================================
     11) 生命周期
     ====================================================================== */

  function resetLocalState() {
    queryIntent = null;
    healthSnapshot = '';
    clearReference();
    clearModelHint();
    searching = false;
    uploading = false;
    setSearchBusy(false);
    searchForm.reset();
    setStrictness('balanced');
    nodes.uploadStatus.hidden = true;
    if (modals) modals.close(dialog);
  }

  async function refreshAll() {
    await refreshOptions();
    await replayQuery();
    await updateHealth({ force: true });
  }

  return {
    element: root,
    nodes,
    mount(parent) {
      parent.replaceChildren(root);
      unsubscribe = store.subscribe(render);
      resetLocalState();
      renderFilters();
      renderSelection();
      renderResultsBar();
      renderGrid();
      renderEmpty();
      setStrictness('balanced');
      // 每次挂载都重新对账一次（登出再登录、账户切换后都要干净）
      (async () => {
        try {
          await refreshAll();
        } catch (error) {
          store.toast(error && error.message ? error.message : String(error));
        }
      })();
      if (pollTimer === null) {
        pollTimer = setInterval(() => {
          updateHealth().catch(() => {});
        }, store.HEALTH_POLL_MS);
        ownsPollTimer = true;
      }
      // 窄屏抽屉：挂载时对一次，视口变化时（同一个媒体查询状态内的变化不用管）再对一次
      if (!narrowQuery && typeof window !== 'undefined' && window.matchMedia) {
        narrowQuery = window.matchMedia(NARROW_QUERY);
        narrowQuery.addEventListener('change', syncDrawerToViewport);
      }
      syncDrawerToViewport();
    },
    unmount() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (pollTimer !== null && ownsPollTimer) clearInterval(pollTimer);
      if (ownsPollTimer) pollTimer = null;
      ownsPollTimer = false;
      if (narrowQuery) {
        narrowQuery.removeEventListener('change', syncDrawerToViewport);
        narrowQuery = null;
      }
      clearModelHint();
      root.remove();
    },
    // 验收脚本与详情视图（F5）会用到的入口
    validateDates,
    /**
     * 丢掉当前的查询意图（下一次 replayQuery 会退回浏览列表）。
     * 用途：清空筛选 / 重置搜索之后，界面已经在浏览模式了，旧的检索意图不该再被重放。
     */
    discardQuery,
    runSearch,
    runSimilar,
    replayQuery,
    fetchBrowse,
    refreshOptions,
    refreshAll,
    updateHealth,
    setReference,
    clearReference,
    probe,
    get referenceFile() { return referenceFile; },
    get queryIntent() { return queryIntent; },
  };
}

export default { createLibraryView, EMPTY_COPY, validateDates, PAGE_SIZE, AUTO_RELOAD_MIN_MS };
