import { STORAGE_KEY, MAX_BACKUP_BYTES, emptyFamily, validateData } from './family.js';

function validateLibrary(input) {
  if (!input || input.version !== 2 || !Array.isArray(input.families)) throw new Error('不是受支持的多家谱存档');
  const ids = new Set();
  const families = input.families.map(f => {
    if (!f || typeof f.id !== 'string' || !f.id || f.id.length > 100 || ids.has(f.id)) throw new Error('家谱编号缺失或重复');
    if (typeof f.name !== 'string' || !f.name.trim() || f.name.trim().length > 60) throw new Error('家谱名称请填写 1–60 个字符');
    ids.add(f.id);
    return { id: f.id, name: f.name.trim(), data: validateData(f.data) };
  });
  if (typeof input.activeId !== 'string' || (families.length ? !ids.has(input.activeId) : input.activeId !== '')) throw new Error('当前家谱指向不存在的标签');
  return { version: 2, activeId: input.activeId, families };
}
function checkSize(text) {
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('全部家谱合计超过存档容量（15 MB），请减少照片或先备份再删除不需要的家谱');
}
export function readLibrary(text) {
  let input;
  if (text === null) input = emptyFamily();
  else {
    if (typeof text !== 'string') throw new Error('本机存档格式错误');
    checkSize(text);
    try { input = JSON.parse(text); } catch { throw new Error('本机存档损坏，请先导出原始备份，不要清除浏览器数据'); }
  }
  if (input?.version === 1) {
    input = { version: 2, activeId: 'family-1', families: [{ id: 'family-1', name: '我的家谱', data: validateData(input) }] };
  }
  return validateLibrary(input);
}
function requireFamily(library, id) {
  if (!library.families.some(f => f.id === id)) throw new Error('家谱不存在，请重新选择');
}
export function addFamily(library, name, id) {
  return validateLibrary({ ...library, activeId: id, families: [...library.families, { id, name, data: emptyFamily() }] });
}
export function selectFamily(library, id) {
  requireFamily(library, id);
  return validateLibrary({ ...library, activeId: id });
}
export function renameFamily(library, id, name) {
  requireFamily(library, id);
  return validateLibrary({ ...library, families: library.families.map(f => f.id === id ? { ...f, name } : f) });
}
export function replaceFamily(library, id, data) {
  requireFamily(library, id);
  return validateLibrary({ ...library, families: library.families.map(f => f.id === id ? { ...f, data } : f) });
}
export function deleteFamily(library, id) {
  requireFamily(library, id);
  const families = library.families.filter(f => f.id !== id);
  return validateLibrary({ ...library, families, activeId: library.activeId === id ? families[0]?.id || '' : library.activeId });
}
export async function saveLibraryIfUnchanged(storage, library, expectedText, locks, beforeWrite) {
  if (!locks?.request) throw new Error('浏览器不支持安全的跨页面保存，请使用新版浏览器并通过 localhost 或 HTTPS 打开');
  // Reuse the old lock and storage key so already-open single-family pages cannot overwrite migration.
  return locks.request(STORAGE_KEY, async () => {
    if (beforeWrite) await beforeWrite();
    if (storage.getItem(STORAGE_KEY) !== expectedText) throw new Error('家谱已在其他页面修改。请刷新后再编辑，以免覆盖更新');
    const clean = validateLibrary(library), text = JSON.stringify(clean);
    checkSize(text);
    try { storage.setItem(STORAGE_KEY, text); } catch { throw new Error('本机存储不足或不可用，未保存本次修改；请备份并减少照片'); }
    return { library: clean, text };
  });
}
