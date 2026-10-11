/* ==========================================================================
   AIbum · 照片详情  web/js/views/detail.js
   --------------------------------------------------------------------------
   阶段 3.3（F5）。逐条对照 docs/前端-行为清单.md 第 6 节：

     6.1  详情请求     GET /photos/{id} 取全字段
     6.2  元信息行     `${宽} × ${高} · ${MB} MiB · ${相机型号或"无相机信息"}`
     6.3  自动标签行   `${名称}：${分数.toFixed(3)}` 用 ` / ` 连接
                       + 固定说明「（推荐分数不是概率；修改标签后保存为人工标签）」
     6.4  状态行       photo.error 优先，否则状态中文名
     6.5  按钮条件启用 「找相似」仅 ready 可用；「重新分析」仅 ready / failed 可用
     6.6  下载原图     original_url + '?download=true'
     6.7  保存修改     PATCH /photos/{id} {name, location, album_id|null, favorite}
     6.8  **标签仅在变化时才提交** —— 本卡最容易漏、后果最重的一条，见 buildPatchBody()
     6.9  重新分析     POST /photos/{id}/retry → 关详情 → 重载 → 通知"已加入分析队列"
     6.10 找相似入口   从详情发起相似检索并关闭详情

   形态（决策台账 D2）：**右侧抽屉**（用户尚未拍板；这是按默认值做的，待确认）。
   实现上它**不是**与主界面并列的视图，而是叠在主界面之上的浮层：
   路由仍是 #/photo/:id（D6 的 hash 路由，可深链、可后退），但 store.view 为 'photo' 时
   主界面**保持挂载**（见 js/app.js 的 activeView）。理由：抽屉关掉后要回到原来的结果集，
   若走"卸载主界面 → 再挂回来"，用户翻到第 5 页的列表会被打回第 1 页。

   浮层复用设计系统的共享遮罩与浮层管理器（components/modal.js）：
   Esc 关闭、点遮罩关闭、Tab 焦点陷阱、关闭后焦点归还，与账户安全对话框同一份实现；
   顺带让 library.js 的"详情打开时不自动重载列表"（行为清单 9.3）拿到真值
   （它的 overlayOpen() 读的就是 modals.isOpenAll()）。

   两处**竞态**是写这一版时实测想清楚的，改代码时别踩回去：
     R1「关了又被自己弹开」：保存成功后是先关抽屉、再刷新列表；刷新会 emit 一串 store 事件，
        而此刻地址栏**还没**变（hashchange 是异步的）→ 中间任何一次渲染都会让 sync() 以为
        "路由说该开着" 而把抽屉重新弹开。解法是 leaving/leavingId：一旦决定离开，就在路由
        真的走掉之前拒绝重开同一张照片。
     R2「点 A 再点 B」：GET 回来的顺序不保证。解法是 token 令牌，所有异步续作先核对它。

   CSP（§0A）：全部 createElement + addEventListener，无内联脚本/样式/style 属性/内联事件。
   ========================================================================== */

import { api } from '../api.js';
import * as router from '../router.js';
import * as store from '../store.js';
import { h } from '../components/dom.js';
import { createSelectMenu } from '../components/select-menu.js';

/** 标签分隔符：半角逗号 + 中文逗号（行为清单 6.8 / legacy L229）。 */
export const TAG_SPLIT = /[,，]/;

/** 自动标签行的固定说明（行为清单 6.3，逐字对齐 legacy L221）。 */
export const AUTO_TAG_NOTE = '（推荐分数不是概率；修改标签后保存为人工标签）';

/** 没有自动标签时的占位（清单未规定；不写这句会出现"只剩一个括号说明"的行）。 */
export const NO_AUTO_TAGS = '暂无自动标签';

/**
 * 6.8 第一步：把输入框里的标签切成数组。
 * 按 `[,，]` 切分 → 逐项去空白 → 丢掉空项。**保留顺序**（不排序、不去重：
 * 这里只回答"用户是不是改了"，去重是后端 clean_tags 的事）。
 * @param {string} value 输入框原值
 * @returns {string[]}
 */
export function parseTagInput(value) {
  return String(value == null ? '' : value)
    .split(TAG_SPLIT)
    .map(name => name.trim())
    .filter(Boolean);
}

/**
 * 6.8 第二步：逐项比较（顺序敏感，等价于 legacy L230 的 JSON.stringify 比较）。
 * @param {string[]} before 原有标签名
 * @param {string[]} after 输入框里的标签名
 * @returns {boolean} true = 变了
 */
