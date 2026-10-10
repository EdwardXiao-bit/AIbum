/* ==========================================================================
   AIbum · 主题层  web/js/theme.js
   --------------------------------------------------------------------------
   阶段 1（新前端骨架）。六档主题：auto / light / warm / forest / dark / midnight。

   对照 docs/前端-行为清单.md 第 0 节之外的硬性要求（阶段 1 第 9 条）：
     - localStorage key 固定为 'aibum-theme'
     - auto 时跟随 prefers-color-scheme，并监听它的变化（系统切换即时生效）
     - 必须在 <head> 里能内联一小段"渲染前先写 data-theme"的代码防 FOUC
       → 见导出的 INLINE_THEME_SCRIPT 字符串；web/next.html 的 head 里示范了它

   写进 DOM 的两个属性（与 web/styleguide.html 保持一致，tokens.css 认 data-theme）：
     data-theme  = 解析后的主题（light / warm / forest / dark / midnight），CSS 用它取令牌
     data-choice = 用户的选择（可能是 auto），UI 用它高亮当前档位

   本文件不碰 document / window（除非调用 applyTheme/initTheme），可被 node 直接 import。
   ========================================================================== */

/** localStorage key：固定，不得改名（阶段 1 第 9 条）。 */
export const THEME_KEY = 'aibum-theme';

/** 六档主题，顺序即 UI 展示顺序。 */
export const THEME_CHOICES = ['auto', 'light', 'warm', 'forest', 'dark', 'midnight'];

/** 档位中文名（与 tokens.css 的注释一致）。 */
export const THEME_LABELS = {
  auto: '跟随系统',
  light: '明亮',
  warm: '暖阳',
  forest: '森绿',
  dark: '暗房',
  midnight: '深蓝',
};

/** 默认档位。 */
export const DEFAULT_THEME = 'auto';

/** 深色系档位（用于 <meta name="color-scheme"> 之类的判断，可选）。 */
export const DARK_CHOICES = ['dark', 'midnight'];

export function isThemeChoice(value) {
  return THEME_CHOICES.includes(value);
}

/** 读 localStorage；隐私模式等场景下抛错则退回默认值。 */
export function readStored() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function writeStored(choice) {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* 存不下就算了：本次会话内仍然生效 */
  }
}

/** 当前用户选择（非法/缺失 → 'auto'）。 */
export function readChoice() {
  const stored = readStored();
  return isThemeChoice(stored) ? stored : DEFAULT_THEME;
}

/** 系统是否偏好深色。 */
export function prefersDark() {
  return typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : false;
}

/**
 * 档位 → 真正生效的主题。纯函数，node 可单测。
 * @param {string} choice 'auto' 或六档之一
 * @param {boolean} [dark] 系统是否深色（默认现查 matchMedia）
 */
export function resolveTheme(choice, dark = prefersDark()) {
  if (choice === 'auto') return dark ? 'dark' : 'light';
  return isThemeChoice(choice) ? choice : (dark ? 'dark' : 'light');
}

/** 当前生效主题（读 DOM，读不到就现算）。 */
export function currentTheme() {
  if (typeof document !== 'undefined' && document.documentElement) {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr) return attr;
  }
  return resolveTheme(readChoice());
}

/**
 * 应用一档主题。
 * @param {string} [choice] 省略则读 localStorage
 * @param {{persist?: boolean, root?: HTMLElement}} [options]
 * @returns {{choice: string, theme: string}}
 */
export function applyTheme(choice = readChoice(), options = {}) {
  const next = isThemeChoice(choice) ? choice : DEFAULT_THEME;
  const theme = resolveTheme(next);
  const root = options.root || (typeof document !== 'undefined' ? document.documentElement : null);
  if (root) {
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-choice', next);
  }
  if (options.persist) writeStored(next);
  return { choice: next, theme };
}

/** 用户切档：写 localStorage + 应用。 */
export function setTheme(choice) {
  if (!isThemeChoice(choice)) return applyTheme(readChoice());
  return applyTheme(choice, { persist: true });
}

/* --------------------------------------------------------------------------
   auto 跟随系统：监听 prefers-color-scheme 变化
   -------------------------------------------------------------------------- */

let mediaQuery = null;
let mediaHandler = null;
let mediaCallback = null;

/**
 * 监听系统配色变化；choice 为 auto 时即时重解析。
 * 幂等：重复调用只会保留一个底层监听器，但每次传入的 onChange 都会生效。
 * @param {(theme: string, choice: string) => void} [onChange]
 */
export function watchSystem(onChange) {
  if (typeof onChange === 'function') mediaCallback = onChange;
  if (typeof matchMedia !== 'function' || mediaQuery) return mediaQuery;
  mediaQuery = matchMedia('(prefers-color-scheme: dark)');
  mediaHandler = () => {
    // 只有 auto 需要跟随；其它档位重算结果不变，所以直接重放当前选择即可。
    const { choice, theme } = applyTheme(readChoice());
    if (typeof mediaCallback === 'function') mediaCallback(theme, choice);
  };
  if (typeof mediaQuery.addEventListener === 'function') mediaQuery.addEventListener('change', mediaHandler);
  else if (typeof mediaQuery.addListener === 'function') mediaQuery.addListener(mediaHandler);  // 老 Safari
  return mediaQuery;
}

/** 停止监听（幂等）。 */
export function unwatchSystem() {
  if (!mediaQuery || !mediaHandler) return;
  if (typeof mediaQuery.removeEventListener === 'function') mediaQuery.removeEventListener('change', mediaHandler);
  else if (typeof mediaQuery.removeListener === 'function') mediaQuery.removeListener(mediaHandler);
  mediaQuery = null;
  mediaHandler = null;
  mediaCallback = null;
}

/** 启动装配：应用已存选择 + 开始跟随系统。main.js 的 boot() 调用。 */
export function initTheme(options = {}) {
  const applied = applyTheme(readChoice(), options);
  watchSystem(options.onChange);
  return applied;
}

/* --------------------------------------------------------------------------
   防 FOUC 的内联脚本
   --------------------------------------------------------------------------
   这段代码必须在 <head> 里、在样式表之前同步执行，否则会先按浅色渲染一帧再翻成深色。
   它是 ES5、无依赖、不用 import —— 直接复制进 HTML 的 <script> 里。
   web/next.html 的 head 里就是这段（验收脚本会比对两处文本是否一致）。
   -------------------------------------------------------------------------- */
export const INLINE_THEME_SCRIPT = `(function () {
  var KEY = 'aibum-theme';
  var CHOICES = ['auto', 'light', 'warm', 'forest', 'dark', 'midnight'];
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) { stored = null; }
  var choice = CHOICES.indexOf(stored) >= 0 ? stored : 'auto';
  var dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var theme = choice === 'auto' ? (dark ? 'dark' : 'light') : choice;
  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-choice', choice);
})();`;

export default {
  THEME_KEY, THEME_CHOICES, THEME_LABELS, DEFAULT_THEME,
  INLINE_THEME_SCRIPT,
  isThemeChoice, readChoice, resolveTheme, currentTheme,
  applyTheme, setTheme, watchSystem, unwatchSystem, initTheme,
};
