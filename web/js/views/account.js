/* ==========================================================================
   AIbum · 账户浮层  web/js/views/account.js
   --------------------------------------------------------------------------
   阶段 3.1 的三个浮层，都是"认证与账户"这一摊的：

     #dialog-recovery  恢复码（1.3 注册后 / 1.7 轮换后 / 1.8 重置后都要展示）
     #dialog-forgot    忘记密码（1.8）
     #dialog-security  账户安全：改密码 + 轮换恢复码（1.6 / 1.7）+ **外观（六档主题，D1）**

   逐条对照 docs/前端-行为清单.md：
     1.6 修改密码 —— POST /auth/password {current_password,new_password}
         → 清空表单 → 切回登录态 → 通知"密码已修改，请重新登录"
         （新密码为空时先报"请输入新密码"，与旧版一致）
     1.7 轮换恢复码 —— POST /auth/recovery-code {password}
         → 清空表单 → 关闭安全对话框 → 展示新恢复码
     1.8 忘记密码 —— POST /auth/reset-password {username,recovery_code,new_password}
         → 展示**新的**恢复码 → 通知"密码已重置，请保存新恢复码，然后登录"
     1.9 恢复码下载 —— Blob 触发下载 aibum-recovery-code.txt
         （内容：标题行 + 码 + 保密提示；与旧版逐字相同）

   错误处理走 store.guard（0.7）：异常转成顶部通知条，不静默。旧版这三个处理器
   也都是 guard 包着的。
   ========================================================================== */

import { api } from '../api.js';
import * as store from '../store.js';
import * as theme from '../theme.js';

/** 恢复码文件名（1.9）。 */
export const RECOVERY_FILE_NAME = 'aibum-recovery-code.txt';

/**
 * 恢复码文本内容（1.9：标题行 + 码 + 保密提示）。
 * 与 web/legacy/app.js L247 **逐字相同**，便于逐字节比对。
 * @param {string} code
 */
export function recoveryFileContent(code) {
  return 'AIbum recovery code\n' + code + '\nKeep this secret.';
}

/**
 * 建账户浮层。节点在 app.html 里（外壳级，登录前后都在），这里只做连线。
 * @param {{document?: Document, modals: ReturnType<import('../components/modal.js').createModals>}} options
 */
