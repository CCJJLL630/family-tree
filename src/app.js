import { STORAGE_KEY, emptyFamily, parseBackupFile, validateData, removePerson, describeRelationship, layoutTree, siblingsOf } from './family.js';
import { readLibrary, addFamily, selectFamily, renameFamily, replaceFamily, deleteFamily, saveLibraryIfUnchanged } from './library.js';
import { demoFamily } from './demo.js';
import { storageRequest } from './storage.js';

const $ = id => document.getElementById(id);
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const svgElement = (tag, attrs = {}, text) => { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); if (text !== undefined) node.textContent = text; return node; };
let data = emptyFamily(), selectedId = '', savedText = null, locked = false, scale = 1, treeSize = { width: 650, height: 400 };
let editingId = '', editingPhoto = '', photoToken = 0, namingId = '', editingFamilyId = '', editingSnapshot = null;
let storage, storageState = null, ready = false, changingLocation = false, saving = false, library = { version: 2, activeId: '', families: [] };
const currentFamily = () => library.families.find(f => f.id === library.activeId);
async function initializeStorage() {
  try { storage = window.localStorage; } catch { /* File storage does not require browser storage. */ }
  try {
    storageState = await storageRequest();
    if (storageState.mode === 'file') {
      library = readLibrary(JSON.stringify(storageState.library)); savedText = storageState.revision;
    } else {
      if (!storage) throw new Error('浏览器未提供可用存储，请允许本地存储后重新打开页面');
      savedText = storage.getItem(STORAGE_KEY); library = readLibrary(savedText);
    }
    data = currentFamily()?.data || emptyFamily(); selectedId = data.selfId || data.people[0]?.id || '';
  } catch (error) {
    locked = true; showNotice(`${error.message}。为保护资料，已停止写入，请检查存档并刷新。`, true);
  } finally { ready = true; render(); requestAnimationFrame(fitTree); }
}