export function tagsChanged(before, after) {
  const a = (before || []).map(String);
  const b = (after || []).map(String);
  if (a.length !== b.length) return true;
  return a.some((name, index) => name !== b[index]);
}

/**
 * 6.7 + 6.8：组装 PATCH 请求体。
 *
 * **标签没变就绝不带 `tags` 字段。** 后端的语义（app/main.py:430-439）是：请求体里只要出现
 * `tags`，就 `tags_edited=1`、删掉全部 photo_tags、再以 source='manual' 重新插入——
 * 也就是说，用户只改了个名字，AI 自动标签就会被静默替换成人工标签，而且没有任何报错。
 * 所以必须逐项比较之后才决定带不带。
 *
 * @param {{tags?: {name: string}[]}} photo 服务端返回的照片对象（比较基准）
 * @param {{name: string, location: string, album_id: string, favorite: boolean, tagText: string}} values
 * @returns {{name: string, location: string, album_id: string|null, favorite: boolean, tags?: string[]}}
 */
export function buildPatchBody(photo, values) {
  const body = {
    name: values.name,
    location: values.location,
    album_id: values.album_id ? values.album_id : null,
    favorite: Boolean(values.favorite),
  };
  const before = (photo && photo.tags ? photo.tags : []).map(tag => String(tag.name));
  const after = parseTagInput(values.tagText);
  if (tagsChanged(before, after)) body.tags = after;
  return body;
}

/** 请求体里是否带上了 tags（6.8 的唯一判据；验收脚本与 probe 共用）。 */
export function hasTagsField(body) {
  return Object.prototype.hasOwnProperty.call(body || {}, 'tags');
}

/**
 * 6.2 元信息行。
 * @param {{width: number, height: number, size: number, camera?: string}} photo
 */
export function formatMeta(photo) {
  const size = Number(photo.size) || 0;
  return `${photo.width} × ${photo.height} · ${(size / 1024 / 1024).toFixed(2)} MiB · ${photo.camera || '无相机信息'}`;
}

/**
 * 6.3 自动标签行：只取 source === 'auto' 的标签，`名称：分数(3 位小数)` 用 ` / ` 连接，
 * 结尾**无条件**带上固定说明（没标签时也要带，否则用户不知道改标签的后果）。
 * @param {{name: string, source: string, score: number|null}[]} tags
 */
export function formatAutoTags(tags) {
  const auto = (tags || [])
    .filter(tag => tag && tag.source === 'auto')
    .map(tag => {
      const score = Number(tag.score);
      return `${tag.name}：${Number.isFinite(score) ? score.toFixed(3) : '—'}`;
    });
  return (auto.length ? auto.join(' / ') : NO_AUTO_TAGS) + AUTO_TAG_NOTE;
}

/** 6.4 状态行：error 文本优先，否则状态中文名。 */
export function formatState(photo, statusName) {
  const label = statusName || (status => status);
  return photo && photo.error ? String(photo.error) : label(photo ? photo.status : '');
}

/**
 * 6.5 按钮可用性（纯函数，便于逐状态核对）。
 * 「找相似」仅 ready；「重新分析」仅 ready / failed。
 * @param {string} status
 * @returns {{similar: boolean, retry: boolean}}
 */
export function buttonsFor(status) {
  return {
    similar: status === 'ready',
    retry: status === 'ready' || status === 'failed',
  };
}

/**
 * 建照片详情抽屉。
 * @param {{
 *   modals?: object,
 *   navigate?: (target: string, options?: object) => any,
 *   runSimilar?: (id: string) => Promise<any>,
 *   onSaved?: () => Promise<any> | any,
 *   onRetried?: () => Promise<any> | any,
 *   history?: History,
 *   document?: Document,
 * }} [options]
 * @returns {{element: HTMLElement, mount(parent: Element): void, unmount(): void,
 *            sync(state: object): void, open(id: string): Promise<any>, close(): void,
 *            nodes: object, probe: object}}
 */
