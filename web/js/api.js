/* ==========================================================================
   AIbum · 唯一请求出口  web/js/api.js
   --------------------------------------------------------------------------
   阶段 1（新前端骨架）。规矩：**全前端只有这一个文件允许出现 fetch / XHR**，
   视图、组件、store、router、theme 一律通过这里发请求。

   对照 docs/前端-行为清单.md 第 0 节：
     0.1 请求统一出口 → 所有路径加 /api 前缀，强制注入 X-AIbum-Request: 1（含 GET）
     0.2 错误消息提取 → errorMessage(detail, status)（纯函数，可单测）
     0.3 401 处理     → 已登录却收到 401，立刻切回登录态（store.handleUnauthorized）
     0.4 过期响应丢弃 → 发出前记 accountVersion，响应回来若已变则报"账户状态已更新，请重试"

   另有（阶段 2/4 用）：XHR 上传（要进度回调，fetch 拿不到上传进度）、
   筛选参数构造（行为清单 2.3：先删 6 个键再重设、空值不发、tags 重复 append）。

   本文件不碰 document / window，可被 node 直接 import 做单测。
   ========================================================================== */

import {
  FILTER_KEYS,
  MESSAGE_ACCOUNT_CHANGED,
  getAccountVersion,
  getState,
  handleUnauthorized,
} from './store.js';

/** API 前缀。行为清单 0.1：所有请求都走 /api。 */
export const API_BASE = '/api';

/** 写请求安全头（后端对非 GET 校验它）。 */
export const REQUEST_HEADER = 'X-AIbum-Request';
export const REQUEST_HEADER_VALUE = '1';

/** 账户切换导致在途请求作废时的提示，再导出一份方便 api 的调用方比对。 */
export { MESSAGE_ACCOUNT_CHANGED };

/** 带 HTTP 状态与原始 detail 的错误对象。 */
export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status ?? 0;
    this.detail = options.detail;
    this.url = options.url || '';
    /** true = 因为账户切换被丢弃（不是网络/业务错误）。 */
    this.stale = Boolean(options.stale);
  }
}

/* --------------------------------------------------------------------------
   0.2 错误消息提取 —— 纯函数，无副作用，node 单测直接喂三种输入
   -------------------------------------------------------------------------- */

/**
 * 把后端的 detail 归一成一句中文提示。
 *   detail 是字符串        → 直接用
 *   detail 是数组（422）    → 取每项 .msg，用中文分号「；」连接
 *   都没有 / 空             → 请求失败 (状态码)
 * @param {unknown} detail 响应体里的 detail 字段
 * @param {number} status HTTP 状态码
 * @returns {string}
 */
export function errorMessage(detail, status) {
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail)) {
    const joined = detail
      .map(item => (item && typeof item === 'object' && item.msg ? String(item.msg) : ''))
      .filter(Boolean)
      .join('；');
    if (joined) return joined;
  }
  return `请求失败 (${status})`;
}

/** 读取响应体里的 detail；响应不是 JSON 时返回 undefined（0.2 的"都没有"分支）。 */
async function readDetail(response) {
  try {
    const payload = await response.json();
    return payload && typeof payload === 'object' ? payload.detail : undefined;
  } catch {
    return undefined;
  }
}

/* --------------------------------------------------------------------------
   请求头与 URL
   -------------------------------------------------------------------------- */

/** 每个请求都带上安全头，调用方可以通过 options.headers 追加（但不能删掉它）。 */
function buildHeaders(extra) {
  return { [REQUEST_HEADER]: REQUEST_HEADER_VALUE, ...(extra || {}) };
}

function buildUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return path.startsWith(API_BASE) ? path : API_BASE + (path.startsWith('/') ? path : '/' + path);
}

/* --------------------------------------------------------------------------
   核心 request
   -------------------------------------------------------------------------- */

/**
 * 发一个请求。
 * @param {string} path 例如 '/auth/me'（会自动加 /api）
 * @param {{method?: string, json?: any, form?: FormData, body?: BodyInit,
 *          headers?: Record<string,string>, signal?: AbortSignal,
 *          expect?: 'json'|'response'}} [options]
 * @returns {Promise<any>}
 */