function showNotice(message, error = false) {
  $('notice').replaceChildren(document.createTextNode(message));
  $('notice').className = `notice${error ? ' error' : ''}`;
  $('notice').hidden = false;
}
function assertWritable() {
  if (!ready || !storageState) throw new Error('保存位置尚未加载，请等待本机服务并刷新页面');
  if (locked) throw new Error('当前页面已停止写入，请先导出备份并刷新页面');
}
function applyLibrary(next, text, message, reset = false) {
  const switched = reset || library.activeId !== next.activeId;
  library = next; savedText = text; data = currentFamily()?.data || emptyFamily();
  if (switched) { selectedId = ''; $('from').value = ''; $('to').value = ''; $('search').value = ''; }
  if (!data.people.some(p => p.id === selectedId)) selectedId = data.selfId || data.people[0]?.id || '';
  render(); if (switched) fitTree(); showNotice(message);
}
async function commitLibrary(next, message) {
  assertWritable();
  if (changingLocation) throw new Error('正在更改保存位置，请完成后再保存');
  if (saving) throw new Error('正在保存，请等待当前保存完成后重试');
  saving = true; render();
  try {
    if (storageState.mode === 'file') {
      const saved = await storageRequest('PUT', { library: next, revision: storageState.revision });
      storageState = saved;
      applyLibrary(saved.library, saved.revision, message);
    } else {
      const revision = storageState.revision;
      const saved = await saveLibraryIfUnchanged(storage, next, savedText, navigator.locks, async () => {
        const latest = await storageRequest();
        if (latest.mode !== 'browser' || latest.revision !== revision) throw new Error('保存位置已在其他页面更改，请刷新后再编辑');
      });
      applyLibrary(saved.library, saved.text, message);
    }
  } finally { saving = false; render(); }
}
async function commit(next, message) {
  await commitLibrary(replaceFamily(library, library.activeId, next), message);
}
async function run(action) { try { await action(); } catch (error) { showNotice(error.message, true); } }
function personLabel(p) { return `${p.name}${p.alias ? ` · ${p.alias}` : ''}${p.birth ? `（${p.birth.slice(0, 4)}）` : ''}`; }
function fillSelect(select, chosen = '', exclude = '', placeholder = '选择成员') {
  select.replaceChildren();
  if (!select.multiple) select.append(new Option(placeholder, ''));
  for (const p of data.people) if (p.id !== exclude) select.append(new Option(personLabel(p), p.id));
  select.value = chosen;
}
function avatar(p, large = false) {
  const node = element('div', `avatar ${p.gender}${large ? ' large' : ''}`);
  if (p.photo) { const img = element('img'); img.src = p.photo; img.alt = `${p.name}的照片`; node.append(img); }
  else node.textContent = p.name.slice(0, 1) || '人';
  return node;
}
function selectPerson(id) { selectedId = id; $('to').value = id; if (!$('from').value) $('from').value = data.selfId; renderMembers(); renderTree(); renderDetail(); renderRelationship(); }
function render() {
  const from = $('from').value, to = $('to').value;
  $('member-count').textContent = data.people.length;
  fillSelect($('self'), data.selfId, '', '设置“我是谁”');
  fillSelect($('from'), from || data.selfId); fillSelect($('to'), to || selectedId);
  if (!$('from').value) $('from').value = data.selfId;
  if (!$('to').value) $('to').value = selectedId;
  const busy = !ready || changingLocation || saving, unavailable = locked || busy || !currentFamily();
  for (const id of ['add', 'start', 'demo', 'self', 'import', 'rename-family', 'delete-family']) $(id).disabled = unavailable;
  $('new-family').disabled = locked || busy; $('export').disabled = busy || (!currentFamily() && !locked);
  $('storage-settings').disabled = busy;
  $('storage-current').textContent = !ready ? '正在读取保存位置…' : storageState?.mode === 'file' ? storageState.path : storageState ? '当前浏览器（尚未设置文件夹）' : '无法读取保存位置，请检查本机服务和存档';
  $('storage-status').textContent = storageState?.mode === 'file' ? `自动保存到：${storageState.path}。原浏览器副本保留，但不再同步更新。` : '未设置文件夹时，资料保存在当前浏览器；清理浏览器数据会丢失资料，请定期备份。';
  $('storage-submit').disabled = locked || busy;
  $('tree-heading').textContent = currentFamily()?.name || '尚未新建家谱';
  renderFamilyTabs(); renderMembers(); renderTree(); renderDetail(); renderRelationship();
}
function renderFamilyTabs() {
  const tabs = $('family-tabs'); tabs.replaceChildren();
  for (const f of library.families) {
    const button = element('button', `button family-tab${f.id === library.activeId ? ' active' : ''}`, `${f.name} · ${f.data.people.length}人`);
    button.type = 'button'; button.disabled = locked; button.title = f.name;
    button.setAttribute('aria-pressed', String(f.id === library.activeId));
    button.addEventListener('click', () => run(async () => {
      if (f.id === library.activeId) return;
      await commitLibrary(selectFamily(library, f.id), `已切换到“${f.name}”。`);
      [...$('family-tabs').children].find(tab => tab.getAttribute('aria-pressed') === 'true')?.focus({ preventScroll: true });
    }));
    tabs.append(button);
  }
  if (!library.families.length) tabs.append(element('span', 'muted small', '暂无家谱，点击右侧新建'));
}
function renderMembers() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const people = data.people.filter(p => [p.name, p.alias, p.notes, p.city].some(value => value.toLocaleLowerCase().includes(query)));
  $('filtered-count').textContent = people.length;
  $('members').replaceChildren();
  for (const p of people) {
    const button = element('button', `member${p.id === selectedId ? ' active' : ''}`);
    button.setAttribute('aria-label', `查看 ${personLabel(p)}`); button.setAttribute('aria-pressed', String(p.id === selectedId));
    const info = element('div'); info.append(element('div', 'name', p.name), element('div', 'subtitle', p.alias || p.birth || '资料待补充'));
    button.append(avatar(p), info); if (data.selfId === p.id) button.append(element('span', 'me', '我'));
    button.addEventListener('click', () => selectPerson(p.id)); $('members').append(button);
  }
  if (!people.length) $('members').append(element('p', 'no-results', query ? '没有找到这位家人' : '还没有成员，先添加一位吧'));
}
function renderRelationship() {
  const from = $('from').value, to = $('to').value;
  const result = $('relationship-result'); result.replaceChildren();
  if (!from || !to) { result.append(element('p', '', '选择两位成员，查看称呼与关系路径。')); return; }
  const a = data.people.find(p => p.id === from), b = data.people.find(p => p.id === to);
  const forward = describeRelationship(data, from, to), backward = describeRelationship(data, to, from);
  for (const [start, end, relationship] of [[a, b, forward], [b, a, backward]]) {
    const direction = element('section', 'relationship-direction');
    direction.setAttribute('aria-label', `${start.name}称呼${end.name}`);
    direction.append(element('h3', '', `${start.name}称呼${end.name}`));
    const line = element('p');
    line.append(element('span', 'daily-label', '日常称呼建议'), element('strong', '', relationship.daily.candidates.join('或') || relationship.daily.title));
    direction.append(line, element('p', 'path', `完整称谓：${relationship.title}`));
    if (relationship.daily.reasons.length) direction.append(element('p', 'path', `建议说明：${relationship.daily.reasons.join('；')}`));
    result.append(direction);
    if (relationship.path.length < 2) continue;
    const details = element('details');
    details.append(element('summary', 'path', `查看 ${relationship.alternatives.length} 条最短关系路径`));
    for (const alternative of relationship.alternatives) {
      const path = alternative.path.map((p, i) => i ? `—${alternative.steps[i - 1].label}→ ${p.name}` : p.name).join(' ');
      details.append(element('div', 'path', path), element('div', 'path', `${alternative.chain} → ${alternative.title}`));
    }
    direction.append(details);
  }
  if (forward.path.length > 1) result.append(element('div', 'path relationship-note', '日常称呼是按普通话习惯简化的建议，不代表实际亲缘更近；配偶方远亲可随配偶称呼，地方和家庭习惯可能不同。并列项是候选，无法可靠判断时建议称姓名。完整称谓与最短关系路径保留，不穷举更长的多重亲缘。'));
}
function renderTree() {
  const svg = $('tree'); svg.replaceChildren();
  $('empty').hidden = data.people.length > 0; svg.hidden = data.people.length === 0;
  $('empty').querySelector('h3').textContent = currentFamily() ? '家谱，从一位家人开始' : '先新建一张家谱';
  $('empty').querySelector('p').textContent = currentFamily() ? '先添加自己，再连接父母、配偶、兄弟姐妹与子女。不确定的资料可以留空。' : '点击上方“新建家谱”，开始记录家人的故事。';
  $('start').hidden = $('demo').hidden = !currentFamily();
  const layout = layoutTree(data); treeSize = layout;
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  const byId = new Map(layout.nodes.map(p => [p.id, p]));
  const defs = svgElement('defs'); svg.append(defs);
  for (const r of data.relations) {
    const a = byId.get(r.from), b = byId.get(r.to);
    let d;
    if (r.type === 'parent') {
      const x1 = a.x + 80, y1 = a.y + 85, x2 = b.x + 80, y2 = b.y;
      d = `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`;
    } else if (r.type === 'sibling') {
      const x1 = a.x + 80, x2 = b.x + 80, y = Math.min(a.y, b.y) - 15;
      d = `M${x1},${a.y} V${y} H${x2} V${b.y}`;
    } else {
      const left = a.x < b.x ? a : b, right = left === a ? b : a;
      const x1 = left.x + 160, y1 = left.y + 43, x2 = right.x, y2 = right.y + 43;
      d = `M${x1},${y1} C${x1 + 18},${y1} ${x2 - 18},${y2} ${x2},${y2}`;
    }
    const edge = svgElement('path', { d, class: `tree-edge${r.type === 'sibling' ? ' sibling' : r.type === 'spouse' ? ' partner' : r.kind !== 'biological' ? ' special' : ''}` });
    if (r.type === 'sibling') edge.append(svgElement('title', {}, `${a.name}与${b.name}：兄弟姐妹`));
    svg.append(edge);
  }
  layout.nodes.forEach((p, index) => {
    const group = svgElement('g', { transform: `translate(${p.x},${p.y})`, class: `tree-node${p.id === selectedId ? ' selected' : ''}`, role: 'button', tabindex: '0', 'aria-label': `查看 ${personLabel(p)}`, 'aria-pressed': String(p.id === selectedId) });
    group.append(svgElement('title', {}, personLabel(p)), svgElement('rect', { width: 160, height: 85, rx: 11, class: 'card' }));
    group.append(svgElement('circle', { cx: 31, cy: 30, r: 17, fill: p.gender === 'female' ? '#f3e7dd' : '#e8efdf' }));
    if (p.photo) {
      const clip = svgElement('clipPath', { id: `avatar-${index}` }); clip.append(svgElement('circle', { cx: 31, cy: 30, r: 17 })); defs.append(clip);
      group.append(svgElement('image', { href: p.photo, x: 14, y: 13, width: 34, height: 34, preserveAspectRatio: 'xMidYMid slice', 'clip-path': `url(#avatar-${index})` }));
    } else group.append(svgElement('text', { x: 31, y: 36, 'text-anchor': 'middle', fill: '#8e9d7d', 'font-size': 16 }, p.name.slice(0, 1)));
    group.append(svgElement('text', { x: 56, y: 29, class: 'node-name' }, p.name.length > 6 ? p.name.slice(0, 5) + '…' : p.name));
    group.append(svgElement('text', { x: 56, y: 46, class: 'node-caption' }, p.birth ? `${p.birth.slice(0, 4)}${p.death ? ` — ${p.death.slice(0, 4)}` : ' 年生'}` : '生年待补充'));
    group.append(svgElement('text', { x: 15, y: 70, class: 'node-caption' }, p.id === data.selfId ? '● 我 · 当前视角' : (p.alias || (p.gender === 'male' ? '男' : p.gender === 'female' ? '女' : '性别待补充')).slice(0, 14)));
    group.addEventListener('click', () => selectPerson(p.id));
    group.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); selectPerson(p.id); } });
    svg.append(group);
  });
  applyZoom();
}
function applyZoom() { $('tree').style.width = `${treeSize.width * scale}px`; $('tree').style.height = `${treeSize.height * scale}px`; $('zoom-level').value = `${Math.round(scale * 100)}%`; }
function fitTree() { scale = Math.min(1.2, Math.max(.2, ($('tree-viewport').clientWidth - 20) / treeSize.width)); applyZoom(); $('tree-viewport').scrollTo(0, 0); }
function renderDetail() {
  const p = data.people.find(p => p.id === selectedId), detail = $('detail'); detail.replaceChildren();
  if (!p) { const box = element('div', 'detail-placeholder'); box.append(element('span', '', '◇'), element('h2', '', '每个人，都有自己的故事'), element('p', '', '从家谱或成员列表中选择一位家人。')); detail.append(box); return; }
  const top = element('div', 'detail-top'); top.append(element('p', 'eyebrow', 'FAMILY PROFILE'), avatar(p, true), element('h2', '', p.name), element('div', 'alias', p.alias || '家族成员'));
  if (data.selfId) {
    const relationship = describeRelationship(data, data.selfId, p.id);
    top.append(element('span', 'relation-chip', `你称呼 TA（日常建议）：${relationship.daily.candidates.join('或') || relationship.daily.title}`), element('p', 'path', `完整称谓：${relationship.title}`));
    if (relationship.daily.reasons.length) top.append(element('p', 'path', `建议说明：${relationship.daily.reasons.join('；')}`));
  }
  const body = element('div', 'detail-body'), dl = element('dl');
  const parents = data.relations.filter(r => r.type === 'parent' && r.to === p.id).map(r => `${data.people.find(x => x.id === r.from).name}（${{ biological: '亲生', adoptive: '收养', step: '继亲' }[r.kind]}）`).join('、');
  const siblings = siblingsOf(data, p.id).map(link => `${data.people.find(x => x.id === link.id).name}（${describeRelationship(data, p.id, link.id).title}）`).join('、');
  for (const [label, value] of [['出生', p.birth], ['去世', p.death], ['籍贯 / 城市', p.city], ['职业', p.occupation], ['父母', parents], ['兄弟姐妹', siblings]]) { dl.append(element('dt', '', label), element('dd', '', value || '未记录')); }
  const notes = element('div', 'detail-notes'); notes.append(element('h3', '', '备注与故事'), element('p', '', p.notes || '还没有故事。可以从一次家庭聚会记起。'));
  const actions = element('div', 'detail-actions');
  const edit = element('button', 'button primary', '编辑资料'); edit.disabled = locked; edit.addEventListener('click', () => openEditor(p.id));
  const self = element('button', 'button subtle', data.selfId === p.id ? '这就是我' : '设为本人'); self.disabled = locked || data.selfId === p.id; self.addEventListener('click', () => run(async () => { await commit({ ...data, selfId: p.id }, '已更新“我是谁”，称呼将从你的角度显示。'); $('from').value = p.id; renderRelationship(); }));
  actions.append(edit, self); body.append(dl, notes, actions); detail.append(top, body);
}

