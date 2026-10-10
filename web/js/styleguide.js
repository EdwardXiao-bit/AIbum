/* ==========================================================================
   AIbum · 设计系统自查页的交互脚本  web/js/styleguide.js
   --------------------------------------------------------------------------
   原先内联在 web/styleguide.html 底部，被 app/main.py:180 的 CSP
   （script-src 'self'，无 unsafe-inline）拒绝执行 —— 实测报错：
     "Executing inline script violates ... 'script-src 'self''"
   于是 #cur-theme 一直是空的、6 档卡片的"底/强调"图例一直是"—"、主题按钮点了没反应。
   这里是与原内联块**逐字相同**的代码，只换了存放位置。

   主题相关的读取逻辑与 web/js/theme-boot.js / web/js/theme.js 共用同一份契约
   （localStorage key = aibum-theme，六档 = auto/light/warm/forest/dark/midnight）。
   全程 addEventListener，无 eval / new Function / javascript: URL / 内联事件属性。
   ========================================================================== */
(function () {
  var KEY = 'aibum-theme';
  var ok = ['auto','light','warm','forest','dark','midnight'];
  var label = { auto:'跟随系统', light:'明亮', warm:'暖阳', forest:'森绿', dark:'暗房', midnight:'深蓝' };
  var root = document.documentElement;

  function resolve(c) { return c === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : c; }
  function apply(c) {
    root.setAttribute('data-theme', resolve(c));
    root.setAttribute('data-choice', c);
    document.getElementById('cur-theme').textContent = '当前：' + label[c];
    document.querySelectorAll('#themer button').forEach(function (b) { b.classList.toggle('on', b.dataset.set === c); });
  }

  var param = new URLSearchParams(location.search).get('theme');
  var choice = ok.indexOf(param) >= 0 ? param : (localStorage.getItem(KEY) || 'auto');
  apply(choice);

  /* 6 档主题并排那几张卡片底部的"底 #xxx · 强调 #xxx"不写死：
     直接读卡片自己 data-theme 上的真实令牌值。令牌改过一轮（暖阳档强调色为了
     白字达标压深了），写死的说明就留在了旧色值上——所以改成运行时读。 */
  document.querySelectorAll('[data-token-legend]').forEach(function (el) {
    var card = el.closest('[data-theme]');
    if (!card) return;
    var cs = getComputedStyle(card);
    var b = el.querySelectorAll('b');
    if (b.length >= 2) {
      b[0].textContent = cs.getPropertyValue('--bg').trim();
      b[1].textContent = cs.getPropertyValue('--accent').trim();
    }
  });

  var btn = document.getElementById('theme-btn'), panel = document.getElementById('themer');
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    var open = panel.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  });
  panel.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-set]');
    if (!b) return;
    e.stopPropagation();
    localStorage.setItem(KEY, b.dataset.set);
    apply(b.dataset.set);
    panel.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('click', function () { panel.classList.remove('open'); });

  // 开关 / 分段控件 / 芯片 / 选中框 的本地状态切换（纯演示，不发请求）
  document.querySelectorAll('.switch').forEach(function (s) {
    s.addEventListener('click', function () { if (!s.disabled && s.getAttribute('aria-busy') !== 'true') s.setAttribute('aria-checked', s.getAttribute('aria-checked') !== 'true'); });
  });
  document.querySelectorAll('.seg').forEach(function (seg) {
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    });
  });
  document.querySelectorAll('.chip, .taglist-item, .photo__sel').forEach(function (c) {
    c.addEventListener('click', function () {
      if (c.disabled || c.getAttribute('aria-disabled') === 'true' || c.getAttribute('aria-busy') === 'true') return;
      c.setAttribute('aria-pressed', String(c.getAttribute('aria-pressed') !== 'true'));
    });
  });

  // 下拉菜单：点触发按钮开关；点条目选中；Esc 关闭
  document.querySelectorAll('.menu__wrap').forEach(function (wrap) {
    var trigger = wrap.querySelector('[aria-haspopup="menu"]');
    var menu = wrap.querySelector('.menu');
    if (!trigger || !menu) return;
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = trigger.getAttribute('aria-expanded') === 'true';
      closeAllMenus();
      trigger.setAttribute('aria-expanded', String(!open));
      menu.setAttribute('data-open', String(!open));
    });
    menu.addEventListener('click', function (e) {
      var item = e.target.closest('.menu__item');
      if (!item || item.disabled || item.getAttribute('aria-busy') === 'true') return;
      if (item.getAttribute('role') === 'menuitemradio') {
        menu.querySelectorAll('[role="menuitemradio"]').forEach(function (x) { x.setAttribute('aria-checked', String(x === item)); });
      }
      closeAllMenus();
    });
  });
  function closeAllMenus() {
    document.querySelectorAll('.menu').forEach(function (m) { m.removeAttribute('data-open'); });
    document.querySelectorAll('[aria-haspopup="menu"]').forEach(function (t) { t.setAttribute('aria-expanded', 'false'); });
  }
  document.addEventListener('click', closeAllMenus);

  // 日历开关
  document.querySelectorAll('[data-toggle-cal]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var pop = b.parentElement.querySelector('.popover');
      if (pop) pop.toggleAttribute('data-open', !pop.hasAttribute('data-open'));
    });
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest('.datepicker')) return;
    document.querySelectorAll('.datepicker .popover').forEach(function (p) { p.removeAttribute('data-open'); });
  });

  // 浮层
  var scrim = document.getElementById('scrim'), dialog = document.getElementById('dialog'), drawer = document.getElementById('drawer');
  function closeAll() { dialog.hidden = true; drawer.setAttribute('data-open', 'false'); scrim.hidden = true; }
  function openDialog() {
    scrim.hidden = false;
    dialog.hidden = false;
    var f = dialog.querySelector('input');
    if (f) f.focus();
  }
  function openDrawer() { scrim.hidden = false; drawer.setAttribute('data-open', 'true'); }
  document.getElementById('open-dialog').addEventListener('click', openDialog);
  document.getElementById('open-drawer').addEventListener('click', openDrawer);
  document.getElementById('open-sheet').addEventListener('click', openDrawer);
  document.getElementById('open-sheet-2').addEventListener('click', openDrawer);
  scrim.addEventListener('click', closeAll);
  document.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', closeAll); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    closeAll();
    closeAllMenus();
  });
})();
