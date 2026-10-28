import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyFamily, layoutTree, validateData } from '../src/family.js';

const person = id => ({ id, name: id, gender: 'unknown' });
const parent = (from, to, kind = 'biological') => ({ from, to, type: 'parent', kind });
const spouse = (from, to) => ({ from, to, type: 'spouse' });
const sibling = (from, to) => ({ from, to, type: 'sibling' });
const family = (ids, relations) => validateData({ ...emptyFamily(), people: ids.map(person), relations });
const positions = data => new Map(layoutTree(data).nodes.map(node => [node.id, node]));

// Two sisters, their children and the children's marriages reproduce the long diagonal in the report.
const intermarriedBranches = () => family(['a', 'b', 'c', 'd', 'e', 'f', 'g'], [
  parent('a', 'f'), parent('b', 'g'), parent('c', 'g'), parent('d', 'e'),
  spouse('b', 'c'), sibling('c', 'd'), spouse('f', 'g'),
]);

test('a mother and son stay close across intermarried sibling branches', () => {
  const data = intermarriedBranches(), nodes = positions(data);
  assert.ok(Math.abs(nodes.get('d').x - nodes.get('e').x) <= 160, 'mother and son should be within one card width horizontally');
  for (const relation of data.relations.filter(r => r.type === 'parent')) {
    assert.ok(Math.abs(nodes.get(relation.from).x - nodes.get(relation.to).x) <= 190, 'parent edges should not span unrelated branches');
  }
});

test('couples remain adjacent while their family branches are reordered', () => {
  const data = intermarriedBranches(), nodes = positions(data);
  for (const relation of data.relations.filter(r => r.type === 'spouse')) {
    assert.equal(nodes.get(relation.from).y, nodes.get(relation.to).y);
    assert.equal(Math.abs(nodes.get(relation.from).x - nodes.get(relation.to).x), 190);
  }
});

test('a single child aligns with its parent despite unrelated people on the parent row', () => {
  const data = family(['a-parent', 'b', 'c', 'd', 'e', 'child'], [parent('a-parent', 'child')]);
  const nodes = positions(data);
  assert.ok(Math.abs(nodes.get('a-parent').x - nodes.get('child').x) < 1);
});

test('a child is centered beneath both parents rather than the entire generation', () => {
  const data = family(['a', 'b', 'c', 'd', 'child'], [spouse('a', 'b'), parent('a', 'child'), parent('b', 'child')]);
  const nodes = positions(data);
  assert.ok(Math.abs(nodes.get('child').x - (nodes.get('a').x + nodes.get('b').x) / 2) < 1);
});

test('sibling children form a non-overlapping row centered beneath their parent', () => {
  const data = family(['parent', 'one', 'two', 'three'], ['one', 'two', 'three'].map(id => parent('parent', id)));
  const nodes = positions(data), children = ['one', 'two', 'three'].map(id => nodes.get(id).x).sort((a, b) => a - b);
  assert.ok(Math.abs(nodes.get('parent').x - (children[0] + children[2]) / 2) < 1);
  assert.ok(children[1] - children[0] >= 190 && children[2] - children[1] >= 190);
});

test('independent parent-child branches do not cross when child IDs run in reverse order', () => {
  const data = family(['a', 'b', 'c', 'x', 'y', 'z'], [parent('a', 'z'), parent('b', 'y'), parent('c', 'x')]);
  const nodes = positions(data);
  for (const first of data.relations) for (const second of data.relations) {
    assert.ok((nodes.get(first.from).x - nodes.get(second.from).x) * (nodes.get(first.to).x - nodes.get(second.to).x) >= 0);
  }
});

test('changing opaque member IDs does not change family placement or mutate saved data', () => {
  const data = intermarriedBranches(), before = structuredClone(data), first = positions(data);
  const ids = new Map(data.people.map((p, i) => [p.id, `renamed-${100 - i}`]));
  const renamed = { ...data, people: data.people.map(p => ({ ...p, id: ids.get(p.id) })), relations: data.relations.map(r => ({ ...r, from: ids.get(r.from), to: ids.get(r.to) })) };
  const second = positions(renamed);
  for (const p of data.people) {
    assert.equal(first.get(p.id).x, second.get(ids.get(p.id)).x);
    assert.equal(first.get(p.id).y, second.get(ids.get(p.id)).y);
  }
  assert.deepEqual(data, before);
  assert.deepEqual(layoutTree(data), layoutTree(data));
});

test('several generations, special parentage and isolated people remain inside the canvas without overlap', () => {
  const data = family(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'isolated'], [
    spouse('a', 'b'), parent('a', 'c'), parent('b', 'c'), sibling('c', 'd'),
    parent('c', 'e', 'adoptive'), parent('d', 'f', 'step'), spouse('e', 'f'), parent('f', 'g'), parent('g', 'h'),
  ]);
  const layout = layoutTree(data), nodes = new Map(layout.nodes.map(n => [n.id, n]));
  assert.equal(nodes.size, data.people.length);
  for (const node of layout.nodes) {
    assert.ok(node.x >= 0 && node.x + 160 <= layout.width);
    assert.ok(node.y >= 0 && node.y + 85 <= layout.height);
    for (const other of layout.nodes) if (other.id !== node.id && other.y === node.y) assert.ok(Math.abs(other.x - node.x) >= 190 - 1e-8);
  }
  for (const relation of data.relations.filter(r => r.type === 'parent')) assert.ok(nodes.get(relation.from).y < nodes.get(relation.to).y);
  assert.equal(nodes.get('c').y, nodes.get('d').y);
});

test('empty and maximum-size families have finite non-overlapping layouts', () => {
  assert.deepEqual(layoutTree(emptyFamily()).nodes, []);
  const ids = Array.from({ length: 500 }, (_, i) => String(i));
  const data = family(ids, ids.slice(1).map(id => parent('0', id)));
  const layout = layoutTree(data), children = layout.nodes.filter(n => n.id !== '0').sort((a, b) => a.x - b.x);
  assert.equal(layout.nodes.length, 500);
  assert.ok(Number.isFinite(layout.width) && Number.isFinite(layout.height));
  children.forEach((child, i) => {
    assert.ok(child.x >= 0 && child.x + 160 <= layout.width);
    if (i) assert.ok(child.x - children[i - 1].x >= 190 - 1e-8);
  });
});
