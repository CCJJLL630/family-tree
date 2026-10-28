import test from 'node:test';
import assert from 'node:assert/strict';
import * as family from '../src/family.js';

const person = (id, gender = 'unknown', birth = '') => ({ id, name: id, gender, birth });
const sibling = (from, to) => ({ from, to, type: 'sibling' });
const parent = (from, to) => ({ from, to, type: 'parent', kind: 'biological' });
const fixture = () => ({ version: 1, selfId: 'a', people: [person('a', 'male', '2000'), person('b', 'female', '1995')], relations: [sibling('b', 'a')] });

test('manual siblings persist in backups without inventing parents and are removed with a person', async () => {
  const storage = { value: null, setItem(key, value) { this.value = value; }, getItem() { return this.value; } };
  const saved = family.saveData(storage, fixture());
  assert.equal(saved.people.length, 2);
  assert.deepEqual(saved.relations, [sibling('a', 'b')]);
  const restored = await family.parseBackupFile(new Blob([storage.value]));
  assert.deepEqual(restored, saved);
  assert.deepEqual(family.loadData(storage), saved);
  const removed = family.removePerson(saved, 'b');
  assert.deepEqual(removed.relations, []);
  assert.deepEqual(removed.people.map(p => p.id), ['a']);
});

test('manual siblings have directional titles without any parent records', () => {
  const data = fixture();
  assert.equal(family.describeRelationship(data, 'a', 'b').title, '姐姐');
  assert.equal(family.describeRelationship(data, 'b', 'a').title, '弟弟');
  assert.deepEqual(family.describeRelationship(data, 'a', 'b').steps.map(s => s.label), ['兄弟姐妹']);
  assert.equal(family.describeRelationship(data, 'a', 'b').steps[0].kind, 'manual');
  for (const [gender, birth, expected] of [
    ['male', '1995', '哥哥'], ['male', '2005', '弟弟'], ['female', '2005', '妹妹'],
    ['female', '', '姐姐或妹妹（长幼待确认）'], ['female', '2000', '姐姐或妹妹（长幼待确认）'],
    ['unknown', '1995', '哥哥或姐姐（性别待确认）'],
  ]) {
    Object.assign(data.people[1], { gender, birth });
    assert.equal(family.describeRelationship(data, 'a', 'b').title, expected);
  }
});

test('sibling lists distinguish manual and inferred links and preserve inference after unlinking', () => {
  const data = fixture();
  assert.equal(typeof family.siblingsOf, 'function');
  assert.deepEqual(family.siblingsOf(data, 'a'), [{ id: 'b', manual: true, automatic: false }]);
  assert.deepEqual(family.siblingsOf(data, 'b'), [{ id: 'a', manual: true, automatic: false }]);
  data.people.push(person('p'));
  data.relations.push(parent('p', 'a'), parent('p', 'b'));
  assert.deepEqual(family.siblingsOf(data, 'a'), [{ id: 'b', manual: true, automatic: true }]);
  data.relations = data.relations.filter(r => r.type !== 'sibling');
  assert.deepEqual(family.siblingsOf(data, 'a'), [{ id: 'b', manual: false, automatic: true }]);
  assert.equal(family.describeRelationship(data, 'a', 'b').title, '姐姐');
  data.relations = [];
  assert.deepEqual(family.siblingsOf(data, 'a'), []);
  assert.equal(family.describeRelationship(data, 'a', 'b').title, '尚未找到亲属关系');
});

test('manual sibling paths do not assert shared parents or transitive sibling relationships', () => {
  const data = fixture();
  data.people.push(person('p', 'male'), person('c', 'male', '2002'));
  data.relations.push(parent('p', 'b'), sibling('b', 'c'));
  assert.match(family.describeRelationship(data, 'a', 'p').title, /未确认共同父母/);
  assert.match(family.describeRelationship(data, 'a', 'c').title, /不能推断.*传递性/);
  assert.deepEqual(family.siblingsOf(data, 'a').map(p => p.id), ['b']);
});

test('a manually linked sister\'s son is a nephew and calls the source aunt', () => {
  const data = { version: 1, selfId: '', people: [person('张娟', 'female'), person('张丽', 'female'), person('豪雨', 'male')], relations: [sibling('张娟', '张丽'), parent('张丽', '豪雨')] };
  const before = structuredClone(data);
  const forward = family.describeRelationship(data, '张娟', '豪雨');
  assert.equal(forward.title, '外甥');
  assert.deepEqual(forward.path.map(p => p.name), ['张娟', '张丽', '豪雨']);
  assert.equal(family.describeRelationship(data, '豪雨', '张娟').title, '姨妈');
  assert.deepEqual(data, before);
});

