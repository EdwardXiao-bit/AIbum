/* ==========================================================================
   AIbum · 新前端骨架自测页的脚本（ES module）  web/js/next-demo.js
   --------------------------------------------------------------------------
   原先内联在 web/next.html 底部，被 app/main.py:180 的 CSP
   （script-src 'self'，无 unsafe-inline）拒绝执行，自测钩子 window.__aibumReady
   永远不会挂上。这里是与原内联 <script type="module"> **逐字相同**的代码。
   import 一律用 /static/... 绝对路径：后端把 web/ 挂在 /static，
   页面本身被挂在 / 与 /admin 两个路径下，相对路径会解析错位置。
   ========================================================================== */
    // 用 /static/... 绝对路径：后端把 web/ 挂在 /static，页面本身也在 / 与 /admin 两个路径下被返回，
    // 相对路径在 /admin 下会解析错位置。/static 是既有的挂载点（web/index.html 也是这么引的）。
    import * as api from '/static/js/api.js';
    import * as store from '/static/js/store.js';
    import * as router from '/static/js/router.js';
    import * as theme from '/static/js/theme.js';
    import * as main from '/static/js/main.js';

    const $ = id => document.getElementById(id);
    const text = (id, value) => { $(id).textContent = String(value); };

    /* ---------- 只读渲染：订阅 store，把状态灌进自测页 ---------- */

    function renderToast(state) {
      const node = $('t-toast');
      node.hidden = !state.toast.visible;
      node.textContent = state.toast.text;
    }

    function renderCounters(state) {
      text('t-acc', state.accountVersion);
      text('t-res', state.resultVersion);
    }

    function renderSession(state) {
      text('t-portal', state.portal + (state.portal === 'admin' ? '（管理员入口）' : '（用户入口）'));
      text('t-view', state.view);
      text('t-user', state.user ? `${state.user.username}（id=${state.user.id}${state.user.is_admin ? ' · 管理员' : ''}）` : '未登录');
      text('t-path', location.pathname);
      text('t-hash', location.hash || '(空)');
      const route = router.current();
      text('t-route', route.name ? `${route.name} ${JSON.stringify({ ...route.params, ...route.query })}` : `未匹配（known=${route.known}）`);
    }

    function renderTheme() {
      text('t-theme', document.documentElement.getAttribute('data-theme'));
      text('t-choice', document.documentElement.getAttribute('data-choice'));
      text('t-system', theme.prefersDark() ? '深色（prefers-color-scheme: dark）' : '浅色（prefers-color-scheme: light）');
      text('t-stored', String(theme.readStored()));
    }

    /** 记录一次请求，并从响应体里读 mock 服务回显的安全头。 */
    function noteRequest(path, payload) {
      text('t-last', 'GET /api' + path);
      const echo = payload && payload.seenRequestHeader;
      text('t-header', echo === undefined ? '—（后端未回显）' : String(echo));
    }

    store.subscribe((state, reason) => {
      renderSession(state);
      renderCounters(state);
      if (reason === 'toast') renderToast(state);
    }, { immediate: true });

    /* ---------- 主题按钮 ---------- */
    const themeHost = $('t-themes');
    for (const choice of theme.THEME_CHOICES) {
      const button = document.createElement('button');
      button.className = 'btn btn--sm';
      button.dataset.choice = choice;
      button.textContent = `${theme.THEME_LABELS[choice]}（${choice}）`;
      button.addEventListener('click', () => { theme.setTheme(choice); renderTheme(); markThemeButtons(); });
      themeHost.append(button);
    }
    function markThemeButtons() {
      const current = theme.readChoice();
      for (const button of themeHost.querySelectorAll('button')) {
        button.setAttribute('aria-pressed', String(button.dataset.choice === current));
        button.classList.toggle('btn--primary', button.dataset.choice === current);
      }
    }
    // auto 跟随系统：系统切换时重画这一块
    theme.initTheme({ onChange: () => { renderTheme(); markThemeButtons(); } });

    /* ---------- 路由按钮 ---------- */
    for (const button of document.querySelectorAll('[data-hash]')) {
      button.addEventListener('click', () => router.navigate(button.dataset.hash));
    }

    /* ---------- 通知 ---------- */
    let toastTicker = null;
    $('t-toast-btn').addEventListener('click', () => {
      store.toast('骨架自测：这是一条 7 秒后自动消失的通知');
      renderToast(store.getState());
      clearInterval(toastTicker);
      toastTicker = setInterval(() => {
        const state = store.getState();
        if (!state.toast.visible) { text('t-toast-state', '已消失'); clearInterval(toastTicker); return; }
        const left = Math.max(0, (state.toast.at + store.NOTIFY_MS - Date.now()) / 1000);
        text('t-toast-state', `显示中，剩余 ${left.toFixed(1)}s`);
      }, 100);
    });

    /* ---------- 两个计数器演示 ---------- */

    function logDemo(lines) {
      $('t-demo-log').textContent = lines.join('\n');
    }

    // 0.4：请求在途时账户切换 → 结果作废并报"账户状态已更新，请重试"
    async function demoAccountVersion() {
      logDemo(['运行中…']);
      const pending = api.get('/photos?page=1&delay=600')
        .then(() => '请求成功（不该发生：账户已切换）', error => error.message);
      const before = store.getState().accountVersion;
      store.enterWorkspace({ id: 7, username: 'switch-demo' });   // 模拟账户切换
      const after = store.getState().accountVersion;
      const message = await pending;
      logDemo([
        `accountVersion：${before} → ${after}`,
        `在途请求结论：${message}`,
        message === store.MESSAGE_ACCOUNT_CHANGED ? '✅ 符合预期' : '❌ 与预期不符',
      ]);
    }

    // 0.5：慢请求后到 → token 已过期，不得覆盖新结果
    async function demoResultVersion() {
      logDemo(['运行中…']);
      const lines = [];
      const run = async delay => {
        const token = store.newResultToken();
        const path = `/photos?page=1&delay=${delay}`;
        let data;
        try {
          data = await api.get(path);
        } catch (error) {
          lines.push(`delay=${delay} 请求失败：${error.message}`);
          return;
        }
        noteRequest(path, data);
        if (!store.isResultTokenCurrent(token)) {
          lines.push(`delay=${delay}（token=${token}）响应已过期 → 丢弃，未写入结果集`);
          return;
        }
        store.setResults({ items: data.items || [], total: Number(data.total) || 0, page: 1 });
        lines.push(`delay=${delay}（token=${token}）写入结果集：total=${data.total}`);
      };
      await Promise.all([run(600), run(60)]);
      lines.push(`结果集 final total=${store.getState().results.total}`);
      logDemo(lines);
    }

    $('t-demo-account').addEventListener('click', () => demoAccountVersion().catch(error => logDemo(['异常：' + error.message])));
    $('t-demo-result').addEventListener('click', () => demoResultVersion().catch(error => logDemo(['异常：' + error.message])));

    /* ---------- 请求出口：记录最近一次请求，供自测页显示 ---------- */
    let bootInfo = null;
    async function reboot() {
      text('t-boot', '进行中…');
      try {
        bootInfo = await main.boot();
        const user = bootInfo.user;
        text('t-boot', user ? `成功（/api/auth/me → ${user.username}）` : '失败（回登录态）');
      } catch (error) {
        text('t-boot', '异常：' + error.message);
      }
      renderSession(store.getState());
      renderTheme();
      markThemeButtons();
    }

    $('t-reboot').addEventListener('click', () => { reboot(); });

    renderTheme();
    markThemeButtons();
    renderToast(store.getState());
    await reboot();

    // 自测钩子：给无头浏览器 / CDP 验收脚本用，正式视图不会这么做。
    window.__aibum = { api, store, router, theme, main, reboot, logDemo, get bootInfo() { return bootInfo; } };
    window.__aibumReady = true;
  