import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY, emptyFamily, saveIfUnchanged, parseBackup } from '../src/family.js';

const mod = await import('../src/library.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const storageWith = value => ({ value, getItem(key) { assert.equal(key, STORAGE_KEY); return this.value; }, setItem(key, text) { assert.equal(key, STORAGE_KEY); this.value = text; } });
const queuedLocks = () => { let tail = Promise.resolve(); return { request(name, fn) { assert.equal(name, STORAGE_KEY); const next = tail.then(fn); tail = next.catch(() => {}); return next; } }; };
const populated = () => ({ ...emptyFamily(), selfId: 'me', people: [{ id: 'me', name: '原有成员', gender: 'unknown', notes: '不能丢失的记录' }] });

function library() {
  assert.equal(typeof mod.readLibrary, 'function');
  return mod.readLibrary(JSON.stringify(populated()));
}

test('legacy records load as one named family without modifying their data', () => {
  const result = library();
  assert.equal(result.version, 2);
  assert.equal(result.families.length, 1);
  assert.equal(result.families[0].name, '我的家谱');
  assert.equal(result.activeId, result.families[0].id);
  assert.deepEqual(result.families[0].data, parseBackup(JSON.stringify(populated())));
  assert.deepEqual(mod.readLibrary(null).families[0].data, emptyFamily());
});

test('adding, selecting and renaming families never clears another family', () => {
  const original = library(), firstId = original.activeId;
  const next = mod.addFamily(original, '另一张家谱', 'second');
  assert.equal(next.activeId, 'second');
  assert.equal(next.families.length, 2);
  assert.deepEqual(next.families[0], original.families[0]);
  assert.deepEqual(next.families[1].data, emptyFamily());
  const selected = mod.selectFamily(next, firstId);
  const renamed = mod.renameFamily(selected, 'second', '新的名称');
  assert.equal(renamed.activeId, firstId);
  assert.equal(renamed.families[1].name, '新的名称');
  assert.deepEqual(renamed.families[0].data, original.families[0].data);
  assert.equal(original.families.length, 1);
  assert.equal(next.families[1].name, '另一张家谱');
});

test('editing or restoring the active family preserves all other families even with matching person IDs', () => {
  const original = library();
  const two = mod.addFamily(original, '第二张', 'second');
  const imported = populated(); imported.people[0].name = '同编号的另一人';
  const updated = mod.replaceFamily(two, 'second', imported);
  assert.equal(updated.families[0].data.people[0].name, '原有成员');
  assert.equal(updated.families[1].data.people[0].name, '同编号的另一人');
  assert.deepEqual(parseBackup(JSON.stringify(updated.families[1].data)), updated.families[1].data);
});

test('deleting a selected or unselected family preserves remaining records and permits an empty library', () => {
  const original = library(), firstId = original.activeId;
  const two = mod.addFamily(original, '第二张', 'second');
  const removed = mod.deleteFamily(two, 'second');
  assert.equal(removed.activeId, firstId);
  assert.deepEqual(removed.families, original.families);
  assert.equal(mod.deleteFamily(two, firstId).activeId, 'second');
  const empty = mod.deleteFamily(removed, firstId);
  assert.deepEqual(empty, { version: 2, activeId: '', families: [] });
  assert.deepEqual(mod.readLibrary(JSON.stringify(empty)), empty);
  assert.equal(mod.addFamily(empty, '重新开始', 'new').activeId, 'new');
});

test('invalid names, duplicate family IDs, missing selections and corrupt libraries are rejected', () => {
  const original = library();
  assert.throws(() => mod.addFamily(original, '  ', 'new'));
  assert.throws(() => mod.addFamily(original, 'a'.repeat(61), 'new'));
  assert.throws(() => mod.addFamily(original, 'duplicate', original.activeId));
  assert.throws(() => mod.selectFamily(original, 'missing'));
  assert.throws(() => mod.renameFamily(original, 'missing', '新名称'));
  assert.throws(() => mod.replaceFamily(original, 'missing', emptyFamily()));
  assert.throws(() => mod.deleteFamily(original, 'missing'));
  for (const text of ['{bad', JSON.stringify({ ...original, activeId: 'missing' }), JSON.stringify({ ...original, families: [{ ...original.families[0], data: {} }] }), JSON.stringify({ ...original, families: [...original.families, original.families[0]] })]) assert.throws(() => mod.readLibrary(text));
});

test('migration is one atomic write and old single-family tabs cannot overwrite it', async () => {
  const text = JSON.stringify(populated()), storage = storageWith(text), locks = queuedLocks();
  const next = mod.addFamily(library(), '第二张', 'second');
  const saved = await mod.saveLibraryIfUnchanged(storage, next, text, locks);
  assert.equal(saved.library.families.length, 2);
  assert.equal(storage.value, saved.text);
  assert.deepEqual(mod.readLibrary(storage.value), saved.library);
  await assert.rejects(saveIfUnchanged(storage, emptyFamily(), text, locks), /其他页面/);
  assert.equal(storage.value, saved.text);
});

test('quota failure during migration keeps the complete legacy record', async () => {
  const text = JSON.stringify(populated()), storage = storageWith(text);
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const next = mod.addFamily(library(), '第二张', 'second');
  await assert.rejects(mod.saveLibraryIfUnchanged(storage, next, text, queuedLocks()), /未保存|存储/);
  assert.equal(storage.value, text);
});

test('combined library size is checked before replacing saved data', async () => {
  const original = library(), firstId = original.activeId;
  const large = { ...emptyFamily(), people: Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: '成员', gender: 'unknown', photo: 'data:image/jpeg;base64,' + 'A'.repeat(190000) })) };
  let next = mod.replaceFamily(original, firstId, large);
  next = mod.addFamily(next, '第二张', 'second');
  next = mod.replaceFamily(next, 'second', large);
  const text = JSON.stringify(original), storage = storageWith(text);
  await assert.rejects(mod.saveLibraryIfUnchanged(storage, next, text, queuedLocks()), /容量|过大/);
  assert.equal(storage.value, text);
  assert.throws(() => mod.readLibrary(JSON.stringify(next)), /容量|过大/);
});

test('stale library writes and unavailable Web Locks cannot overwrite saved families', async () => {
  const original = library(), text = JSON.stringify(original), storage = storageWith(text), locks = queuedLocks();
  const results = await Promise.allSettled([
    mod.saveLibraryIfUnchanged(storage, mod.addFamily(original, '甲', 'a'), text, locks),
    mod.saveLibraryIfUnchanged(storage, mod.addFamily(original, '乙', 'b'), text, locks),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(mod.readLibrary(storage.value).families[1].name, '甲');
  await assert.rejects(mod.saveLibraryIfUnchanged(storage, original, storage.value, null), /浏览器/);
});
