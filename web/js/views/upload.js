/* ==========================================================================
   AIbum · 上传批次引擎  web/js/views/upload.js
   --------------------------------------------------------------------------
   阶段 3.4「上传体验」。逐条对照 docs/前端-行为清单.md 第 4 节：

     4.1  上传请求 —— `POST /api/photos` multipart `{file, album_id?}`，**必须走 XHR**
                     （要上传进度）。落在 api.upload()（唯一请求出口，全前端只有
                      api.js 出现 XHR / fetch）。本文件不许自己 new XMLHttpRequest。
     4.2  逐张串行 + 总体进度 `(i + 分数) / 总数 * 100`
     4.3  目标相册 —— ❓Q2：旧版隐式沿用"相册筛选值"。**本卡按默认值实现为
                     "上传前显式选择"，默认「未归入相册」**（见 docs/PROJECT.md 的 Q2）。
                     参数名与旧版一致：非空才发 `album_id`。
     4.4  单张大小上限 > 20 MiB 报错"超过 20 MiB" —— **逐个检查**，
                     超限的那一张标记失败并跳过，同批其它文件照常上传（不是整批拒绝）。
     4.5  账户切换中断 —— 每张开始前比对 `state.user.id !== owner` 就停；
                     并且上传响应自带账户版本校验（api.upload 的 stale 分支），
                     账户在传输途中变了也拿不到结果，**完成通知不再发出**。
     4.6  重复检测 —— 响应 `duplicate` 为真则计入重复数（该张不新增照片）。
     4.7  完成通知 —— `完成 ok/总数 张，重复 N 张。` + **最多 3 条**错误明细
     4.8  上传期间锁定 —— 上传输入框、登出按钮、账户安全按钮禁用
     4.9  完成后刷新 —— 刷新相册/标签选项 + 重载列表 + 更新健康状态
     4.10 进度文案 —— `上传 i/总数：文件名`

   本卡新增（旧版没有，计划 §4.1 / 清单 §13）：
     · 全页拖放：拖文件进窗口 → **整页高亮**（.dropzone），落到任意位置都算上传
     · 上传队列：每张一行，状态 + 失败原因 + **单独重试**
     · 上传前显式选相册（Q2 的默认实现）

   本文件是**纯逻辑**（除了一个自己建的 DOM 浮层）：不 import 任何视图，
   拿到的 `queue` 是一个"事件接收器"（见 components/upload-queue.js），
   于是它可以被 node 直接 import 做单测 —— 与 web/js/next-demo.js 的用法一致。

   CSP（行为清单 §0A）：没有内联脚本 / 内联样式 / style 属性 / 内联事件；
   动态宽度只走 CSSOM（el.style.setProperty）。
   ========================================================================== */

import { ApiError, api } from '../api.js';
import * as store from '../store.js';
import { h, setText } from '../components/dom.js';
import { createSelectMenu } from '../components/select-menu.js';

/** 单张图片上限（行为清单 4.4 / §11）。store / library 里同名常量的**唯一出处**是 store.js。 */
export const MAX_UPLOAD_BYTES = store.MAX_UPLOAD_BYTES;

/**
 * 单张大小上限的报错文案（行为清单 4.4 逐字）。
 * 后端在超限时回的是"单张图片不得超过 20 MiB"（app/main.py:115），前端要报的是
 * 清单里写死的那句，所以**必须在前端先拦**（顺带省掉一次 21 MiB 的上传流量）。
 */
export const OVERSIZE_MESSAGE = '超过 20 MiB';

/** 完成通知里最多列几条错误明细（行为清单 4.7）。 */
export const MAX_ERROR_LINES = 3;

/** 队列项 id 前缀（验收脚本靠它认出"这是上传队列造出来的 id"）。 */
const ID_PREFIX = 'upload';

let idSeq = 0;

/** 造一个队列项 id（同一页面内唯一即可；不依赖 crypto，便于 node 单测）。 */
export function nextItemId() {
  idSeq += 1;
  return `${ID_PREFIX}-${idSeq}`;
}

/* --------------------------------------------------------------------------
   纯函数：逐个校验 + 完成通知文案（都可单测）
   -------------------------------------------------------------------------- */

/**
 * 4.4：逐个检查大小。**只判断这一张**，不因为一张超限就拒绝整批。
 * @param {File|{name?: string, size?: number}} file
 * @returns {string|null} 错误文案或 null（通过）
 */
