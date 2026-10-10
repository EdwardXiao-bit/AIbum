/* ==========================================================================
   AIbum · 照片卡  web/js/components/photo-card.js
   --------------------------------------------------------------------------
   行为清单对应的条目：
     2.12 卡片信息 —— 缩略图（lazy）· 名称（收藏时前缀 `★ `）· 副标题 · **最多 3 个标签**
     5.1  单卡选择 —— 复选卡；aria-label = `选择 文件名`
     6.10 点卡片封面 → 打开详情（本卡只发起 #/photo/:id，详情视图归 F5）

   副标题规则（含 Q3 决策，**与旧版 2.13 不同**）：
     - 浏览模式：`拍摄 2026-08-13 · 已分析`（有拍摄时间就显示"拍摄"，否则"加入"；
       连字符用 ` · `，与 legacy 的 `日期 · 状态名` 同一形状）
     - 检索模式：**不出现任何小数**，只给"结果集内的相对档位"。依据在
       docs/前端重构计划.md 决策台账 Q3：实测文本检索全部分数落在 0.249~0.411
       （跨度 0.16），无关查询「汽车轮胎」最高 0.308 而最佳匹配「海边日落」最高 0.324——
       两者只差 0.016。显示 0.324 等于用数字误导用户，所以只保留"名次档位"。

   档位是**纯相对**的（只按相关度排序后的名次），不是后端分数换算：
     第 1 名 → 最匹配；其余 → 较匹配
   ========================================================================== */

import { h } from './dom.js';
import { statusName } from '../store.js';

/** 相对档位的文案（Q3：只给档位，不给原始分数）。 */
export const TIER_LABELS = { top: '最匹配', rest: '较匹配' };

/** 卡片里最多显示几个标签（行为清单 2.12）。 */
export const MAX_CARD_TAGS = 3;

/**
 * 名次 → 档位。
 * @param {number} rank 1 起的名次
 * @returns {'top'|'rest'}
 */
export function tierOf(rank) {
  return rank <= 1 ? 'top' : 'rest';
}

/**
 * 浏览模式的副标题：`拍摄 2026-08-13 · 已分析`。
 * 取 taken_at 优先、否则 created_at（行为清单 2.13 / legacy L119）。
 */
export function browseSubtitle(photo) {
  const stamp = photo.taken_at || photo.created_at || '';
  const date = String(stamp).slice(0, 10);
  const prefix = photo.taken_at ? '拍摄' : '加入';
  return `${prefix} ${date} · ${statusName(photo.status)}`;
}

/**
 * 建一张照片卡。
 * @param {object} photo 后端 /api/photos 或 /api/search 返回的条目
 * @param {{
 *   mode?: 'browse'|'search'|'similar',
 *   rank?: number,
 *   selected?: boolean,
 *   onToggleSelect?: (id: string, checked: boolean) => void,
 *   onOpen?: (id: string) => void,
 *   document?: Document,
 * }} [options]
 * @returns {HTMLElement}
 */
export function createPhotoCard(photo, options = {}) {
  const mode = options.mode || 'browse';
  const ranked = mode === 'search' || mode === 'similar';
  const document_ = options.document || document;

  /* ---- 5.1 选择框（自己画，不用 <input type=checkbox>：设计系统的 .photo__sel 是按钮形态） ---- */
  const select = h('button', {
    type: 'button',
    className: 'photo__sel',
    'aria-label': `选择 ${photo.name}`,
    'aria-pressed': options.selected ? 'true' : 'false',
    'data-photo': photo.id,
    'data-role': 'select',
    title: '选择这张照片',
    onclick: event => {
      event.stopPropagation();
      const next = select.getAttribute('aria-pressed') !== 'true';
      select.setAttribute('aria-pressed', next ? 'true' : 'false');
      if (typeof options.onToggleSelect === 'function') options.onToggleSelect(photo.id, next);
    },
  }, [h('span', { className: 'photo__sel-mark', 'aria-hidden': 'true', text: '✓' })]);

  /* ---- 封面：点击进详情（6.10 的入口；详情视图归 F5） ---- */
  const image = h('img', {
    className: 'photo__img',
    src: photo.thumbnail_url,
    alt: photo.name,
    loading: 'lazy',
    decoding: 'async',
    'data-role': 'thumb',
    onload: () => { image.dataset.ready = 'true'; },
    onerror: () => { image.dataset.ready = 'true'; image.dataset.failed = 'true'; },
  });
  image.dataset.ready = 'false';

  const open = h('button', {
    type: 'button',
    className: 'photo__open',
    'aria-label': `查看 ${photo.name}`,
    onclick: () => { if (typeof options.onOpen === 'function') options.onOpen(photo.id); },
  }, [image]);

  /* ---- 2.12 标题（收藏前缀 ★）+ 副标题 + 最多 3 个标签 ---- */
  const name = h('p', { className: 'photo__name', title: photo.name, text: (photo.favorite ? '★ ' : '') + photo.name });

  const ranked_ = ranked && Number.isFinite(options.rank) ? options.rank : null;
  const subtitle = h('p', {
    className: 'photo__sub',
    'data-role': 'subtitle',
    'data-mode': mode,
    text: ranked_
      ? TIER_LABELS[tierOf(ranked_)]
      : browseSubtitle(photo),
  });
  if (ranked_) {
    // 名次与档位留给验收脚本读（DOM 里没有分数，页面上也没有小数）
    subtitle.dataset.rank = String(ranked_);
    subtitle.dataset.tier = tierOf(ranked_);
  }

  const tags = h('div', { className: 'photo__tags', 'data-role': 'tags' },
    (photo.tags || []).slice(0, MAX_CARD_TAGS).map(tag => h('span', {
      text: tag.name,
      'data-auto': tag.source === 'auto' ? 'true' : false,
      title: tag.source === 'auto' ? `AI 标签：${tag.name}` : `标签：${tag.name}`,
    })));

  const caption = h('div', { className: 'photo__caption' }, [name, subtitle]);
  const tagRow = h('div', { className: 'photo__tagrow' }, [tags]);

  const card = h('article', {
    className: 'photo',
    'data-photo': photo.id,
    'data-mode': mode,
    'data-status': photo.status,
    'data-tier': ranked_ ? tierOf(ranked_) : false,
    'data-rank': ranked_ ? String(ranked_) : false,
  }, [select, open, caption, tagRow]);

  if (photo.status === 'failed') card.classList.add('photo--error');
  if (options.selected) card.dataset.selected = 'true';

  /* 收藏态徽章（有才显示，避免每张卡都挂一个空角标） */
  if (photo.favorite) {
    card.append(h('span', { className: 'badge badge--stat photo__stat', text: '★ 已收藏' }));
  }
  /* 分析状态角标：只有非 ready 才打扰（ready 是常态，副标题里已写了"已分析"） */
  if (photo.status && photo.status !== 'ready') {
    const tone = photo.status === 'failed' ? 'danger' : 'stat';
    card.append(h('span', {
      className: `badge badge--${tone} photo__stat`,
      'data-role': 'status',
      text: statusName(photo.status),
    }));
  }

  return card;
}

export default { createPhotoCard, browseSubtitle, tierOf, TIER_LABELS, MAX_CARD_TAGS };