export function createAccountOverlays(options) {
  const doc = options.document || document;
  const modals = options.modals;
  const $ = id => {
    const node = doc.getElementById(id);
    if (!node) throw new Error('账户浮层缺少节点：#' + id);
    return node;
  };

  const recovery = $('dialog-recovery');
  const recoveryCode = $('recovery-code');
  const security = $('dialog-security');
  const passwordForm = $('password-form');
  const currentPassword = $('current-password');
  const newPassword = $('new-password');
  const forgot = $('dialog-forgot');
  const forgotForm = $('forgot-form');
  const resetName = $('reset-name');
  const resetCode = $('reset-code');
  const resetPassword = $('reset-password');

  /* ---------- 1.9 下载 ---------- */

  /** 把恢复码存成 txt（Blob + <a download>，CSP 下不需要内联任何东西）。 */
  function downloadRecoveryCode(code) {
    const blob = new Blob([recoveryFileContent(code)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = RECOVERY_FILE_NAME;
    doc.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- 恢复码浮层 ---------- */

  /** 展示一个恢复码（1.3 / 1.7 / 1.8 共用同一处 UI）。 */
  function showRecovery(code) {
    recoveryCode.value = String(code || '');
    modals.open(recovery);
    return recoveryCode.value;
  }

  modals.register(recovery, {
    // 关掉就清空（旧版 recovery 的 close 事件里做同一件事）：恢复码只展示一次，
    // 别让它在 DOM 里留着。
    onClose: () => { recoveryCode.value = ''; },
  });

  $('download-code').addEventListener('click', () => downloadRecoveryCode(recoveryCode.value));

  /* ---------- D1 外观：六档主题入口 ----------
     位置在 #dialog-security 里的 .dialog__section[data-role="appearance"]（D1 已拍板：
     主题入口放这里，不新开对话框）。**不另造一套主题逻辑**：档位顺序、文案、持久化
     全部用 theme.js —— THEME_CHOICES / THEME_LABELS / setTheme（setTheme 内部写
     localStorage 的 'aibum-theme'，并把 data-theme + data-choice 写到 <html>）。
     这里只做两件事：把六个按钮建出来、把当前档位高亮出来。 */
  const themeSeg = doc.querySelector('#dialog-security [data-role="appearance"] .seg');
  const themeButtons = new Map();

  /** 用 data-choice 高亮当前档位（theme.js 的契约：data-choice = 用户的选择，可能是 auto）。 */
  function syncThemeButtons() {
    const current = doc.documentElement.getAttribute('data-choice') || theme.readChoice();
    for (const [choice, button] of themeButtons) {
      button.setAttribute('aria-pressed', choice === current ? 'true' : 'false');
    }
  }

  if (themeSeg) {
    for (const choice of theme.THEME_CHOICES) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.dataset.themeChoice = choice;
      button.setAttribute('aria-pressed', 'false');
      button.textContent = theme.THEME_LABELS[choice];
      button.addEventListener('click', () => {
        theme.setTheme(choice);        // data-theme 立即变 + 落 localStorage（刷新后仍在）
        syncThemeButtons();
      });
      themeSeg.append(button);
      themeButtons.set(choice, button);
    }
    syncThemeButtons();
  }

  /* ---------- 1.6 / 1.7 账户安全 ---------- */

  function openSecurity() {
    passwordForm.reset();
    syncThemeButtons();          // 每次打开都对齐一次当前档位（可能在别处被改过）
    modals.open(security);
    return security;
  }

  // 必须 register（不能只 open）：✕ / 取消 的点击监听是在 register 里挂的。
  // 少这一句的表现是"点 ✕ 和 取消 完全没反应，只能靠 Esc 或点遮罩关"——
  // 遮罩一直盖住整页，看起来像页面卡死。
  modals.register(security, {
    // 关掉就清空：openSecurity 里那次 reset 是"开时清"，这里是"关时清"。
    // 不管走哪条关闭路径（✕ / 取消 / Esc / 点遮罩），密码都不该留在 DOM 里，
    // 下次打开也不残留上次输入的一半。
    onClose: () => { passwordForm.reset(); },
  });

  passwordForm.addEventListener('submit', store.guard(async event => {
    event.preventDefault();
    if (!newPassword.value) throw new Error('请输入新密码');
    await api.post('/auth/password', {
      current_password: currentPassword.value,
      new_password: newPassword.value,
    });
    passwordForm.reset();
    store.resetToLogin();          // 1.6：改密后所有会话失效 → 切回登录态
    modals.close(security);
    store.toast('密码已修改，请重新登录');
  }));

  $('rotate-code').addEventListener('click', store.guard(async () => {
    const result = await api.post('/auth/recovery-code', { password: currentPassword.value });
    passwordForm.reset();
    modals.close(security);
    showRecovery(result.recovery_code);      // 1.7：展示新恢复码
  }));

  /* ---------- 1.8 忘记密码 ---------- */

  function openForgot(prefill = {}) {
    forgotForm.reset();
    resetName.value = prefill.username || '';
    modals.open(forgot);
    return forgot;
  }

  // 同上：漏了 register，这个对话框的 ✕ / 取消 就是死的。
  modals.register(forgot, {
    // 关掉就清空：表单里有恢复码，跟 #dialog-recovery 一样不该留在 DOM 里。
    onClose: () => { forgotForm.reset(); },
  });

  forgotForm.addEventListener('submit', store.guard(async event => {
    event.preventDefault();
    const result = await api.post('/auth/reset-password', {
      username: resetName.value,
      recovery_code: resetCode.value,
      new_password: resetPassword.value,
    });
    forgotForm.reset();
    modals.close(forgot);
    showRecovery(result.recovery_code);      // 1.8：必须展示**新的**恢复码
    store.toast('密码已重置，请保存新恢复码，然后登录');
  }));

  return {
    showRecovery,
    openSecurity,
    openForgot,
    closeAll: () => modals.closeAll(),
    downloadRecoveryCode,
    syncThemeButtons,
    elements: { recovery, security, forgot, recoveryCode, themeSeg },
  };
}

export default { createAccountOverlays, recoveryFileContent, RECOVERY_FILE_NAME };
