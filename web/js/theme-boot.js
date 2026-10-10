/* ==========================================================================
   AIbum · 防 FOUC 主题引导脚本  web/js/theme-boot.js
   --------------------------------------------------------------------------
   为什么必须是"外部同步脚本"，而不能是内联 <script>：

     app/main.py:180 对所有响应（**包括 /static/\***）下发
       Content-Security-Policy: default-src 'self'; img-src 'self' blob:;
         style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'
     这里既没有 'unsafe-inline'，也没有 'unsafe-hashes' —— 内联 <script> 会被浏览器
     直接拒绝执行（实测 CDP 日志：Executing inline script violates ... 'script-src 'self''），
     于是 data-theme 永远不会被写入，?theme=dark 与 ?theme=light 的截图逐像素相同。
     把同一段逻辑放进外部文件、用普通 <script src> 引入，就落在 'self' 之内，合法且照旧同步执行。

   用法（必须放在 <head> 里、样式表之前；**不要** defer / async / type=module）：

     <script src="/static/js/theme-boot.js"></script>

   普通（非 module）外部脚本按 HTML 解析顺序同步执行：解析到 <body> 之前就已经跑完，
   所以"先写 data-theme 再渲染首个像素"的性质与原来的内联片段完全一致，不会闪一下浅色再翻深色。

   与 web/js/theme.js 的契约（两处必须一致，改一处就要改两处）：
     THEME_KEY     = 'aibum-theme'
     THEME_CHOICES = ['auto', 'light', 'warm', 'forest', 'dark', 'midnight']
     写出的两个属性：
       data-theme  = 解析后的主题（light / warm / forest / dark / midnight），tokens.css 认它
       data-choice = 用户的选择（可能是 auto），UI 用它高亮当前档位

   比 theme.js 的 INLINE_THEME_SCRIPT 多做一件事：支持 ?theme=<档位> 覆盖。
   设计系统自查页（web/styleguide.html）靠它逐档截图验收；theme.js 的 applyTheme 只认
   localStorage，给不了这种"一次性指定"的能力。query 参数不写回 localStorage。

   本文件是 ES5、无 import、无依赖、无内联事件，也不使用 eval / new Function。
   ========================================================================== */
(function () {
  /** localStorage key：与 theme.js 的 THEME_KEY 相同，固定不得改名。 */
  var KEY = 'aibum-theme';
  /** 六档主题：与 theme.js 的 THEME_CHOICES 逐项相同（顺序也一致）。 */
  var CHOICES = ['auto', 'light', 'warm', 'forest', 'dark', 'midnight'];

  /* ?theme=xxx 覆盖（非法值忽略）。URLSearchParams 不可用时静默降级。 */
  var override = null;
  try {
    override = new URLSearchParams(window.location.search).get('theme');
  } catch (e) {
    override = null;
  }

  var stored = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch (e) {
    stored = null;                       /* 隐私模式等场景读不到就算了 */
  }

  var choice = CHOICES.indexOf(override) >= 0 ? override
    : (CHOICES.indexOf(stored) >= 0 ? stored : 'auto');

  var dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var theme = choice === 'auto' ? (dark ? 'dark' : 'light') : choice;

  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-choice', choice);
})();
