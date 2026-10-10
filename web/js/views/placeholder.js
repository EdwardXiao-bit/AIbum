/* ==========================================================================
   AIbum · 占位视图  web/js/views/placeholder.js
   --------------------------------------------------------------------------
   阶段 3.1 只交付【认证与账户】。相册主界面 / 照片详情 / 管理后台是**独立卡片**
   （见 docs/PROJECT.md：F4 / F5 / F7），本卡不写它们，只留一个诚实的占位：

     - 不搭任何主界面结构（否则会和后续卡片抢地盘、并制造"已经做了"的错觉）
     - 但必须存在，否则登录成功后是一片空白，1.4 / 1.5 的跳转与登出就无从验收

   节点全部用 createElement + textContent 构造，不拼 HTML 字符串，不写内联样式。
   ========================================================================== */

/**
 * 建一个占位视图。
 * @param {{eyebrow: string, title: string, note: string, items?: string[], card: string}} spec
 *        card = 负责它的卡片名（写在页面上，免得被当成"做完了"）
 */
export function createPlaceholderView(spec) {
  const node = document.createElement('section');
  node.className = 'placeholder';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = spec.eyebrow;

  const title = document.createElement('h1');
  title.className = 'hero';
  title.textContent = spec.title;

  const note = document.createElement('p');
  note.className = 'lead';
  note.textContent = spec.note;

  const badge = document.createElement('p');
  badge.className = 'badge badge--warn';
  badge.textContent = `待 ${spec.card} 实现`;

  node.append(eyebrow, title, note, badge);

  if (spec.items && spec.items.length) {
    const list = document.createElement('ul');
    list.className = 'placeholder__list';
    for (const text of spec.items) {
      const item = document.createElement('li');
      item.textContent = text;
      list.append(item);
    }
    node.append(list);
  }

  let parent = null;

  return {
    element: node,
    mount(container) {
      parent = container;
      container.replaceChildren(node);
    },
    unmount() {
      if (parent && parent.contains(node)) node.remove();
      parent = null;
    },
  };
}

/** 三个占位视图的定义（文案里写清归哪张卡，避免误读成已完成）。 */
export const PLACEHOLDERS = {
  library: {
    eyebrow: 'PERSONAL LIBRARY',
    title: '我的照片',
    note: '相册主界面（搜索 · 筛选 · 网格 · 批量）属于独立卡片，本卡只交付认证与账户这一摊。',
    card: 'F4',
    items: [
      '六维筛选 + 排序，结果文案与加载更多',
      '文字 / 参考图检索与严格度三档',
      '上传（全页拖放 + 队列）与批量操作',
    ],
  },
  photo: {
    eyebrow: 'PHOTO DETAILS',
    title: '照片详情',
    note: '照片详情的形态（右侧抽屉 / 弹窗 / 独立页）见决策台账 D2，由独立卡片实现。',
    card: 'F5',
  },
  admin: {
    eyebrow: 'ADMINISTRATION',
    title: '管理控制台',
    note: '管理后台（统计卡片 · 用户表 · 启停用户）属于独立卡片；登录与入口跳转本卡已实现。',
    card: 'F7',
  },
};

export default { createPlaceholderView, PLACEHOLDERS };