export function validateFile(file) {
  if (!file) return '请选择要上传的照片';
  if (!file.size) return '文件为空，无法上传';
  if (file.size > MAX_UPLOAD_BYTES) return OVERSIZE_MESSAGE;
  return null;
}

/**
 * 4.7 完成通知文案。
 *   `完成 ok/总数 张，重复 N 张。` + 最多 3 条错误明细（用 `；` 连接，逐字沿用旧版）
 * 额外一句：被跳过（超限等本地校验没过）的张数，否则用户会把"没传上去"当成"传成功了"。
 * @param {{ok: number, total: number, duplicate: number, errors?: string[], skipped?: number}} result
 */
export function completionNotice(result) {
  const { ok, total, duplicate } = result;
  const errors = result.errors || [];
  const skipped = result.skipped || 0;
  const tail = errors.slice(0, MAX_ERROR_LINES).join('；');
  const hidden = errors.length > MAX_ERROR_LINES ? `（另有 ${errors.length - MAX_ERROR_LINES} 条错误未列出）` : '';
  const skippedNote = skipped > 0 ? `，跳过 ${skipped} 张` : '';
  return `完成 ${ok}/${total} 张，重复 ${duplicate} 张${skippedNote}。${tail}${hidden}`;
}

/* --------------------------------------------------------------------------
   上传前的显式选相册浮层（Q2 的默认实现）
   -------------------------------------------------------------------------- */

/**
 * 建"上传到哪个相册"对话框的内容（复用外壳的共享遮罩：components/modal.js）。
 * 返回 {form, select, summary, files, setFiles}；表单 submit = 确认上传。
 *
 * `select` 是 **components/select-menu.js 的下拉选择**（设计系统的 .menu 形态，
 * 与筛选栏/批量移动/详情所属相册同一套控件），不是原生 `<select>`：
 * 用户反馈的"三套下拉风格不统一"里，这一处也是原生弹层。
 * 它保留了 `getValue()/setValue()/setOptions()`，调用方（library.js）照旧填相册列表。
 * @param {{albums: Array<{id:string,name:string,count?:number}>, document?: Document,
 *          onConfirm: (albumId: string|null, files: File[]) => any, onCancel?: () => any}} options
 */
