const $ = id => document.getElementById(id);
const adminPortal = location.pathname === '/admin';
const state = {user: null, register: false, items: [], selected: new Set(), page: 1, total: 0, mode: 'browse', detail: null, health: '', query: null, busy: false, tags: new Set(), tagOptions: [], referenceFile: null, referenceUrl: null, similarId: null, users: []};
let noticeTimer, accountVersion = 0, resultVersion = 0;
function notice(text) { $('notice').textContent = text; $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('notice').hidden = true, 7000); }
async function api(path, options = {}) {
  const version = accountVersion;
  const response = await fetch('/api' + path, {...options, headers: {'X-AIbum-Request': '1', ...options.headers}});
  if (version !== accountVersion) throw new Error('账户状态已更新，请重试');
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (response.status === 401 && state.user) showAuth();
    const detail = Array.isArray(error.detail) ? error.detail.map(e => e.msg).join('；') : error.detail;
    throw new Error(detail || `请求失败 (${response.status})`);
  }
  return response.json();
}
const json = (method, body) => ({method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
function guard(fn) { return async event => { try { await fn(event); } catch (error) { notice(error.message); } }; }
function showAuth() {
  accountVersion++; resultVersion++;
  state.user = null; state.items = []; state.selected.clear(); state.query = null; state.detail = null;
  state.tags.clear(); state.users = []; clearReference();
  $('detail').close(); $('detail-image').removeAttribute('src'); $('grid').replaceChildren();
  $('security').close(); $('admin-users').replaceChildren(); $('admin-workspace').hidden = true;
  $('security-button').disabled = false;
  $('workspace').hidden = true; $('account').hidden = true; $('auth').hidden = false;
  $('portal-link').hidden = false;
}
async function showWorkspace(user) {
  accountVersion++; resultVersion++;
  state.user = {id: user.id, username: user.username, is_admin: user.is_admin}; state.mode = 'browse'; state.health = ''; state.selected.clear();
  state.tags.clear(); clearReference(); resetFilters();
  $('search-form').reset(); $('reference-info').hidden = true;
  $('auth').hidden = true; $('workspace').hidden = false; $('account').hidden = false; $('username').textContent = user.username;
  $('admin-button').hidden = !user.is_admin; $('query').disabled = false;
  $('portal-link').hidden = true; $('library-link').hidden = !adminPortal;
  $('auth-password').value = '';
  if (adminPortal) {
    if (!user.is_admin) { showAuth(); $('auth-error').textContent = '请使用管理员账号登录'; return; }
    $('workspace').hidden = true; $('admin-workspace').hidden = false; $('admin-button').hidden = true;
    await loadUsers(); return;
  }
  await refreshOptions(); await loadPhotos(); await updateHealth();
}
$('auth-toggle').onclick = () => { state.register = !state.register; $('auth-title').textContent = state.register ? '创建你的相册' : '登录你的相册'; $('auth-submit').textContent = state.register ? '创建账户' : '登录'; $('auth-toggle').textContent = state.register ? '已有账户？返回登录' : '还没有账户？创建一个'; $('auth-password').autocomplete = state.register ? 'new-password' : 'current-password'; $('auth-error').textContent = ''; };
$('auth-form').onsubmit = async event => {
  event.preventDefault(); $('auth-submit').disabled = true; $('auth-error').textContent = '';
  try { const endpoint = adminPortal ? '/admin/login' : '/auth/' + (state.register ? 'register' : 'login'); const user = await api(endpoint, json('POST', {username: $('auth-name').value, password: $('auth-password').value})); if (user.is_admin && !adminPortal) { location.assign('/admin'); return; } await showWorkspace(user); if (user.recovery_code) showRecovery(user.recovery_code); }
  catch (error) { $('auth-error').textContent = error.message; }
  finally { $('auth-submit').disabled = false; }
};
$('logout').onclick = guard(async () => { await api('/auth/logout', {method: 'POST'}); showAuth(); });
function fillSelect(id, entries, first) {
  const node = $(id), previous = node.value;
  node.replaceChildren(new Option(first, ''));
  entries.forEach(item => node.add(new Option(item.name + (item.count !== undefined ? ` (${item.count})` : ''), item.id ?? item.name)));
  if ([...node.options].some(o => o.value === previous)) node.value = previous;
}
async function refreshOptions() {
  const [albums, tags] = await Promise.all([api('/albums'), api('/tags')]);
  fillSelect('album-filter', albums, '所有相册'); fillSelect('batch-album', albums, '移出相册');
  fillSelect('detail-album', albums, '未归入相册'); state.tagOptions = tags; renderTagOptions();
}
function renderTagOptions() {
  const keyword = $('tag-keyword').value.trim().toLowerCase(); $('tag-options').replaceChildren();
  const options = state.tagOptions.filter(t => t.name.toLowerCase().includes(keyword));
  options.forEach(tag => {
    const label = document.createElement('label'); label.className = 'tag-option';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = state.tags.has(tag.name);
    const name = document.createElement('span'); name.textContent = tag.name;
    const count = document.createElement('span'); count.className = 'tag-count'; count.textContent = `(${tag.count})`;
    check.onchange = guard(async () => {
      if (check.checked && state.tags.size >= 30) { check.checked = false; throw new Error('最多选择 30 个标签'); }
      check.checked ? state.tags.add(tag.name) : state.tags.delete(tag.name); await applyFilters();
    });
    label.append(check, name, count); $('tag-options').append(label);
  });
  if (!options.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '暂无匹配标签'; $('tag-options').append(empty); }
}
$('tag-keyword').oninput = renderTagOptions;
$('clear-tags').onclick = guard(async () => { state.tags.clear(); renderTagOptions(); await applyFilters(); });
function resetFilters() { state.tags.clear(); ['album-filter','location-filter','start-filter','end-filter','tag-keyword'].forEach(id => $(id).value = ''); $('favorite-filter').checked = false; $('order').value = 'newest'; renderTagOptions(); }
$('clear-filters').onclick = guard(async () => { resetFilters(); await applyFilters(); });
function appendFilters(target) {
  for (const key of ['album_id','location','start','end','favorite','tags']) target.delete(key);
  for (const [key,value] of Object.entries(filterValues())) if (value) target.set(key,value);
  for (const tag of state.tags) target.append('tags',tag);
}
function filterValues() {
  if ($('start-filter').value && $('end-filter').value && $('start-filter').value > $('end-filter').value) throw new Error('开始日期不能晚于结束日期');
  return {album_id: $('album-filter').value, location: $('location-filter').value.trim(), start: $('start-filter').value, end: $('end-filter').value, favorite: $('favorite-filter').checked ? 'true' : ''};
}
async function loadPhotos(append = false) {
  const version = ++resultVersion;
  const page = append ? state.page + 1 : 1;
  const params = new URLSearchParams({page, order: $('order').value}); appendFilters(params);
  const data = await api('/photos?' + params);
  if (version !== resultVersion) return;
  state.page = page; state.total = data.total; state.items = append ? [...state.items, ...data.items] : data.items;
  state.mode = 'browse'; state.query = null;
  state.similarId = null; $('search-summary').hidden = true;
  $('result-label').textContent = `${data.total} 张照片 · 已显示 ${state.items.length} 张`;
  $('load-more').hidden = state.items.length >= data.total; render();
}
function render() {
  $('grid').replaceChildren(); $('empty').hidden = state.items.length > 0;
  $('empty').querySelector('h2').textContent = state.mode === 'browse' ? '这里还没有照片' : '没有找到符合条件的照片';
  $('empty').querySelector('p').textContent = state.mode === 'browse' ? '上传一些照片，或调整当前筛选条件。' : '没有达到当前匹配门槛的照片。可以调低严格度、调整描述或筛选，并确认照片已完成分析。';
  const ids = new Set(state.items.map(p => p.id)); state.selected = new Set([...state.selected].filter(id => ids.has(id)));
  state.items.forEach(photo => {
    const card = document.createElement('article'); card.className = 'card';
    const check = document.createElement('input'); check.type = 'checkbox'; check.className = 'card-select'; check.checked = state.selected.has(photo.id); check.setAttribute('aria-label', '选择 ' + photo.name);
    check.onchange = () => { check.checked ? state.selected.add(photo.id) : state.selected.delete(photo.id); updateSelection(); };
    const open = document.createElement('button'); open.className = 'card-image'; open.setAttribute('aria-label', '查看 ' + photo.name); open.onclick = guard(() => openDetail(photo.id));
    const image = document.createElement('img'); image.src = photo.thumbnail_url; image.alt = photo.name; image.loading = 'lazy'; open.append(image);
    const body = document.createElement('div'); body.className = 'card-body';
    const title = document.createElement('p'); title.className = 'card-title'; title.textContent = (photo.favorite ? '★ ' : '') + photo.name; title.title = photo.name;
    const subtitle = document.createElement('p'); subtitle.className = 'card-subtitle'; subtitle.textContent = photo.score !== undefined ? `相似度 ${photo.score.toFixed(3)}` : `${(photo.taken_at || photo.created_at).slice(0,10)} · ${statusName(photo.status)}`;
    const tags = document.createElement('div'); tags.className = 'tags';
    photo.tags.slice(0,3).forEach(t => { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = t.name; tags.append(tag); });
    body.append(title, subtitle, tags); card.append(check, open, body); $('grid').append(card);
  }); updateSelection();
}
function statusName(status) { return {pending: '等待分析', processing: '分析中', ready: '已分析', failed: '分析失败', deleting: '删除中'}[status] || status; }
function updateSelection() { $('selected-count').textContent = `已选 ${state.selected.size} 张`; $('select-all').checked = !!state.items.length && state.selected.size === state.items.length; ['batch-favorite','batch-move','batch-delete'].forEach(id => $(id).disabled = state.selected.size === 0 || state.busy); }
$('select-all').onchange = () => { state.selected = $('select-all').checked ? new Set(state.items.map(p => p.id)) : new Set(); render(); };
$('load-more').onclick = guard(() => loadPhotos(true));
async function applyFilters() { state.selected.clear(); if (state.mode === 'search') await runSearch(true); else if (state.mode === 'similar') await runSimilar(state.similarId); else await loadPhotos(); }
$('apply-filters').onclick = guard(applyFilters);
$('refresh').onclick = guard(async () => { await refreshOptions(); await reload(); await updateHealth(); });
$('reset-search').onclick = guard(async () => { $('search-form').reset(); clearReference(); resetFilters(); state.selected.clear(); await loadPhotos(); });
$('new-album').onclick = guard(async () => { const name = prompt('新相册名称（最多 80 字）'); if (!name?.trim()) return; await api('/albums', json('POST', {name: name.trim()})); await refreshOptions(); notice('相册已创建'); });
function clearReference() {
  if (state.referenceUrl) URL.revokeObjectURL(state.referenceUrl);
  state.referenceFile = null; state.referenceUrl = null; $('reference').value = '';
  $('reference-info').hidden = true; $('reference-preview').removeAttribute('src'); $('drop-prompt').hidden = false; $('query').disabled = false;
}
function setReference(file) {
  if (!file) return;
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('参考图不能为空且不得超过 20 MiB');
  if (file.type && !['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片');
  clearReference(); state.referenceFile = file; state.referenceUrl = URL.createObjectURL(file);
  $('reference-preview').src = state.referenceUrl; $('reference-name').textContent = file.name;
  $('reference-info').hidden = false; $('drop-prompt').hidden = true; $('query').value = ''; $('query').disabled = true;
}
$('reference').onchange = guard(() => setReference($('reference').files[0]));
$('clear-reference').onclick = event => { event.stopPropagation(); clearReference(); };
$('reference-drop').onclick = event => { if (!event.target.closest('button')) $('reference').click(); };
$('reference-drop').onkeydown = event => { if (event.target === $('reference-drop') && ['Enter',' '].includes(event.key)) { event.preventDefault(); $('reference').click(); } };
$('reference-drop').ondragover = event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; $('reference-drop').classList.add('dragging'); };
$('reference-drop').ondragleave = event => { if (!$('reference-drop').contains(event.relatedTarget)) $('reference-drop').classList.remove('dragging'); };
$('reference-drop').ondrop = guard(event => {
  event.preventDefault(); $('reference-drop').classList.remove('dragging');
  const files = [...event.dataTransfer.files]; if (files.length !== 1) throw new Error('每次请选择一张参考图片'); setReference(files[0]);
});
for (const type of ['dragover','drop']) document.addEventListener(type, event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
$('strictness').onchange = guard(async () => { if (state.mode !== 'browse') await applyFilters(); });
$('search-form').onsubmit = guard(async event => { event.preventDefault(); await runSearch(); });
async function runSearch(reuse = false) {
  const version = ++resultVersion;
  const form = new FormData();
  if (reuse && state.query) { for (const [key,value] of state.query.entries()) form.append(key,value); }
  else { form.set('text', state.referenceFile ? '' : $('query').value.trim()); if (state.referenceFile) form.set('image', state.referenceFile); }
  appendFilters(form); form.set('strictness', $('strictness').value); form.set('limit','100');
  $('search-button').disabled = true; $('search-button').textContent = '检索中…';
  try { const data = await api('/search', {method: 'POST', body: form}); if (version !== resultVersion) return; state.items = data.items; state.mode = 'search'; state.query = form; state.similarId = null; showSearchResult(data, data.mode === 'text' ? '文搜图' : '图搜图'); }
  finally { $('search-button').disabled = false; $('search-button').textContent = '搜索'; }
}
function showSearchResult(data, title) {
  $('result-label').textContent = `${title} · 匹配 ${data.matched_count} 张，显示 ${data.items.length} 张`;
  $('search-summary').textContent = `已过滤 ${data.filtered_count} 张低相关照片 · ${ {broad:'宽松',balanced:'适中',strict:'严格'}[data.strictness]}匹配${data.elapsed_ms !== undefined ? ` · ${data.elapsed_ms} ms` : ''}。相似度为原始分数，不是识别概率。`;
  $('search-summary').hidden = false; $('load-more').hidden = true; render();
}
async function runSimilar(id) {
  const version = ++resultVersion; const params = new URLSearchParams({strictness:$('strictness').value,limit:'100'}); appendFilters(params);
  const data = await api('/photos/' + id + '/similar?' + params);
  if (version !== resultVersion) return; state.items = data.items; state.mode = 'similar'; state.similarId = id; showSearchResult(data,'相似照片（已排除参考图）');
}
async function reload() { if (state.mode === 'search') await runSearch(true); else if (state.mode === 'similar') await runSimilar(state.similarId); else await loadPhotos(); }
function uploadOne(file, album, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/photos'); xhr.setRequestHeader('X-AIbum-Request','1');
    xhr.upload.onprogress = e => { if (e.lengthComputable) progress(e.loaded / e.total); };
    xhr.onload = () => { let data; try { data = JSON.parse(xhr.responseText); } catch { return reject(new Error('上传响应异常')); } xhr.status < 300 ? resolve(data) : reject(new Error(typeof data.detail === 'string' ? data.detail : '上传失败')); };
    xhr.onerror = () => reject(new Error('网络错误')); const form = new FormData(); form.set('file',file); if (album) form.set('album_id',album); xhr.send(form);
  });
}
$('upload').onchange = guard(async () => {
  const files = [...$('upload').files]; if (!files.length) return;
  const owner = state.user?.id, album = $('album-filter').value;
  $('upload').disabled = true; $('upload-progress').hidden = false; let ok = 0, duplicate = 0; const errors = [];
  $('logout').disabled = true; $('security-button').disabled = true;
  try {
    for (let i=0; i<files.length; i++) {
      if (state.user?.id !== owner) break;
      $('upload-label').textContent = `上传 ${i+1}/${files.length}：${files[i].name}`;
      try { if (files[i].size > 20*1024*1024) throw new Error('超过 20 MiB'); const result = await uploadOne(files[i],album,fraction => $('progress').value = (i+fraction)/files.length*100); ok++; if (result.duplicate) duplicate++; }
      catch(error) { errors.push(files[i].name + '：' + error.message); }
    }
    if (state.user?.id === owner) { await refreshOptions(); await loadPhotos(); await updateHealth(); notice(`完成 ${ok}/${files.length} 张，重复 ${duplicate} 张。${errors.slice(0,3).join('；')}`); }
  } finally { $('upload').value = ''; $('upload').disabled = false; $('logout').disabled = false; $('security-button').disabled = false; $('upload-progress').hidden = true; }
});
async function batch(action, body) {
  if (state.busy || !state.selected.size) return;
  if (action === 'DELETE' && !confirm(`确定永久删除所选 ${state.selected.size} 张照片？此操作不可撤销。`)) return;
  state.busy = true; updateSelection(); let done = 0;
  try { for (const id of [...state.selected]) { await api('/photos/' + id, action === 'DELETE' ? {method: 'DELETE'} : json('PATCH', body)); state.selected.delete(id); done++; } notice(`已处理 ${done} 张照片`); }
  catch(error) { notice(`已处理 ${done} 张；${error.message}`); }
  finally { state.busy = false; await refreshOptions(); await reload(); }
}
$('batch-favorite').onclick = guard(() => batch('PATCH', {favorite: true}));
$('batch-move').onclick = guard(() => batch('PATCH', {album_id: $('batch-album').value || null}));
$('batch-delete').onclick = guard(() => batch('DELETE'));
async function openDetail(id) {
  const photo = await api('/photos/' + id); state.detail = photo;
  $('detail-image').src = photo.original_url; $('detail-image').alt = photo.name;
  $('detail-name').value = photo.name; $('detail-location').value = photo.location; $('detail-album').value = photo.album_id || '';
  $('detail-tags').value = photo.tags.map(t => t.name).join(', '); $('detail-favorite').checked = photo.favorite;
  $('detail-meta').textContent = `${photo.width} × ${photo.height} · ${(photo.size/1024/1024).toFixed(2)} MiB · ${photo.camera || '无相机信息'}`;
  $('detail-auto').textContent = photo.tags.filter(t => t.source === 'auto').map(t => `${t.name}：${t.score.toFixed(3)}`).join(' / ') + '（推荐分数不是概率；修改标签后保存为人工标签）';
  $('detail-state').textContent = photo.error || statusName(photo.status); $('detail-similar').disabled = photo.status !== 'ready'; $('detail-retry').disabled = !['ready','failed'].includes(photo.status);
  $('detail-download').href = photo.original_url + '?download=true'; $('detail').showModal();
}
$('close-detail').onclick = () => $('detail').close();
$('detail-form').onsubmit = guard(async event => {
  event.preventDefault(); const photo = state.detail;
  const body = {name: $('detail-name').value, location: $('detail-location').value, album_id: $('detail-album').value || null, favorite: $('detail-favorite').checked};
  const tags = $('detail-tags').value.split(/[,，]/).map(t => t.trim()).filter(Boolean);
  if (JSON.stringify(tags) !== JSON.stringify(photo.tags.map(t => t.name))) body.tags = tags;
  await api('/photos/' + photo.id, json('PATCH', body)); $('detail').close(); await refreshOptions(); await reload(); notice('修改已保存');
});
$('detail-retry').onclick = guard(async () => { await api('/photos/' + state.detail.id + '/retry', {method: 'POST'}); $('detail').close(); await reload(); notice('已加入分析队列'); });
$('detail-similar').onclick = guard(async () => { await runSimilar(state.detail.id); $('detail').close(); });
async function updateHealth() {
  if (!state.user || adminPortal) return;
  const health = await api('/health'); const counts = health.photos;
  $('model-status').textContent = `${health.model.installed ? '本地图文模型' : '模型未安装：请先运行模型准备脚本'} · 已分析 ${counts.ready || 0} · 待处理 ${(counts.pending || 0)+(counts.processing || 0)} · 失败 ${counts.failed || 0}`;
  const snapshot = JSON.stringify(counts); const changed = state.health && snapshot !== state.health; state.health = snapshot;
  if (changed && !state.busy && !state.selected.size && !$('detail').open && !$('upload').disabled && !$('search-button').disabled) { await refreshOptions(); if (state.mode === 'browse') await loadPhotos(); }
}
setInterval(() => { if (state.user && !document.hidden) updateHealth().catch(() => {}); }, 4000);
function showRecovery(code) { $('recovery-code').value = code; $('recovery').showModal(); }
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
$('recovery').addEventListener('close', () => $('recovery-code').value = '');
$('download-code').onclick = () => {
  const url = URL.createObjectURL(new Blob(['AIbum recovery code\n' + $('recovery-code').value + '\nKeep this secret.'], {type: 'text/plain'}));
  const link = document.createElement('a'); link.href = url; link.download = 'aibum-recovery-code.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
};
$('security-button').onclick = () => { $('password-form').reset(); $('security').showModal(); };
$('password-form').onsubmit = guard(async event => {
  event.preventDefault(); if (!$('new-password').value) throw new Error('请输入新密码');
  await api('/auth/password', json('POST', {current_password: $('current-password').value, new_password: $('new-password').value}));
  $('password-form').reset(); showAuth(); notice('密码已修改，请重新登录');
});
$('rotate-code').onclick = guard(async () => {
  const result = await api('/auth/recovery-code', json('POST', {password: $('current-password').value}));
  $('password-form').reset(); $('security').close(); showRecovery(result.recovery_code);
});
$('forgot-button').onclick = () => { $('forgot-form').reset(); $('reset-name').value = $('auth-name').value; $('forgot').showModal(); };
$('forgot-form').onsubmit = guard(async event => {
  event.preventDefault(); const result = await api('/auth/reset-password', json('POST', {username: $('reset-name').value, recovery_code: $('reset-code').value, new_password: $('reset-password').value}));
  $('forgot-form').reset(); $('forgot').close(); showRecovery(result.recovery_code); notice('密码已重置，请保存新恢复码，然后登录');
});
async function loadUsers() {
  const [users, overview] = await Promise.all([api('/admin/users'),api('/admin/overview')]); state.users = users;
  $('stat-users').textContent = overview.users.total; $('stat-active').textContent = overview.users.active;
  $('stat-photos').textContent = overview.photos.total; $('stat-failed').textContent = overview.photos.failed;
  $('admin-model-status').textContent = overview.model.installed ? '图文模型已安装' : '图文模型尚未安装';
  $('admin-storage').textContent = `照片存储 ${(overview.photos.bytes/1024/1024).toFixed(1)} MiB`; renderUsers();
}
function renderUsers() {
  const keyword = $('admin-search').value.trim().toLowerCase(), status = $('admin-status-filter').value;
  const users = state.users.filter(u => u.username.toLowerCase().includes(keyword) && (status === 'all' || (status === 'active' ? !!u.active : !u.active)));
  $('admin-users').replaceChildren(); $('admin-empty').hidden = !!users.length;
  for (const user of users) {
    const row = document.createElement('tr');
    for (const value of [user.username + (user.is_admin ? ' · 管理员' : ''),user.created_at.slice(0,10),`${user.photo_count} / 500`,user.active ? '正常' : '已停用']) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    const action = document.createElement('td');
    if (!user.is_admin) { const button = document.createElement('button'); button.textContent = user.active ? '停用' : '启用'; button.className = user.active ? 'danger' : ''; button.onclick = guard(async () => { if (user.active && !confirm('停用后该用户将被退出登录，照片保留。确定继续？')) return; button.disabled = true; try { await api('/admin/users/' + user.id, json('PATCH', {active: !user.active})); await loadUsers(); } finally { button.disabled = false; } }); action.append(button); }
    else action.textContent = '—'; row.append(action); $('admin-users').append(row);
  }
}
$('admin-search').oninput = renderUsers; $('admin-status-filter').onchange = renderUsers;
$('admin-refresh').onclick = guard(loadUsers);
$('admin-button').onclick = () => location.assign('/admin');
if (adminPortal) {
  document.title = 'AIbum · 管理后台'; $('auth-title').textContent = '管理员登录'; $('auth-submit').textContent = '登录管理台'; $('auth-toggle').hidden = true;
  $('portal-link').textContent = '普通用户入口'; $('portal-link').href = '/';
  $('auth').querySelector('h1').textContent = '相册管理，从这里开始。';
  $('auth').querySelector('.intro').textContent = '使用已配置的管理员账号和密码登录，查看账户与服务运行情况。';
  $('auth-form').querySelector('p').textContent = '仅管理员账号可进入控制台。';
}
(async () => { try { await showWorkspace(await api('/auth/me')); } catch(error) { showAuth(); } })();