function addParentRow(id = '', kind = 'biological') {
  const row = element('div', 'parent-row'), member = element('select'), type = element('select');
  member.setAttribute('aria-label', '选择父母成员'); fillSelect(member, id, editingId, '选择已录入的成员');
  type.setAttribute('aria-label', '父母关系类型');
  for (const [value, label] of [['biological', '亲生'], ['adoptive', '收养'], ['step', '继亲']]) type.append(new Option(label, value));
  type.value = kind;
  const remove = element('button', 'button subtle', '×'); remove.type = 'button'; remove.setAttribute('aria-label', '移除此父母关系'); remove.addEventListener('click', () => row.remove());
  row.append(member, type, remove); $('parent-rows').append(row);
}
function previewPhoto() {
  const p = { name: $('person-form').elements.name.value || '人', gender: $('person-form').elements.gender.value, photo: editingPhoto };
  $('photo-preview').replaceChildren(...avatar(p, true).childNodes);
}
function openEditor(id = '') {
  if (locked || !currentFamily()) return;
  editingFamilyId = library.activeId; editingSnapshot = savedText;
  editingId = id; photoToken++; $('person-form').reset(); $('form-error').hidden = true; $('save-person').disabled = false;
  const p = data.people.find(p => p.id === id);
  for (const field of ['name', 'alias', 'gender', 'birth', 'death', 'city', 'occupation', 'notes']) $('person-form').elements[field].value = p?.[field] || (field === 'gender' ? 'unknown' : '');
  editingPhoto = p?.photo || ''; previewPhoto();
  $('editor-title').textContent = p ? '编辑成员' : '添加成员'; $('delete-person').hidden = !p;
  $('parent-rows').replaceChildren();
  const parents = data.relations.filter(r => r.type === 'parent' && r.to === id);
  if (!parents.length) addParentRow(); else parents.forEach(r => addParentRow(r.from, r.kind));
  fillSelect($('partners'), '', id);
  const partnerIds = data.relations.filter(r => r.type === 'spouse' && (r.from === id || r.to === id)).map(r => r.from === id ? r.to : r.from);
  for (const option of $('partners').options) option.selected = partnerIds.includes(option.value);
  fillSelect($('siblings'), '', id);
  const siblings = siblingsOf(data, id);
  for (const option of $('siblings').options) option.selected = siblings.some(link => link.id === option.value && link.manual);
  const inferred = siblings.filter(link => link.automatic).map(link => personLabel(data.people.find(p => p.id === link.id)));
  $('inferred-siblings').textContent = `共同亲生父母识别：${inferred.join('、') || '暂无'}。这部分关系随父母资料更新，不通过下方取消。`;
  $('editor').showModal(); $('person-form').elements.name.focus();
}
function closeEditor() { photoToken++; $('editor').close(); }
function assertEditorCurrent() {
  if (!editingFamilyId || library.activeId !== editingFamilyId || savedText !== editingSnapshot) throw new Error('编辑期间家谱已切换或更改，请关闭后重新打开成员资料');
}
$('person-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('save-person').disabled) return;
  try {
    assertEditorCurrent();
    const id = editingId || crypto.randomUUID();
    const person = { id, photo: editingPhoto };
    for (const field of ['name', 'alias', 'gender', 'birth', 'death', 'city', 'occupation', 'notes']) person[field] = $('person-form').elements[field].value;
    const people = editingId ? data.people.map(p => p.id === id ? person : p) : [...data.people, person];
    const relations = data.relations.filter(r => !(r.type === 'parent' && r.to === id) && !(['spouse', 'sibling'].includes(r.type) && (r.from === id || r.to === id)));
    for (const row of $('parent-rows').children) { const [parent, type] = row.querySelectorAll('select'); if (parent.value) relations.push({ from: parent.value, to: id, type: 'parent', kind: type.value }); }
    for (const option of $('partners').selectedOptions) relations.push({ from: id, to: option.value, type: 'spouse' });
    for (const option of $('siblings').selectedOptions) relations.push({ from: id, to: option.value, type: 'sibling' });
    let next = validateData({ ...data, people, relations });
    const parents = next.relations.filter(r => r.type === 'parent' && r.to === id);
    const addedParents = parents.filter(r => !data.relations.some(old => old.type === 'parent' && old.from === r.from && old.to === r.to));
    const checkedPairs = new Set();
    for (const added of addedParents) for (const other of parents) {
      if (added.from === other.from) continue;
      const pair = [added.from, other.from].sort(), key = JSON.stringify(pair);
      if (checkedPairs.has(key)) continue;
      checkedPairs.add(key);
      if (next.relations.some(r => r.type === 'spouse' && r.from === pair[0] && r.to === pair[1])) continue;
      let linked;
      // Never offer a spouse link that violates existing family validation.
      try { linked = validateData({ ...next, relations: [...next.relations, { from: pair[0], to: pair[1], type: 'spouse' }] }); }
      catch { continue; }
      const labels = [added, other].map(r => `“${next.people.find(p => p.id === r.from).name}”（${{ biological: '亲生', adoptive: '收养', step: '继亲' }[r.kind]}）`);
      if (confirm(`${labels.join('与')}都已关联为“${person.name}”的家长。是否同时将两位设为当前配偶？\n\n确定：同时建立配偶关系。\n取消：仅保存父母关系。\n共同有子女不代表当前仍是配偶；已离异或不确定时请选择取消。`)) next = linked;
    }
    $('save-person').disabled = true;
    await commit(next, '成员资料已保存到当前浏览器。记得定期导出备份。'); closeEditor(); selectPerson(id);
  } catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; }
  finally { $('save-person').disabled = false; }
});
$('photo-file').addEventListener('change', async () => {
  const file = $('photo-file').files[0]; if (!file) return;
  const token = ++photoToken; $('save-person').disabled = true;
  let url;
  try {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10_000_000) throw new Error('请选择 10 MB 以内的 JPG、PNG 或 WebP 图片');
    url = URL.createObjectURL(file); const image = new Image(); image.src = url; await image.decode();
    if (token !== photoToken) return;
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d'); const side = Math.min(image.width, image.height);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 256, 256); ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 256, 256);
    editingPhoto = canvas.toDataURL('image/jpeg', .8); previewPhoto(); $('form-error').hidden = true;
  } catch (error) { if (token === photoToken) { $('form-error').textContent = `照片读取失败：${error.message}`; $('form-error').hidden = false; } }
  finally { if (url) URL.revokeObjectURL(url); if (token === photoToken) $('save-person').disabled = false; }
});
$('remove-photo').addEventListener('click', () => { photoToken++; editingPhoto = ''; $('photo-file').value = ''; $('save-person').disabled = false; previewPhoto(); });
$('delete-person').addEventListener('click', async () => {
  try {
    assertEditorCurrent();
    const p = data.people.find(p => p.id === editingId);
    if (!p || !confirm(`删除“${p.name}”及其亲属连线？其他成员会保留。此操作无法撤销，建议先导出备份。`)) return;
    await commit(removePerson(data, editingId), '成员与相关连线已删除，其他成员未受影响。'); closeEditor();
  } catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; }
});