test('manual sibling child paths retain branch, gender and seniority distinctions', () => {
  for (const [sourceGender, sourceBirth, siblingGender, childGender, forward, backward] of [
    ['male', '', 'female', 'female', '外甥女', '舅舅'],
    ['female', '', 'male', 'male', '侄子', '姑姑'],
    ['male', '1990', 'male', 'female', '侄女', '伯父'],
    ['male', '2000', 'male', 'male', '侄子', '叔叔'],
    ['male', '', 'male', 'male', '侄子', '伯父或叔叔（长幼待确认）'],
    ['female', '', 'unknown', 'male', '侄子或外甥（性别待确认）', '姑姑或姨妈（性别待确认）'],
  ]) {
    const data = fixture();
    Object.assign(data.people[0], { gender: sourceGender, birth: sourceBirth });
    data.people[1].gender = siblingGender;
    data.people.push(person('child', childGender));
    data.relations.push(parent('b', 'child'));
    assert.equal(family.describeRelationship(data, 'a', 'child').title, forward);
    assert.equal(family.describeRelationship(data, 'child', 'a').title, backward);
  }
});

test('manual siblings can identify sibling spouses without inferring shared parents', () => {
  for (const [gender, birth, spouseGender, expected] of [
    ['male', '1995', 'female', '嫂子'], ['male', '2005', 'female', '弟媳'],
    ['female', '1995', 'male', '姐夫'], ['female', '2005', 'male', '妹夫'],
    ['female', '', 'male', '姐夫或妹夫（长幼待确认）'],
  ]) {
    const data = fixture();
    Object.assign(data.people[1], { gender, birth });
    data.people.push(person('spouse', spouseGender));
    data.relations.push({ from: 'b', to: 'spouse', type: 'spouse' });
    assert.equal(family.describeRelationship(data, 'a', 'spouse').title, expected);
  }
});

test('manual sibling paths do not hide adoptive or step parentage', () => {
  for (const [kind, label] of [['adoptive', '收养'], ['step', '继亲']]) {
    const data = fixture();
    data.people.push(person('child', 'male'));
    data.relations.push({ ...parent('b', 'child'), kind });
    for (const [from, to] of [['a', 'child'], ['child', 'a']]) {
      const result = family.describeRelationship(data, from, to);
      assert.ok(result.title.includes(`${label}关系，称呼待确认`));
      assert.equal(result.status, 'uncertain');
      assert.deepEqual(result.candidates, []);
    }
  }
});

test('shared-parent inference takes precedence over redundant manual links', () => {
  const data = fixture();
  data.people.push(person('p', 'male'), person('child', 'male', '2020'));
  data.relations.push(parent('p', 'a'), parent('p', 'b'), parent('b', 'child'));
  assert.equal(family.describeRelationship(data, 'a', 'child').title, '外甥');
});

test('sibling validation rejects duplicate, missing, self, spouse and ancestral conflicts', () => {
  assert.doesNotThrow(() => family.validateData(fixture()));
  for (const relation of [sibling('a', 'b'), sibling('a', 'missing'), sibling('a', 'a'), { from: 'a', to: 'b', type: 'spouse' }, parent('a', 'b')]) {
    const data = fixture(); data.relations.push(relation);
    assert.throws(() => family.validateData(data));
  }
  const cycle = fixture();
  cycle.people.push(person('c'), person('d'));
  cycle.relations.push(sibling('c', 'd'), parent('a', 'c'), parent('d', 'b'));
  assert.throws(() => family.validateData(cycle), /同辈|辈分/);
});

test('manual siblings stay on the same row even when only one has known parents', () => {
  const data = fixture(); data.people.push(person('p'), person('child'));
  data.relations.push(parent('p', 'b'), parent('a', 'child'));
  const layout = family.layoutTree(data), nodes = new Map(layout.nodes.map(n => [n.id, n]));
  assert.equal(nodes.get('a').y, nodes.get('b').y);
  assert.ok(nodes.get('p').y < nodes.get('a').y);
  assert.ok(nodes.get('a').y < nodes.get('child').y);
  assert.equal(nodes.size, 4);
  assert.ok(layout.nodes.every(n => n.y + 85 <= layout.height));
});

test('layout keeps sibling rows when spouse grouping conflicts with generations', () => {
  const data = fixture(); data.people.push(person('p'));
  data.relations.push(parent('p', 'a'), { from: 'p', to: 'b', type: 'spouse' });
  const clean = family.validateData(data), nodes = new Map(family.layoutTree(clean).nodes.map(n => [n.id, n]));
  assert.equal(nodes.get('a').y, nodes.get('b').y);
  assert.ok(nodes.get('p').y < nodes.get('a').y);
});