export async function request(path, options = {}) {
  const { method = 'GET', json, form, body, headers, signal, expect = 'json' } = options;
  const url = buildUrl(path);
  const version = getAccountVersion();   // 0.4：发出前记下账户版本

  const init = { method, headers: buildHeaders(headers), credentials: 'same-origin' };
  if (signal) init.signal = signal;
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (form !== undefined) {
    init.body = form;                       // FormData：不要手写 Content-Type，浏览器要带 boundary
  } else if (body !== undefined) {
    init.body = body;
  }

  const response = await fetch(url, init);

  // 0.4：账户在等待期间变了（登录/登出/切回登录态）→ 结果作废
  if (version !== getAccountVersion()) {
    throw new ApiError(MESSAGE_ACCOUNT_CHANGED, { url, stale: true });
  }

  if (!response.ok) {
    const detail = await readDetail(response);
    // 0.3：已登录却收到 401 → 立刻切回登录态
    if (response.status === 401 && getState().user) handleUnauthorized();
    throw new ApiError(errorMessage(detail, response.status), { status: response.status, detail, url });
  }

  if (expect === 'response') return response;
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/* 语义化快捷方法。 */

export const get = (path, options) => request(path, { ...options, method: 'GET' });
export const post = (path, json, options) => request(path, { ...options, method: 'POST', json });
export const patch = (path, json, options) => request(path, { ...options, method: 'PATCH', json });
export const del = (path, options) => request(path, { ...options, method: 'DELETE' });
/** multipart（/api/search 这种）。 */
export const postForm = (path, form, options) => request(path, { ...options, method: 'POST', form });

/* --------------------------------------------------------------------------
   XHR 上传（行为清单 4.1：必须用 XHR，因为要进度回调）
   -------------------------------------------------------------------------- */

/**
 * 带进度回调的上传。与 request 同样的安全头、401 与账户版本语义。
 * @param {string} path
 * @param {FormData} form
 * @param {{onProgress?: (ratio: number) => void, signal?: AbortSignal}} [options]
 * @returns {Promise<any>}
 */
export function upload(path, form, options = {}) {
  const { onProgress, signal } = options;
  const url = buildUrl(path);
  const version = getAccountVersion();

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader(REQUEST_HEADER, REQUEST_HEADER_VALUE);

    if (xhr.upload && typeof onProgress === 'function') {
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
    }

    /** 统一的收尾：先判账户版本，再判 HTTP 状态。 */
    const settle = () => {
      if (version !== getAccountVersion()) {
        reject(new ApiError(MESSAGE_ACCOUNT_CHANGED, { url, stale: true }));
        return false;
      }
      return true;
    };

    xhr.onload = () => {
      if (!settle()) return;
      let payload = null;
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        payload = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }
      if (xhr.status === 401 && getState().user) handleUnauthorized();
      const detail = payload ? payload.detail : undefined;
      reject(new ApiError(errorMessage(detail, xhr.status), { status: xhr.status, detail, url }));
    };
    xhr.onerror = () => {
      if (!settle()) return;
      reject(new ApiError('网络错误，请检查连接后重试', { url }));
    };
    xhr.onabort = () => {
      if (!settle()) return;
      reject(new ApiError('请求已取消', { url }));
    };

    if (signal) {
      if (signal.aborted) {
        reject(new ApiError('请求已取消', { url }));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(form);
  });
}

/* --------------------------------------------------------------------------
   筛选参数构造（行为清单 2.3）：先删这 6 个键再重新设置，空值不发送，tags 重复 append
   -------------------------------------------------------------------------- */

/**
 * 把筛选条件写进 URLSearchParams / FormData（两者接口兼容：set/delete/append）。
 * 传入的 target 上原有的这 6 个键会被清掉，避免上一次查询的残留。
 * @param {{set(k: string, v: string): any, delete(k: string): any, append(k: string, v: string): any}} target
 * @param {Record<string, any>} filters
 */
export function appendFilters(target, filters) {
  for (const key of FILTER_KEYS) target.delete(key);
  const scalar = {
    album_id: filters.album_id,
    location: typeof filters.location === 'string' ? filters.location.trim() : filters.location,
    start: filters.start,
    end: filters.end,
    favorite: filters.favorite ? 'true' : '',
  };
  for (const [key, value] of Object.entries(scalar)) {
    if (value) target.set(key, value);
  }
  for (const tag of filters.tags || []) target.append('tags', tag);
  return target;
}

/**
 * 六个筛选维度 + 排序拼成一个查询串（列表请求用）。
 * 日期校验（开始 > 结束）在 2.4，属于筛选视图的职责，这里只负责拼参数。
 */
export function filterParams(filters) {
  const params = new URLSearchParams({ page: String(filters.page || 1), order: filters.order || 'newest' });
  appendFilters(params, filters);
  return params;
}

/** 汇总导出，方便 `import { api } from './api.js'` 一次性拿到全部出口。 */
export const api = {
  request, get, post, patch, del, postForm, upload,
  errorMessage, appendFilters, filterParams,
  API_BASE, REQUEST_HEADER, REQUEST_HEADER_VALUE, ApiError,
};

export default api;