function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = element('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('export').addEventListener('click', () => run(() => {
  if (!ready) return;
  if (locked && storageState?.mode !== 'file') {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) throw new Error('本机没有可导出的原始存档');
    download(raw, `家谱-全部原始存档-${new Date().toISOString().slice(0, 10)}.json`);
    showNotice('已下载当前浏览器保留的原始副本，用于资料抢救；它不代表指定文件夹的最新资料，也可能不是可直接恢复的单张家谱备份。');
    return;
  }
  if (!currentFamily()) return;
  const name = currentFamily().name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  download(JSON.stringify(data), `${name}-备份-${new Date().toISOString().slice(0, 10)}.json`);
  showNotice(`已导出“${currentFamily().name}”，不包含其他家谱。文件含人物资料和照片，请保存在可信的位置。`);
}));
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0]; if (!file) return;
  const targetId = library.activeId, snapshot = savedText;
  try {
    const next = await parseBackupFile(file);
    if (locked || !targetId || library.activeId !== targetId || savedText !== snapshot) throw new Error('读取文件期间家谱已切换或更改，请重新选择备份');
    if (!confirm(`备份包含 ${next.people.length} 位成员、${next.relations.length} 条关系。恢复仅替换“${currentFamily().name}”，不会合并，不影响其他家谱。请确认已备份当前资料。继续？`)) return;
    await commit(next, `已恢复 ${next.people.length} 位家人的资料，其他家谱未改动。`); selectedId = data.selfId || data.people[0]?.id || ''; render(); fitTree();
  } catch (error) { showNotice(`恢复失败：${error.message}`, true); }
  finally { $('import-file').value = ''; }
});
$('demo').addEventListener('click', () => run(async () => { if (data.people.length || !currentFamily()) return; await commit(demoFamily(), '已载入虚构的示例家谱并保存到本机。可新建另一张家谱记录真实家人，不必删除示例。'); selectedId = data.selfId; render(); fitTree(); }));
function openFamilyName(id = '') {
  if (locked) return;
  namingId = id;
  $('family-name-title').textContent = id ? '重命名家谱' : '新建家谱';
  $('family-name').value = id ? currentFamily().name : '新家谱';
  $('family-name-error').hidden = true;
  $('family-name-dialog').showModal(); $('family-name').select();
}
$('new-family').addEventListener('click', () => openFamilyName());
$('rename-family').addEventListener('click', () => { if (currentFamily()) openFamilyName(library.activeId); });
$('cancel-family-name').addEventListener('click', () => $('family-name-dialog').close());
$('family-name-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const name = $('family-name').value;
    const next = namingId ? renameFamily(library, namingId, name) : addFamily(library, name, crypto.randomUUID());
    await commitLibrary(next, namingId ? '家谱名称已更新。' : '已新建独立家谱，原有资料完整保留。');
    $('family-name-dialog').close();
  } catch (error) { $('family-name-error').textContent = error.message; $('family-name-error').hidden = false; }
});
$('delete-family').addEventListener('click', () => run(async () => {
  if (locked || !currentFamily()) return;
  const { id, name } = currentFamily();
  if (!confirm(`删除家谱“${name}”及其中 ${data.people.length} 位成员的全部资料？其他家谱会保留。此操作无法撤销，请先导出备份。`)) return;
  await commitLibrary(deleteFamily(library, id), `已删除“${name}”，其他家谱未受影响。`);
}));
$('add').addEventListener('click', () => openEditor()); $('start').addEventListener('click', () => openEditor());
$('close-editor').addEventListener('click', closeEditor); $('cancel-editor').addEventListener('click', closeEditor);
$('editor').addEventListener('cancel', () => { photoToken++; });
$('add-parent').addEventListener('click', () => addParentRow());
$('self').addEventListener('change', () => run(async () => { const selfId = $('self').value; await commit({ ...data, selfId }, selfId ? '已设置本人视角。' : '已取消本人视角。'); $('from').value = selfId; renderRelationship(); }));
$('from').addEventListener('change', renderRelationship); $('to').addEventListener('change', renderRelationship);
$('swap').addEventListener('click', () => { const from = $('from').value; $('from').value = $('to').value; $('to').value = from; renderRelationship(); });
$('search').addEventListener('input', renderMembers);
$('zoom-in').addEventListener('click', () => { scale = Math.min(2, scale + .1); applyZoom(); });
$('zoom-out').addEventListener('click', () => { scale = Math.max(.2, scale - .1); applyZoom(); });
$('fit').addEventListener('click', fitTree);
$('storage-settings').addEventListener('click', () => {
  $('storage-directory').value = storageState?.mode === 'file' ? storageState.path.replace(/[\\/][^\\/]+$/, '') : '';
  $('storage-error').hidden = true; $('storage-dialog').showModal();
});
$('cancel-storage').addEventListener('click', () => { if (!changingLocation) $('storage-dialog').close(); });
$('storage-dialog').addEventListener('cancel', event => { if (changingLocation) event.preventDefault(); });
$('storage-form').addEventListener('submit', async event => {
  event.preventDefault(); if (changingLocation) return;
  const snapshot = savedText, state = storageState, next = library, directory = $('storage-directory').value.trim();
  changingLocation = true; $('storage-error').hidden = true; $('cancel-storage').disabled = true; render();
  try {
    const select = async () => {
      assertWritable();
      if (savedText !== snapshot || storageState !== state || (state.mode === 'browser' && storage.getItem(STORAGE_KEY) !== snapshot)) throw new Error('资料已在其他页面更改，请刷新后再设置保存位置');
      const body = { directory, library: next, revision: state.revision };
      try { return await storageRequest('POST', body, '/location'); }
      catch (error) {
        if (error.code !== 'TARGET_EXISTS') throw error;
        if (!confirm('目标文件夹已有家谱存档。是否打开现有存档？不会合并或覆盖目标文件；当前浏览器副本或原文件夹资料也会保留。取消则不更改保存位置。')) return;
        return storageRequest('POST', { ...body, openExisting: true, targetRevision: error.targetRevision }, '/location');
      }
    };
    assertWritable();
    if (saving) throw new Error('正在保存，请等待当前保存完成后再更改位置');
    if (state.mode === 'browser' && !navigator.locks?.request) throw new Error('浏览器不支持安全迁移，请使用新版浏览器并通过 localhost 打开');
    const saved = state.mode === 'browser' ? await navigator.locks.request(STORAGE_KEY, select) : await select();
    if (saved) {
      storageState = saved;
      applyLibrary(saved.library, saved.revision, '保存位置已设置。所有家谱的后续修改将自动保存到该文件夹，原位置资料保留。', true);
      $('storage-dialog').close();
    }
  } catch (error) { $('storage-error').textContent = error.message; $('storage-error').hidden = false; }
  finally { changingLocation = false; $('cancel-storage').disabled = false; render(); }
});
window.addEventListener('storage', event => { if (storageState?.mode !== 'file' && (event.key === STORAGE_KEY || event.key === null) && event.storageArea === storage) { locked = true; render(); showNotice('其他页面更新或清除了家谱。请刷新此页再继续，避免覆盖资料。', true); } });
render();
const startup = initializeStorage();
