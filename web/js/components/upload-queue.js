/* ==========================================================================
   AIbum · 上传队列  web/js/components/upload-queue.js
   --------------------------------------------------------------------------
   阶段 3.4「上传体验」。旧前端**没有**队列（只有一个顶栏按钮 + 一条总进度条），
   这是重建要明显改善的地方（docs/前端-行为清单.md §13 最后一行）。
   本卡新增：
     · 每张照片一行：缩略图 + 文件名 + 逐张状态（等待 / 上传中 42% / 已上传 / 失败原因）
     · 失败项**单独重试**（.queue__act[data-role="retry"]）
     · 总体进度（.progress），文案 `上传 i/总数：文件名`（行为清单 4.10 逐字）
     · 有失败项时保留面板，并给一个"清空已完成"

   对照行为清单：
     4.2  逐张串行 + 总体进度   → setProgress(done, total) / setItem(..., {fraction})
     4.6  重复检测             → 行状态 `已上传 · 重复`（由 uploader 传入）
     4.7  完成通知             → 不在这里（走 store.toast，格式由 uploader 拼）
     4.10 进度文案             → setLabel()，逐字 `上传 i/总数：文件名`

   设计系统（css/components.css §14）里 .queue / .queue__item 已经成稿，本文件只填内容。
   状态用 **data-state**（queued / uploading / done / error）而不是类名 —— 与设计系统一致，
   也让验收脚本能一行 querySelector 读到状态。

   CSP（行为清单 §0A）：全部 createElement + textContent；没有内联脚本 / 样式 / style 属性。
   缩略图用 createObjectURL，**移除队列项时 revoke**（行为清单 3.13 的同一条纪律）。
   ========================================================================== */

import { h, setText } from './dom.js';

/** 行状态 → 中文（`duplicate` 是 `done` 的一个变体，单独一档更清楚）。 */
const STATE_TEXT = {
  queued: '等待上传',
  uploading: '上传中',
  done: '已上传',
  error: '上传失败',
};

/** 字节 → MiB（一位小数；与行为清单 6.2 元信息行的写法一致）。 */
function formatMiB(bytes) {
  return (Number(bytes || 0) / 1024 / 1024).toFixed(1);
}

/**
 * 建一个上传队列面板。
 * @param {{document?: Document, onRetry?: (id: string) => any, onRemove?: (id: string) => any,
 *          onClearFinished?: () => any}} [options]
 * @returns {{
 *   element: HTMLElement,
 *   setItems(items: Array<object>): void,
 *   setItem(id: string, patch: object): void,
 *   setLabel(text: string): void,
 *   setProgress(done: number, total: number): void,
 *   setActive(active: boolean): void,
 *   setAlbumName(text: string): void,
 *   setClearVisible(visible: boolean): void,
 *   focusItem(id: string): void,
 * }}
 */