export function createUploadDialog(options) {
  const document_ = options.document || document;
  const albums = options.albums || [];

  const summary = h('p', { className: 'upload-dialog__summary', 'data-role': 'upload-dialog-summary' });
  const sizeNote = h('p', { className: 'code-hint', 'data-role': 'upload-dialog-hint' });
  const select = createSelectMenu({
    id: 'upload-album',
    dataRole: 'upload-target-album',
    labelledBy: 'upload-album-label',
    options: [
      { value: '', label: '未归入相册' },
      ...albums.map(album => ({
        value: album.id,
        label: `${album.name} (${album.count !== undefined ? album.count : 0})`,
      })),
    ],
    document: document_,
  });
  const submit = h('button', { className: 'btn btn--primary', type: 'submit', 'data-role': 'upload-confirm', text: '开始上传' });
  const form = h('form', { className: 'stack', id: 'upload-form', 'data-role': 'upload-form' }, [
    summary,
    h('div', { className: 'field' }, [
      h('span', { className: 'label', id: 'upload-album-label', text: '归入相册' }),
      select.element,
    ]),
    sizeNote,
    h('div', { className: 'dialog__foot' }, [
      submit,
      h('button', { className: 'btn btn--ghost', type: 'button', 'data-close': '', text: '取消' }),
    ]),
  ]);

  let files = [];

  function setFiles(next) {
    files = [...(next || [])];
    const names = files.map(file => file.name).filter(Boolean);
    setText(summary, files.length === 1
      ? `将上传 1 张照片：${names[0] || '（未命名）'}`
      : `将上传 ${files.length} 张照片：${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${names.length} 张` : ''}`);
    const oversize = files.filter(file => file.size > MAX_UPLOAD_BYTES);
    sizeNote.textContent = oversize.length
      ? `其中 ${oversize.length} 张超过 20 MiB（${oversize.map(file => file.name).join('、')}），会被跳过并单独报错。`
      : '单张不超过 20 MiB；同一张重复上传会被识别为重复，不会新增照片。';
    sizeNote.dataset.state = oversize.length ? 'warn' : 'ok';
    submit.disabled = files.length === 0;
    return files;
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!files.length) return;
    const albumId = select.getValue() || null;
    options.onConfirm(albumId, files);
  });

  setFiles([]);
  return { form, select, summary, sizeNote, setFiles, get files() { return files; } };
}

/* --------------------------------------------------------------------------
   上传批次引擎
   -------------------------------------------------------------------------- */

/**
 * 建一个上传器。
 * @param {{
 *   queue?: object,                 // 队列视图（components/upload-queue.js）——事件接收器
 *   onNotice?: (text: string) => any,   // 完成通知（默认走 store.toast）
 *   onProgress?: (info: object) => any, // 总体进度（附带的观察点，验收探针用）
 *   onStart?: () => any,            // 批次开始（视图用来展开队列面板）
 *   onSettled?: (info: object) => any,  // 批次结束（视图用来刷新列表 / 收起忙碌态）
 *   beforeSend?: (payload: {form: FormData, file: File, item: object, index: number}) => any,
 *                                   // 故障注入点（只在验收脚本里用；抛错 = 这次发送失败）
 *   getUser?: () => object|null,    // 读当前账户（默认读 store）——单测可注入一个可变账户
 *   document?: Document,
 * }} [options]
 */
export function createUploader(options = {}) {
  const queue = options.queue || null;
  const onNotice = options.onNotice || (text => store.toast(text));
  const beforeSend = options.beforeSend || null;
  /** 4.5 的账户来源。做成可注入是因为单测要"在传输途中换账户"，而 store 是只读模块。 */
  const getUser = options.getUser || (() => store.getState().user);

  /** 队列项（本文件的真相；queue 只是它的渲染器）。 */
  const items = [];
  /** 4.5：本批的发起者，循环每轮都要比对它。 */
  let owner = null;
  /** 4.3/Q2：本批的目标相册（null = 未归入相册）。 */
  let album = null;
  /** 队列是否正在推进（4.8 的"上传中"；重试时也会短暂为 true）。 */
  let running = false;
  /** 这一批一共有多少张（4.7 的"总数"；重试不改它）。 */
  let batchTotal = 0;
  /** 已经处理完的张数（含失败；重试会让它继续增长）。 */
  let batchDone = 0;
  /** 4.5：是否因为账户变了提前结束（此时 4.7 的完成通知**不发**）。 */
  let stoppedEarly = false;

  /** 验收探针（只读遥测；不改业务行为）。 */
  const telemetry = {
    /** 真正发出过请求的张数。 */
    attempted: 0,
    /** 成功的张数。 */
    uploaded: 0,
    /** 4.6 的重复张数。 */
    duplicated: 0,
    /** 本地校验就挡下的张数（4.4 的超限走这里）。 */
    skipped: 0,
    /** 错误明细（与 4.7 的列表同源）。 */
    errors: [],
    /** 4.10 的逐张文案流水（旧版只留最后一条，队列能全部留下）。 */
    labelLog: [],
    /** 进度回调实际被触发过的次数与最后比例（4.1"必须 XHR"的实证）。 */
    progressTicks: 0,
    lastProgress: null,
    /** 最近一次完成通知的**逐字**文案。 */
    noticeText: '',
    /** 最近一次完成通知的时间戳（0 = 还没通知过）。 */
    noticeAt: 0,
    /** 结束时账户是否还是发起者（false = 4.5 生效）。 */
    ownerIntact: true,
    /** 有没有因为账户切换而中止。 */
    stoppedEarly: false,
    /** 本批目标相册（null = 未归入相册）。 */
    albumId: null,
  };

  function resetTelemetry() {
    telemetry.attempted = 0;
    telemetry.uploaded = 0;
    telemetry.duplicated = 0;
    telemetry.skipped = 0;
    telemetry.errors = [];
    telemetry.labelLog = [];
    telemetry.progressTicks = 0;
    telemetry.lastProgress = null;
    telemetry.noticeText = '';
    telemetry.noticeAt = 0;
    telemetry.ownerIntact = true;
    telemetry.stoppedEarly = false;
  }

  function currentOwnerId() {
    const user = getUser();
    return user ? user.id : null;
  }

  /** 4.10 的逐张文案 + 4.2 的总体进度，一次改齐（两者永远是同一时刻的数字）。 */
  function reportProgress(indexInBatch, file, fraction) {
    const done = batchDone + fraction;
    const total = batchTotal || items.length || 1;
    const label = `上传 ${indexInBatch + 1}/${batchTotal || items.length}：${file.name}`;
    if (queue) {
      queue.setLabel(label);
      queue.setProgress(done, total);
    }
    if (telemetry.labelLog[telemetry.labelLog.length - 1] !== label) telemetry.labelLog.push(label);
    if (options.onProgress) {
      options.onProgress({ index: indexInBatch, total: batchTotal, done, fraction, label, file: file.name });
    }
  }

  function markDone(item, duplicate) {
    item.state = 'done';
    item.duplicate = Boolean(duplicate);
    item.error = '';
    // 成功即把这张的旧错误从明细里撤掉：否则"重试成功"的完成通知会继续把上一次的失败
    // 报出来（实测踩过：文案成了"完成 1/1 张，重复 0 张。xxx：网络错误…"）。
    const prefix = `${item.name}：`;
    telemetry.errors = telemetry.errors.filter(entry => !String(entry).startsWith(prefix));
    if (queue) queue.setItem(item.id, { state: 'done', duplicate: item.duplicate, error: '' });
  }

  function markFailed(item, message) {
    item.state = 'error';
    item.error = message;
    item.duplicate = false;
    telemetry.errors.push(`${item.name}：${message}`);
    if (queue) queue.setItem(item.id, { state: 'error', error: message, duplicate: false });
  }

  /**
   * 串行跑一批队列项（4.2）。
   * @param {Array<object>} list
   * @param {{indexBase?: number, recordsProgress?: boolean, startIndex?: number}} [opts]
   */
  async function runItems(list, opts = {}) {
    const recordsProgress = opts.recordsProgress !== false;   // false = 单张重试（重复数不重复累加）
    running = true;
    stoppedEarly = false;
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index];
      // 4.5：每张开始前先看账户还在不在（"立即停止"，不是把这批发完再报错）
      if (currentOwnerId() !== owner) {
        stoppedEarly = true;
        break;
      }
      const file = item.file;
      const position = (opts.indexBase || 0) + index;
      reportProgress(position, file, 0);

      // 4.4：逐个检查大小（只跳过这一张）
      const invalid = validateFile(file);
      if (invalid) {
        markFailed(item, invalid);
        telemetry.skipped += 1;
        batchDone += 1;
        if (queue) queue.setProgress(batchDone, batchTotal);
        continue;
      }

      item.state = 'uploading';
      item.fraction = 0;
      if (queue) queue.setItem(item.id, { state: 'uploading', fraction: 0, error: '' });

      const form = new FormData();
      form.set('file', file, file.name);
      // 4.3：非空才发（与旧版 `if (album) form.set(...)` 一致）
      if (album) form.set('album_id', album);

      let result = null;
      try {
        if (beforeSend) beforeSend({ form, file, item, index: position });
        telemetry.attempted += 1;
        result = await api.upload('/photos', form, {
          onProgress: fraction => {
            telemetry.progressTicks += 1;
            telemetry.lastProgress = fraction;
            item.fraction = fraction;
            if (queue) queue.setItem(item.id, { fraction, state: 'uploading' });
            reportProgress(position, file, fraction);
          },
        });
      } catch (error) {
        // 4.5 的第二道闸：api.upload 发现账户版本变了会把结果作废（error.stale）
        if (error && error.stale) {
          stoppedEarly = true;
          item.state = 'queued';
          item.fraction = 0;
          if (queue) queue.setItem(item.id, { state: 'queued', fraction: 0 });
          break;
        }
        const message = error && error.message ? error.message : String(error);
        markFailed(item, message);
        batchDone += 1;
        if (queue) queue.setProgress(batchDone, batchTotal);
        continue;
      }

      // 4.6：duplicate 为真 → 计入重复数（该张不新增照片）。
      // 注意：上传成功的张数**恒**要计入（ok 是事实，不是状态）——否则单张重试成功后
      // 完成通知会写成"完成 0/1 张"，把一次成功的上传报成失败（实测踩过）。
      // 重试与首批的唯一区别只在 duplicate：首批里后端返回 duplicate 是**新信息**，
      // 重试里它只是同一张的老结果，重复数不该再累加一次。
      telemetry.uploaded += 1;
      if (result && result.duplicate) {
        if (recordsProgress) telemetry.duplicated += 1;
        markDone(item, true);
      } else {
        markDone(item, false);
      }
      batchDone += 1;
      if (queue) queue.setProgress(batchDone, batchTotal);
    }
    running = false;
    return { stoppedEarly, done: items.filter(item => item.state !== 'queued' && item.state !== 'uploading').length };
  }

  /** 4.1 + 4.2 + 4.5 + 4.7：新一批。 */
  async function startBatch(files, batchOptions = {}) {
    const list = [...(files || [])];
    if (!list.length) return { started: false };
    if (running) return { started: false, reason: 'busy' };

    owner = currentOwnerId();
    album = batchOptions.albumId || null;
    stoppedEarly = false;
    batchTotal = list.length;
    batchDone = 0;
    items.length = 0;
    resetTelemetry();
    telemetry.albumId = album;
    for (const file of list) {
      items.push({
        id: nextItemId(),
        file,
        name: file.name || '（未命名）',
        size: file.size || 0,
        state: 'queued',
        fraction: 0,
        duplicate: false,
        error: '',
      });
    }
    if (queue) {
      queue.setItems(items.map(item => ({ ...item })));
      queue.setProgress(0, batchTotal);
      queue.setLabel(batchTotal ? `共 ${batchTotal} 张，准备上传…` : '');
    }
    if (options.onStart) options.onStart({ total: batchTotal, albumId: album });
    store.setUploading(true);
    try {
      await runItems(items, { indexBase: 0 });
    } finally {
      store.setUploading(false);
      settle();
    }
    return { started: true, queue: items.map(item => ({ ...item })) };
  }

  /** 4.7/4.9：收尾。账户变了就不发通知（结果已经不是这个用户的）。 */
  function settle() {
    const intact = currentOwnerId() === owner;
    telemetry.ownerIntact = intact;
    telemetry.stoppedEarly = stoppedEarly;
    if (!intact || stoppedEarly) {
      if (options.onSettled) options.onSettled({ skippedNotice: true, stoppedEarly, ownerIntact: intact });
      return { notice: '', ownerIntact: intact };
    }
    const notice = completionNotice({
      ok: telemetry.uploaded,
      total: batchTotal,
      duplicate: telemetry.duplicated,
      errors: telemetry.errors,
      skipped: telemetry.skipped,
    });
    telemetry.noticeText = notice;
    telemetry.noticeAt = Date.now();
    onNotice(notice);
    if (options.onSettled) options.onSettled({ notice, stoppedEarly, ownerIntact: true });
    return { notice, ownerIntact: true };
  }

  /** 失败项单独重试：状态回到排队 → 立刻再走一遍串行流程。 */
  async function retry(id) {
    if (running) return { started: false, reason: 'busy' };
    const item = items.find(entry => entry.id === id);
    if (!item) return { started: false, reason: 'missing' };
    if (!item.file) {
      markFailed(item, '原始文件已不可用，请重新选择后上传');
      return { started: false, reason: 'no-file' };
    }
    item.state = 'queued';
    item.fraction = 0;
    item.error = '';
    if (queue) queue.setItem(id, { state: 'queued', fraction: 0, error: '' });
    // 重试可能与"另一批"交错：把发起者重新钉在当前账户上（用户点的重试就是当前账户的意图）
    owner = currentOwnerId();
    stoppedEarly = false;
    store.setUploading(true);
    try {
      await runItems([item], { recordsProgress: false, indexBase: items.indexOf(item) });
    } finally {
      store.setUploading(false);
      settle();
    }
    return { started: true };
  }

  /** 从队列里移除一项（未在传时才允许；失败项移除 = 放弃重试）。 */
  function remove(id) {
    if (running) return false;
    const index = items.findIndex(entry => entry.id === id);
    if (index < 0) return false;
    items.splice(index, 1);
    if (queue) {
      queue.setItems(items.map(item => ({ ...item })));
      queue.setProgress(batchDone, batchTotal || items.length || 1);
    }
    return true;
  }

  /** 清空"已经处理完"的行，只留下需要重试的失败项。 */
  function clearFinished() {
    if (running) return 0;
    const keep = items.filter(item => item.state === 'error');
    const removed = items.length - keep.length;
    items.length = 0;
    items.push(...keep);
    if (queue) queue.setItems(items.map(item => ({ ...item })));
    return removed;
  }

  return {
    startBatch,
    retry,
    remove,
    clearFinished,
    /** 只读快照（视图/验收脚本用）。 */
    snapshot: () => items.map(item => ({ ...item })),
    get albumId() { return album; },
    get running() { return running; },
    get batchTotal() { return batchTotal; },
    get batchDone() { return batchDone; },
    telemetry,
  };
}

export default {
  createUploader, createUploadDialog, validateFile, completionNotice,
  MAX_UPLOAD_BYTES, OVERSIZE_MESSAGE, MAX_ERROR_LINES,
};
