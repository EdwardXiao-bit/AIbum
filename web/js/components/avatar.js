/* ==========================================================================
   AIbum · 头像  web/js/components/avatar.js
   --------------------------------------------------------------------------
   决策 D1b（已与用户确认）：**头像只能是生成的**，不做上传。
   依据（实测，不是推测）：`users` 表只有
     id / username / password_hash / created_at / is_admin / active / recovery_hash
   —— 没有 avatar 字段；后端 `app/` 里 grep 不到任何 avatar 概念，且**后端一行不改**。
   所以头像 = 用户名首字 + 由 **user.id** 决定的确定底色（同一个人永远同色）。

   与 theme.js 相同的分工：纯函数（可被 node 直接 import 单测）+ 一个把结果写进
   DOM 的 applyAvatar。颜色不在这里拼 CSS —— CSP（§0A E1/E5）不允许内联 `style="..."`，
   动态样式只能走 CSSOM，而"六个固定色"根本不需要动态值：本模块只输出
   `data-avatar="0..5"`，具体颜色由 css/components.css 的 `.avatar[data-avatar]` 决定。
   ========================================================================== */

/** 头像底色档位数（与 css/components.css 的 .avatar[data-avatar="0..5"] 一一对应）。 */
export const AVATAR_COLORS = 6;

/**
 * 头像文字：用户名首字。
 * 规则（D1b）：CJK 取首字原样；拉丁取首字母并**大写**。
 * 用 Array.from 按码点取首字，代理对（emoji 等）不会被切成半个字符。
 * @param {unknown} username
 */
export function avatarInitial(username) {
  const text = String(username == null ? '' : username).trim();
  if (!text) return '?';
  const first = Array.from(text)[0];
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

/**
 * 底色档位：由 user.id 决定，确定且稳定（同一个人永远同色）。
 * 用 FNV-1a 而不是"charCode 相加"：后者对换序字符串（"ab"/"ba"）同值、且低位分布差。
 * 实测（`.tmp-f17/hash-collisions.py`，真实 users 表 64 条）：两者各有 6 组两两撞色，
 * 分布 [9,10,10,5,16,14] vs [7,14,7,12,15,9] —— **撞色率上分不出高下**（6 档 64 人，
 * 期望本来就有约 6 组），选 FNV 是因为它是有名字的标准哈希、不依赖 Unicode 码点求和。
 * @param {unknown} userId
 * @param {number} [modulo]
 */
export function avatarColorIndex(userId, modulo = AVATAR_COLORS) {
  const text = String(userId == null ? '' : userId);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;     // FNV-1a 32 位
  }
  return (hash >>> 0) % modulo;
}

/**
 * 把用户名 / id 写进一个头像节点（幂等：重登、换账户都调它）。
 * @param {HTMLElement} node 带 .avatar 的元素
 * @param {{username?: unknown, id?: unknown}} user
 */
export function applyAvatar(node, user) {
  const username = user && user.username;
  const id = user && user.id;
  node.textContent = avatarInitial(username);
  node.setAttribute('data-avatar', String(avatarColorIndex(id)));
  return node;
}

export default { AVATAR_COLORS, avatarInitial, avatarColorIndex, applyAvatar };
