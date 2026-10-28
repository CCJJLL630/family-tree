import test from 'node:test';
import assert from 'node:assert/strict';
import * as family from '../src/family.js';

const person = (id, gender = 'unknown', birth = '') => ({ id, name: id, gender, birth });
const parent = (from, to, kind = 'biological') => ({ from, to, type: 'parent', kind });
const spouse = (from, to) => ({ from, to, type: 'spouse' });
const fixture = () => ({ version: 1, selfId: 'me', people: [person('me', 'male', '2000-06'), person('dad', 'male', '1970'), person('mom', 'female', '1972'), person('grandpa', 'male', '1940'), person('uncle', 'male', '1968'), person('cousin', 'female', '1998'), person('brother', 'male', '2004')], relations: [parent('dad', 'me'), parent('mom', 'me'), spouse('dad', 'mom'), parent('grandpa', 'dad'), parent('grandpa', 'uncle'), parent('uncle', 'cousin'), parent('dad', 'brother'), parent('mom', 'brother')] });

// These cases catch guessing, reversed kinship, broken links, and destructive persistence.
test('returns directional parent and grandparent titles', () => {
  assert.equal(family.describeRelationship?.(fixture(), 'me', 'dad')?.title, '爸爸');
  assert.equal(family.describeRelationship(fixture(), 'dad', 'me').title, '儿子');
  assert.equal(family.describeRelationship(fixture(), 'me', 'grandpa').title, '爷爷');
});
test('distinguishes paternal uncle and paternal parallel cousin', () => {
  assert.equal(family.describeRelationship?.(fixture(), 'me', 'uncle')?.title, '伯父');
  assert.equal(family.describeRelationship(fixture(), 'me', 'cousin').title, '堂姐');
});
test('uses maternal line for cousin and uncle titles', () => {
  const data = fixture();
  data.relations = data.relations.filter(r => !(r.from === 'grandpa' && r.to === 'dad'));
  data.relations.push(parent('grandpa', 'mom'));
  assert.equal(family.describeRelationship?.(data, 'me', 'uncle')?.title, '舅舅');
  assert.equal(family.describeRelationship(data, 'me', 'cousin').title, '表姐');
});
test('does not guess seniority with missing or overlapping partial dates', () => {
  const data = fixture();
  data.people.find(p => p.id === 'me').birth = '2004';
  assert.equal(family.describeRelationship?.(data, 'me', 'brother')?.title, '哥哥或弟弟（长幼待确认）');
});
test('does not silently classify non-biological or unknown-sex links', () => {
  const data = fixture();
  data.relations[0].kind = 'adoptive';
  assert.match(family.describeRelationship?.(data, 'me', 'dad')?.title ?? '', /收养.*确认/);
  data.relations[0].kind = 'biological'; data.people[1].gender = 'unknown';
  assert.equal(family.describeRelationship(data, 'me', 'dad').title, '爸爸或妈妈（性别待确认）');
});
test('returns self, disconnected and explanatory paths', () => {
  const data = fixture(); data.people.push(person('stranger'));
  assert.equal(family.describeRelationship?.(data, 'me', 'me')?.title, '本人');
  assert.equal(family.describeRelationship(data, 'me', 'stranger').title, '尚未找到亲属关系');
  assert.deepEqual(family.describeRelationship(data, 'me', 'grandpa').path.map(p => p.id), ['me', 'dad', 'grandpa']);
});
test('validates and roundtrips a backup without dropping notes', () => {
  const data = fixture(); data.people[0].notes = '<script>test</script>\n家族故事';
  assert.equal(typeof family.validateData, 'function');
  const clean = family.validateData(data);
  assert.deepEqual(family.parseBackup(JSON.stringify(clean)), clean);
  assert.equal(clean.people[0].notes, data.people[0].notes);
});
test('rejects duplicate identifiers, missing links, invalid self and ancestral cycles', () => {
  assert.equal(typeof family.validateData, 'function');
  for (const mutate of [d => d.people.push(person('me')), d => d.relations.push(parent('ghost', 'me')), d => d.selfId = 'ghost', d => d.relations.push(parent('me', 'grandpa')), d => d.relations.push(spouse('grandpa', 'me'))]) {
    const data = fixture(); mutate(data); assert.throws(() => family.validateData(data));
  }
});
test('rejects invalid dates, death before birth and unsafe photos', () => {
  assert.equal(typeof family.validateData, 'function');
  for (const fields of [{ birth: '2001-02-29' }, { birth: '2020', death: '2019' }, { birth: '2020-13' }, { photo: 'https://example.com/private.jpg' }, { photo: 'data:image/svg+xml;base64,PHN2Zz4=' }]) {
    const data = fixture(); Object.assign(data.people[0], fields); assert.throws(() => family.validateData(data));
  }
});
test('deleting a person removes incident relationships and self selection only', () => {
  assert.equal(typeof family.removePerson, 'function');
  const data = fixture(); const next = family.removePerson(data, 'me');
  assert.equal(next.people.length, 6); assert.equal(next.selfId, '');
  assert.ok(next.relations.every(r => r.from !== 'me' && r.to !== 'me'));
  assert.equal(data.people.length, 7);
});
test('a failed storage write leaves the previous saved family untouched', () => {
  assert.equal(typeof family.saveData, 'function');
  const storage = { value: 'old', getItem() { return this.value; }, setItem() { throw new Error('QuotaExceededError'); } };
  assert.throws(() => family.saveData(storage, fixture()), /存储/);
  assert.equal(storage.value, 'old');
});
test('corrupt stored data surfaces an error rather than silently resetting', () => {
  assert.equal(typeof family.loadData, 'function');
  assert.throws(() => family.loadData({ getItem: () => '{invalid' }), /备份|损坏/);
  assert.deepEqual(family.loadData({ getItem: () => null }), { version: 1, selfId: '', people: [], relations: [] });
});
test('Chinese backup files larger than 5 MB remain restorable after a successful save', async () => {
  assert.equal(typeof family.parseBackupFile, 'function');
  const data = { version: 1, selfId: '', relations: [], people: Array.from({ length: 360 }, (_, i) => ({ ...person(`p${i}`), notes: '家'.repeat(5000) })) };
  const storage = { value: null, setItem(key, value) { this.value = value; }, getItem() { return this.value; } };
  family.saveData(storage, data);
  const file = new Blob([storage.value]);
  assert.ok(file.size > 5_000_000);
  const restored = await family.parseBackupFile(file);
  assert.equal(restored.people.length, 360);
  assert.equal(restored.people[359].notes, '家'.repeat(5000));
});
test('byte limits are identical for saving and reading a file', async () => {
  assert.equal(typeof family.parseBackupFile, 'function');
  const data = { version: 1, selfId: '', relations: [], people: Array.from({ length: 100 }, (_, i) => ({ ...person(`p${i}`), photo: 'data:image/jpeg;base64,' + 'A'.repeat(180000) })) };
  const text = JSON.stringify(data), storage = { setItem() { throw new Error('should not write oversized data'); } };
  assert.throws(() => family.saveData(storage, data), /容量|过大/);
  assert.throws(() => family.parseBackup(text), /过大/);
  await assert.rejects(family.parseBackupFile(new Blob([text])), /过大/);
});
test('queued stale writes cannot overwrite a newer family from another tab', async () => {
  assert.equal(typeof family.saveIfUnchanged, 'function');
  let tail = Promise.resolve();
  const locks = { request(name, fn) { const next = tail.then(fn); tail = next.catch(() => {}); return next; } };
  const storage = { value: null, getItem() { return this.value; }, setItem(key, value) { this.value = value; } };
  const a = fixture(), b = fixture(); a.people[0].notes = 'first tab'; b.people[0].notes = 'stale tab';
  const results = await Promise.allSettled([family.saveIfUnchanged(storage, a, null, locks), family.saveIfUnchanged(storage, b, null, locks)]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /其他页面/);
  assert.equal(JSON.parse(storage.value).people[0].notes, 'first tab');
  const next = fixture(); next.people[0].notes = 'after refresh';
  await family.saveIfUnchanged(storage, next, storage.value, locks);
  assert.equal(JSON.parse(storage.value).people[0].notes, 'after refresh');
});
test('refuses unsafe saving when browser cross-tab locks are unavailable', async () => {
  assert.equal(typeof family.saveIfUnchanged, 'function');
  await assert.rejects(family.saveIfUnchanged({}, fixture(), null, null), /浏览器/);
});
test('layout includes every member once with parents above children', () => {
  assert.equal(typeof family.layoutTree, 'function');
  const result = family.layoutTree(fixture());
  assert.equal(result.nodes.length, 7);
  assert.equal(new Set(result.nodes.map(n => n.id)).size, 7);
  for (const r of fixture().relations.filter(r => r.type === 'parent')) {
    assert.ok(result.nodes.find(n => n.id === r.from).y < result.nodes.find(n => n.id === r.to).y);
  }
});