export function createDetailView(options = {}) {
  const document_ = options.document || document;
  const modals = options.modals || null;
  const navigate = options.navigate || ((target, opts) => router.navigate(target, opts));
  const runSimilar = options.runSimilar || (() => Promise.resolve());
  const onSaved = options.onSaved || (() => {});
  const onRetried = options.onRetried || (() => {});

  /* ======================================================================
     0) 视图局部状态
     ====================================================================== */

  /** 当前照片对象（服务端原样；6.8 的比较基准就是它的 tags）。 */
  let photo = null;
  /** 当前打开的照片 id。 */
  let currentId = null;
  /** 抽屉是否处于打开态。 */
  let opened = false;
  /** 打开/关闭令牌：所有异步续作先核对它（竞态 R2）。 */
  let token = 0;
  /** 路由驱动的关闭期间置位：此时 modals 的 onClose 不许再动地址栏。 */
  let suppressNavigate = false;
  /** 竞态 R1：已经决定离开这一张，正在等路由跟上 —— 期间拒绝把它重开。 */
  let leaving = false;
  let leavingId = null;

  /** 只读探针：验收脚本拿证据用，不参与业务。 */
  const probe = {
    /** GET /photos/{id} 成功次数。 */
    opens: 0,
    /** 关闭次数。 */
    closes: 0,
    /** 最近一次离开详情的方式（恒为 'replace'，见 routeAway 的说明）。 */
    closeMode: '',
    /** 最近一次打开的照片 id。 */
    lastId: null,
    /** 每一次 PATCH 的请求体（视图自己组的那份；与 CDP 抓到的线上报文互相印证）。 */
    patchBodies: [],
    /** 最近一次请求体里有没有 tags 字段（6.8 的判据）。 */
    tagsSubmitted: null,
    /** 最近一次打开时的按钮可用性快照。 */
    buttons: null,
    /** 填充次数（自检用）。 */
    fills: 0,
    /** 被 leaving 拦下的"重新弹开"次数（竞态 R1 的计数器，>0 说明那条路被真实走到过）。 */
    reopenBlocked: 0,
  };

  /* ======================================================================
     1) DOM（全部 createElement；id 与 legacy index.html L53 对齐，便于逐行对照）
     ====================================================================== */

  const image = h('img', { className: 'detail__image', id: 'detail-image', 'data-role': 'image', alt: '' });
  const imageNote = h('p', { className: 'detail__image-note', 'data-role': 'image-note', hidden: true });
  const figure = h('figure', { className: 'detail__figure' }, [image, imageNote]);

  const meta = h('p', { className: 'detail__meta', id: 'detail-meta', 'data-role': 'meta' });

  const title = h('h2', { className: 'dialog__title', id: 'detail-title', text: '照片详情' });
  const heading = h('div', { className: 'detail__heading' }, [
    h('p', { className: 'eyebrow', text: 'PHOTO DETAILS' }),
    title,
    meta,
  ]);

  const closeButton = h('button', {
    className: 'btn btn--icon btn--ghost detail__close',
    type: 'button',
    'data-close': 'detail',
    'aria-label': '关闭详情',
    text: '✕',
  });

  const head = h('div', { className: 'drawer__head' }, [heading, closeButton]);

  const nameInput = h('input', {
    className: 'input', id: 'detail-name', name: 'name', required: true, maxlength: '200', autocomplete: 'off',
  });
  const locationInput = h('input', {
    className: 'input', id: 'detail-location', name: 'location', maxlength: '200',
    placeholder: '可手动填写', autocomplete: 'off',
  });
  /* 所属相册：设计系统的 .menu 形态（原生 <select> 的展开弹层是系统画的，与风格割裂）。
     读写入口是 getValue()/setValue()，`buildPatchBody` 的判据（6.7 / 6.8）逐字未动。 */
  const albumSelect = createSelectMenu({
    id: 'detail-album',
    labelledBy: 'detail-album-label',
    label: '所属相册',
    options: [{ value: '', label: '未归入相册' }],
    document: document_,
  });
  const tagsInput = h('input', {
    className: 'input', id: 'detail-tags', name: 'tags', placeholder: '旅行, 海边', autocomplete: 'off',
  });
  const favoriteSwitch = h('button', {
    className: 'switch', id: 'detail-favorite', type: 'button', role: 'switch',
    'aria-checked': 'false', 'aria-labelledby': 'detail-favorite-label',
  });
  const autoText = h('p', { className: 'detail__auto', id: 'detail-auto', 'data-role': 'auto' });
  const stateText = h('p', { className: 'detail__state', id: 'detail-state', 'data-role': 'state' });

  const form = h('form', { className: 'detail__form', id: 'detail-form' }, [
    h('div', { className: 'drawer__body detail__body' }, [
      figure,
      h('div', { className: 'field' }, [h('label', { for: 'detail-name', text: '照片名称' }), nameInput]),
      h('div', { className: 'field' }, [h('label', { for: 'detail-location', text: '地点' }), locationInput]),
      h('div', { className: 'field' }, [
        h('span', { className: 'label', id: 'detail-album-label', text: '所属相册' }),
        albumSelect.element,
      ]),
      h('div', { className: 'field' }, [
        h('label', { for: 'detail-tags', text: '标签（用逗号分隔）' }),
        tagsInput,
      ]),
      autoText,
      h('div', { className: 'detail__favorite' }, [
        favoriteSwitch,
        h('span', { className: 'detail__favorite-label', id: 'detail-favorite-label', text: '收藏这张照片' }),
      ]),
      stateText,
    ]),
    h('div', { className: 'drawer__foot detail__foot' }, [
      h('button', { className: 'btn btn--primary', type: 'submit', 'data-role': 'save', text: '保存修改' }),
      h('button', {
        className: 'btn', id: 'detail-similar', type: 'button', 'data-role': 'similar', text: '找相似',
      }),
      h('button', {
        className: 'btn', id: 'detail-retry', type: 'button', 'data-role': 'retry', text: '重新分析',
      }),
      // 6.6：下载原图 = original_url + '?download=true'（href 由 fill() 写；不用内联属性）
      h('a', { className: 'btn btn--ghost', id: 'detail-download', 'data-role': 'download', text: '下载原图' }),
    ]),
  ]);

  const element = h('aside', {
    className: 'drawer detail',
    id: 'photo-detail',
    'data-role': 'detail',
    'data-open': 'false',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'detail-title',
    hidden: true,
  }, [
    head,
    form,
  ]);

  const similarButton = form.querySelector('#detail-similar');
  const retryButton = form.querySelector('#detail-retry');
  const downloadLink = form.querySelector('#detail-download');

  const nodes = {
    element, form, head, meta, title, image, imageNote, nameInput, locationInput,
    albumSelect: albumSelect.element, tagsInput, favoriteSwitch, autoText, stateText,
    saveButton: form.querySelector('[data-role="save"]'),
    similarButton, retryButton, downloadLink, closeButton,
  };

  /* ======================================================================
     2) 渲染
     ====================================================================== */

  /** 7.2 相册下拉：显示 `名称 (数量)`，保留当前选中值（仍在列表里才保留）。
   *  换用 .menu 形态后 `setOptions(..., {keepValue})` 就是这条语义（不在列表里 → 归零）。 */
  function fillAlbums(albums, selected) {
    albumSelect.setOptions([
      { value: '', label: '未归入相册' },
      ...(albums || []).map(item => ({
        value: item.id,
        label: `${item.name} (${item.count === undefined ? 0 : item.count})`,
      })),
    ], { keepValue: selected === undefined || selected === null ? '' : String(selected) });
  }

  /** 把一张照片填进界面（6.2 / 6.3 / 6.4 / 6.5 / 6.6 + 各字段初值）。 */
  function fill(item, albums) {
    photo = item;
    const buttons = buttonsFor(item.status);
    probe.buttons = { status: item.status, similar: buttons.similar, retry: buttons.retry };
    probe.fills += 1;

    image.setAttribute('src', item.original_url);
    image.setAttribute('alt', item.name);
    image.dataset.failed = 'false';
    imageNote.hidden = true;

    meta.textContent = formatMeta(item);
    nameInput.value = item.name;
    locationInput.value = item.location || '';
    fillAlbums(albums, item.album_id || '');
    // 6.8 的比较基准就在这一行：界面里的标签初值 = 服务端标签名，顺序也一致
    tagsInput.value = (item.tags || []).map(tag => tag.name).join(', ');
    autoText.textContent = formatAutoTags(item.tags);
    favoriteSwitch.setAttribute('aria-checked', item.favorite ? 'true' : 'false');
    stateText.textContent = formatState(item, store.statusName);
    stateText.dataset.status = item.status;

    similarButton.disabled = !buttons.similar;
    retryButton.disabled = !buttons.retry;
    similarButton.title = buttons.similar ? '以这张照片为参考图检索相似照片' : '照片完成分析后才能找相似';
    retryButton.title = buttons.retry ? '重新排队分析' : '仅已分析 / 分析失败的照片可以重新分析';
    // 6.6 下载原图
    downloadLink.setAttribute('href', item.original_url + '?download=true');
  }

  /** 打开过程的占位（抽屉先出现、数据后到，避免点一下像没反应）。 */
  function fillLoading() {
    photo = null;
    meta.textContent = '正在读取照片信息…';
    nameInput.value = '';
    locationInput.value = '';
    tagsInput.value = '';
    autoText.textContent = '';
    stateText.textContent = '正在加载…';
    favoriteSwitch.setAttribute('aria-checked', 'false');
    similarButton.disabled = true;
    retryButton.disabled = true;
    downloadLink.removeAttribute('href');
    image.removeAttribute('src');
    image.dataset.failed = 'false';
    probe.buttons = null;
  }

  /** 相册选项：详情自己拉一次（GET /albums 很轻），这样深链进详情不依赖主界面加载到哪一步。 */
  async function loadAlbums() {
    try {
      return await api.get('/albums');
    } catch {
      return [];
    }
  }

  /* ======================================================================
     3) 打开 / 关闭（路由是唯一真相源，见 app.js）
     ====================================================================== */

  function show() {
    if (opened) return;
    opened = true;
    if (modals) modals.open(element);
    else element.hidden = false;
    // 位移动画：不靠过渡。抽屉的出现/消失与路由绑定，而路由随时可能变
    // （后退键 / 深链 / 登出），动画会和路由驱动的关闭抢同一帧 —— 正确性优先。
    element.dataset.open = 'true';
  }

  function hide() {
    if (!opened) return;
    opened = false;
    // 路由驱动的关闭：先置位，免得 modals 的 onClose 又去改地址栏（会和这次路由打架）
    suppressNavigate = true;
    try {
      if (modals) modals.close(element);
      else element.hidden = true;
    } finally {
      suppressNavigate = false;
    }
    element.dataset.open = 'false';
  }

  /**
   * 离开详情、把地址栏带回主界面 —— **一律用 replace，不用 history.back()**。
   *
   * 为什么不 back()：抽屉可能来自两种进入方式，
   *   ① 页内点开卡片（#/photo/:id 是我们自己 push 的）→ back() 正好回列表；
   *   ② 直接打开 /static/app.html#/photo/:id（深链 / 别人分享的地址）→ 这一条是**文档自己的**
   *      历史条目，back() 会把用户带出站点（实测：退到 about:blank）。
   * 两者在 history 里都是"state=null 的条目"，没有可靠办法区分；而判错的代价是"用户被弹出站点"。
   * 所以统一 replace：深链关闭后停在 #/library（安全）；页内点开关闭后在历史里留下一个
   * 与当前相同的 #/library 条目，代价是**多按一次后退键看不出变化**——这个代价可以接受。
   * （浏览器自带的后退键不受影响：那是 popstate → applyRoute → sync 的关闭路径，见 sync()。）
   *
   * 同时置 leaving（竞态 R1）：在路由真的走掉之前，拒绝把同一张照片重新弹开。
   * @param {{id?: string|null}} [options]
   */
  function routeAway({ id = currentId } = {}) {
    leaving = true;
    leavingId = id === null || id === undefined ? null : String(id);
    probe.closeMode = 'replace';
    navigate('#/library', { replace: true });
  }

  /** 用户主动关闭（✕ / Esc / 点遮罩）→ 交给路由，让 sync() 收尾。 */
  function requestClose() {
    if (!opened) return;
    // 已登出：1.5 的"登出要清空浮层"会走 modals.closeAll() 到这里。
    // 此时路由自己会落到 #/login（main.js 的 syncHashWithSession），**不要**再动地址栏，
    // 否则会先跳一次 #/library 再被踢回 #/login（多余的一跳）。
    if (!store.getState().user) {
      close();
      return;
    }
    routeAway();
  }

  /**
   * 打开某张照片（幂等：同一张已经开着就什么都不做）。
   * @param {string} id
   */
  async function open(id) {
    const photoId = String(id);
    if (opened && currentId === photoId) return photo;
    currentId = photoId;
    leaving = false;
    const myToken = ++token;
    fillLoading();
    show();
    try {
      const [item, albums] = await Promise.all([api.get(`/photos/${photoId}`), loadAlbums()]);
      if (myToken !== token || !opened) return null;      // 已被更晚的操作取代 / 已关闭
      probe.opens += 1;
      probe.lastId = photoId;
      fill(item, albums);
      return item;
    } catch (error) {
      if (myToken !== token) return null;
      // 打开失败（照片被删 / 网络）：收起抽屉并回主界面，别把用户困在一个空壳里。
      // 顺序要紧：**先 routeAway 再报错**。否则报错那次 emit 会触发渲染 → sync 看到
      // "路由还是 #/photo/:id 但抽屉没开" → 又去 GET 一次（R1 护栏就是防这个的）。
      hide();
      currentId = null;
      photo = null;
      routeAway({ id: photoId });
      store.toast(error && error.message ? error.message : String(error));
      return null;
    }
  }

  /** 路由驱动的关闭（sync 发现当前不是详情路由）。 */
  function close() {
    if (!opened && currentId === null) return;
    token += 1;                     // 丢掉在途的 GET 续作
    hide();
    currentId = null;
    photo = null;
    probe.closes += 1;
  }

  /**
   * 每次渲染都调一次：把"当前路由"对齐到"抽屉该不该开"。
   * @param {object} state store 快照
   */
  function sync(state = store.getState()) {
    const isPhotoRoute = state.view === 'photo' && state.routeParams && state.routeParams.id;
    if (isPhotoRoute) {
      const id = String(state.routeParams.id);
      if (leaving && (leavingId === null || leavingId === id)) {
        // 竞态 R1：已经决定离开、路由还没跟上 —— 这一帧不许把它弹回来
        probe.reopenBlocked += 1;
      } else if (!opened || currentId !== id) {
        open(id);
      }
    } else {
      leaving = false;
      leavingId = null;
      if (opened) close();
    }
  }

  /* ======================================================================
     4) 交互
     ====================================================================== */

  // 浮层管理器负责 ✕（data-close）/ Esc / 点遮罩，收尾统一走这里
  if (modals) {
    modals.register(element, {
      onClose: () => {
        if (suppressNavigate) return;      // 路由驱动的关闭：地址栏已经在正确位置了
        requestClose();
      },
    });
  } else {
    closeButton.addEventListener('click', () => requestClose());
  }

  favoriteSwitch.addEventListener('click', () => {
    const next = favoriteSwitch.getAttribute('aria-checked') !== 'true';
    favoriteSwitch.setAttribute('aria-checked', next ? 'true' : 'false');
  });

  image.addEventListener('error', () => {
    image.dataset.failed = 'true';
    imageNote.textContent = '原图暂时无法显示（可能仍在处理，或文件已不可用）。';
    imageNote.hidden = false;
  });

  /* 6.7 保存修改（6.8 的比较在 buildPatchBody 里） */
  form.addEventListener('submit', store.guard(async event => {
    event.preventDefault();
    const current = photo;
    if (!current) return;
    const body = buildPatchBody(current, {
      name: nameInput.value,
      location: locationInput.value,
      album_id: albumSelect.getValue(),
      favorite: favoriteSwitch.getAttribute('aria-checked') === 'true',
      tagText: tagsInput.value,
    });
    probe.patchBodies.push(JSON.parse(JSON.stringify(body)));
    probe.tagsSubmitted = hasTagsField(body);
    await api.patch(`/photos/${current.id}`, body);
    close();
    routeAway({ id: current.id });
    await onSaved();
    store.toast('修改已保存');
  }));

  /* 6.9 重新分析 */
  retryButton.addEventListener('click', store.guard(async () => {
    const current = photo;
    if (!current) return;
    await api.post(`/photos/${current.id}/retry`);
    close();
    routeAway({ id: current.id });
    await onRetried();
    store.toast('已加入分析队列');
  }));

  /* 6.10 找相似（从详情发起，发起后关闭详情） */
  similarButton.addEventListener('click', store.guard(async () => {
    const current = photo;
    if (!current) return;
    await runSimilar(current.id);
    close();
    routeAway({ id: current.id });
  }));

  /* ======================================================================
     5) 生命周期
     ====================================================================== */

  function mount(parent) {
    parent.append(element);
    return element;
  }

  function unmount() {
    close();
    element.remove();
  }

  return {
    element,
    nodes,
    probe,
    mount,
    unmount,
    sync,
    open,
    close,
    /** 供验收脚本读的纯函数（与实现同一份，不做第二套）。 */
    parseTagInput,
    buildPatchBody,
    buttonsFor,
  };
}

export default {
  createDetailView, buildPatchBody, parseTagInput, tagsChanged, hasTagsField,
  buttonsFor, formatMeta, formatAutoTags, formatState,
};