export function createUploadQueue(options = {}) {
  const document_ = options.document || document;
  const onRetry = options.onRetry || null;
  const onRemove = options.onRemove || null;
  const onClearFinished = options.onClearFinished || null;

  /** 队列项的**唯一真相**在这里（视图与上传器都只通过 setItem 改它）。 */
  const items = new Map();
  /** id → 已经建好的 <li> 与其内部节点，避免每次重画丢焦点 / 丢滚动位置。 */
  const rows = new Map();
  /** id → createObjectURL 的地址（移除时必须 revoke）。 */
  const thumbs = new Map();
  /** 展示顺序（重新排队失败项时顺序不变）。 */
  const order = [];

  const list = h('ul', { className: 'queue', 'data-role': 'upload-queue-list' });
  const label = h('span', { className: 'queue__label', 'data-role': 'upload-label' });
  const albumNote = h('span', { className: 'queue__album', 'data-role': 'upload-album', hidden: true });
  const clearButton = h('button', {
    type: 'button', className: 'btn btn--sm btn--ghost', 'data-role': 'upload-clear',
    hidden: true, text: '清空已完成',
  });
  const progressFill = h('span', { className: 'progress__fill', 'data-role': 'upload-progress-fill' });
  const progress = h('div', {
    className: 'progress', id: 'progress', role: 'progressbar', 'aria-label': '上传进度',
    'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'data-role': 'upload-progress',
  }, [progressFill]);

  const element = h('section', {
    className: 'library__upload', 'data-role': 'upload-queue', hidden: true, 'aria-label': '上传队列',
  }, [
    h('div', { className: 'queue__head' }, [
      label,
      albumNote,
      h('span', { className: 'spacer' }),
      clearButton,
    ]),
    progress,
    list,
  ]);

  /* ------------------------------------------------------------------------
     一行：缩略图 + 名字 + 状态/原因 + 操作
     ------------------------------------------------------------------------ */

  function buildRow(item) {
    const thumb = h('span', { className: 'queue__thumb', 'data-role': 'upload-thumb' });
    const name = h('span', { className: 'queue__name', 'data-role': 'upload-name', text: item.name });
    const state = h('span', { 'data-role': 'upload-item-state' });
    const detail = h('span', { 'data-role': 'upload-item-detail' });
    const meta = h('span', { className: 'queue__meta' }, [state, detail]);
    const body = h('div', { className: 'queue__body' }, [name, meta]);
    const retry = h('button', {
      type: 'button', className: 'btn btn--sm btn--ghost queue__act--text', 'data-role': 'upload-retry',
      'aria-label': `重试上传 ${item.name}`, text: '重试', hidden: true,
    });
    const remove = h('button', {
      type: 'button', className: 'btn btn--sm btn--ghost queue__act--text', 'data-role': 'upload-remove',
      'aria-label': `从队列移除 ${item.name}`, text: '移除',
    });
    const acts = h('div', { className: 'queue__acts' }, [retry, remove]);
    const row = h('li', {
      className: 'queue__item', 'data-role': 'upload-item', 'data-id': item.id, 'data-state': 'queued',
      'aria-label': item.name,
    }, [thumb, body, acts]);

    if (onRetry) retry.addEventListener('click', () => onRetry(item.id));
    if (onRemove) remove.addEventListener('click', () => onRemove(item.id));

    const entry = { row, thumb: thumb, name, state, detail, retry, remove };
    rows.set(item.id, entry);
    return entry;
  }

  /** 缩略图：能从 File 生成预览就生成，不能就留一个占位块（不要崩）。 */
  function paintThumb(entry, item) {
    if (!item.file || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
    if (thumbs.has(item.id)) return;
    try {
      const url = URL.createObjectURL(item.file);
      thumbs.set(item.id, url);
      const image = h('img', { className: 'queue__thumb', alt: '', src: url, 'data-role': 'upload-thumb-img' });
      entry.thumb.replaceChildren(image);
    } catch {
      /* 预览失败不影响上传 */
    }
  }

  /** 把一条记录画到行上。状态文案与"重试/移除"的可用性都在这里，别处不许手改 DOM。 */
  function paint(id) {
    const item = items.get(id);
    const entry = rows.get(id);
    if (!item || !entry) return;
    entry.row.dataset.state = item.state;
    const busy = item.state === 'uploading';
    if (item.state === 'done') {
      setText(entry.state, item.duplicate ? '已上传 · 重复' : STATE_TEXT.done);
      // 4.6：重复不需要解释太多，但要说清"没有新增一张"
      setText(entry.detail, item.duplicate ? '内容与已有照片相同，未新增' : '');
    } else if (item.state === 'error') {
      setText(entry.state, STATE_TEXT.error);
      setText(entry.detail, item.error || '');
    } else if (busy) {
      setText(entry.state, `${STATE_TEXT.uploading} ${Math.round((item.fraction || 0) * 100)}%`);
      setText(entry.detail, item.size ? `${formatMiB(item.size)} MiB` : '');
    } else {
      setText(entry.state, STATE_TEXT.queued);
      setText(entry.detail, item.size ? `${formatMiB(item.size)} MiB` : '');
    }
    entry.retry.hidden = item.state !== 'error';
    entry.retry.disabled = !onRetry;
    entry.remove.hidden = busy;
    entry.remove.disabled = busy;
    entry.row.setAttribute('aria-label', `${item.name}：${entry.state.textContent}${entry.detail.textContent ? '，' + entry.detail.textContent : ''}`);
  }

  /** 字节 → MiB（一位小数；与行为清单 6.2 元信息行的写法一致）。 */
  function formatMiB(bytes) {
    return (Number(bytes || 0) / 1024 / 1024).toFixed(1);
  }

  function syncVisibility() {
    element.hidden = items.size === 0;
    const finished = [...items.values()].filter(item => item.state !== 'queued' && item.state !== 'uploading').length;
    clearButton.hidden = finished === 0;
  }

  // "清空已完成"由外部决定做什么（通常是只留下失败项）。
  // 注意：这一段必须在 return 之前 —— 放到 return 后面就是死代码（实测踩过：
  // 按钮画得出来、点了却没有任何反应，因为监听器从未挂上）。
  if (onClearFinished) clearButton.addEventListener('click', () => onClearFinished());

  return {
    element,

    /** 整批替换（新一批上传开始时调用）。会 revoke 上一批的缩略图地址。 */
    setItems(next) {
      for (const [id, url] of thumbs) {
        try { URL.revokeObjectURL(url); } catch { /* 已经失效 */ }
        thumbs.delete(id);
      }
      items.clear();
      rows.clear();
      order.length = 0;
      for (const item of next || []) {
        // state 也给个默认：调用方（views/upload.js）总会带，但这里不该因为少传一个字段
        // 就把 data-state 写成字符串 "undefined"（实测踩过：行状态全变成 undefined）。
        const record = { state: 'queued', fraction: 0, duplicate: false, error: '', size: 0, ...item };
        items.set(record.id, record);
        order.push(record.id);
      }
      list.replaceChildren(...order.map(id => buildRow(items.get(id)).row));
      for (const id of order) {
        paintThumb(rows.get(id), items.get(id));
        paint(id);
      }
      syncVisibility();
    },

    /** 改一行的状态（部分字段；未提及的字段保持不变）。 */
    setItem(id, patch) {
      const item = items.get(id);
      if (!item) return null;
      Object.assign(item, patch);
      paint(id);
      syncVisibility();
      return item;
    },

    /** 4.10 逐字文案：`上传 i/总数：文件名`。 */
    setLabel(text) {
      setText(label, text || '');
      return label;
    },

    /** 总体进度（4.2）：`(i + 分数) / 总数 * 100`。 */
    setProgress(done, total) {
      const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
      const percent = ratio * 100;
      progressFill.style.setProperty('width', `${percent.toFixed(2)}%`);
      progress.setAttribute('aria-valuenow', String(Math.round(percent)));
      progress.dataset.value = percent.toFixed(2);
      return percent;
    },

    /** 面板是否展示（队列空则整块隐藏）。 */
    setActive(active) {
      element.hidden = !active && items.size === 0;
      return active;
    },

    /** 目标相册提示（Q2：显式选择，这里把选择结果亮出来）。 */
    setAlbumName(text) {
      setText(albumNote, text || '');
      albumNote.hidden = !text;
      return albumNote;
    },

    /** "清空已完成"按钮的显隐由 syncVisibility 管，这里只接事件（onClearFinished 在外部）。 */
    setClearVisible(visible) {
      clearButton.hidden = !visible;
    },

    /** 把焦点送回某一行的"重试"按钮（重试失败后键盘用户不至于丢失位置）。 */
    focusItem(id) {
      const entry = rows.get(id);
      if (entry && !entry.retry.hidden) entry.retry.focus();
      else if (entry) entry.remove.focus();
    },

    /** 测试/验收用：当前队列的只读快照。 */
    snapshot() {
      return order.map(id => ({ ...items.get(id) }));
    },
  };
}

export default { createUploadQueue };
