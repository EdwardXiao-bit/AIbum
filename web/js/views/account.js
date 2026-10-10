/* ==========================================================================
   AIbum · 账户浮层  web/js/views/account.js
   --------------------------------------------------------------------------
   阶段 3.1 的三个浮层，都是"认证与账户"这一摊的：

     #dialog-recovery  恢复码（1.3 注册后 / 1.7 轮换后 / 1.8 重置后都要展示）
     #dialog-forgot    忘记密码（1.8）
     #dialog-security  账户安全：改密码 + 轮换恢复码（1.6 / 1.7）

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

  /* ---------- 1.6 / 1.7 账户安全 ---------- */

  function openSecurity() {
    passwordForm.reset();
    modals.open(security);
    return security;
  }

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
    elements: { recovery, security, forgot, recoveryCode },
  };
}

export default { createAccountOverlays, recoveryFileContent, RECOVERY_FILE_NAME };
