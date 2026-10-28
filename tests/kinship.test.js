import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRelationship, emptyFamily } from '../src/family.js';

// Each token adds an actual, distinct person; no relationship is derived from a name.
function chain(tokens, sourceGender = 'male') {
  const data = emptyFamily();
  data.people.push({ id: '0', name: '起点', gender: sourceGender, birth: '2000' });
  for (const [i, token] of tokens.entries()) {
    const from = String(i), to = String(i + 1);
    const gender = ['f', 's', 'h', 'ob', 'lb', 'xb'].includes(token) ? 'male' : 'female';
    data.people.push({ id: to, name: `成员${to}`, gender, birth: '' });
    if (['f', 'm'].includes(token)) data.relations.push({ from: to, to: from, type: 'parent', kind: 'biological' });
    else if (['s', 'd'].includes(token)) data.relations.push({ from, to, type: 'parent', kind: 'biological' });
    else if (['h', 'w'].includes(token)) data.relations.push({ from, to, type: 'spouse' });
    else {
      data.relations.push({ from, to, type: 'sibling' });
      if (token.startsWith('o') || token.startsWith('l')) {
        data.people[i].birth = '1970';
        data.people[i + 1].birth = token.startsWith('o') ? '1965' : '1975';
      }
    }
  }
  return data;
}

for (const [tokens, gender, expected] of [
  [['m', 'xs', 's'], 'male', ['表哥', '表弟']],
  [['f', 'xb', 's'], 'male', ['堂哥', '堂弟']],
  [['f', 'xs', 'd'], 'female', ['表姐', '表妹']],
  [['m', 'xb', 'd'], 'female', ['表姐', '表妹']],
  [['f', 'f', 'f'], 'male', ['曾祖父']],
  [['s', 's', 's'], 'male', ['曾孙']],
  [['m', 'xb', 'w'], 'male', ['舅妈']],
  [['f', 'xs', 'h'], 'female', ['姑父']],
  [['m', 'xs', 'h'], 'male', ['姨父']],
  [['w', 'f'], 'male', ['岳父']],
  [['h', 'm'], 'female', ['婆婆']],
  [['w', 'ob'], 'male', ['大舅子']],
  [['h', 'ls'], 'female', ['小姑子']],
  [['s', 'w', 'f'], 'male', ['亲家公']],
]) {
  test(`general kinship chain ${tokens.join('/')} resolves without a person-specific rule`, () => {
    const data = chain(tokens, gender);
    const result = describeRelationship(data, '0', String(tokens.length));
    assert.deepEqual(new Set(result.candidates), new Set(expected));
    assert.ok(result.title.includes(expected[0]));
  });
}

test('manual cousin seniority uses the two cousins, not their parents', () => {
  const data = chain(['m', 'os', 's']);
  data.people[0].birth = '2000';
  data.people[3].birth = '2005';
  assert.deepEqual(describeRelationship(data, '0', '3').candidates, ['表弟']);
  assert.deepEqual(describeRelationship(data, '3', '0').candidates, ['表哥']);
  data.people[3].birth = '2000-06';
  assert.deepEqual(new Set(describeRelationship(data, '0', '3').candidates), new Set(['表哥', '表弟']));
  assert.match(describeRelationship(data, '0', '3').title, /长幼待确认/);
});

test('unknown intermediate gender produces candidates instead of choosing one branch', () => {
  const data = chain(['m', 'm']);
  data.people[1].gender = 'unknown';
  const result = describeRelationship(data, '0', '2');
  assert.deepEqual(new Set(result.candidates), new Set(['奶奶', '外婆']));
  assert.match(result.title, /性别/);
});

test('missing source gender does not claim to affect an age-only distinction', () => {
  const data = chain(['m', 'xs', 's'], 'unknown');
  const result = describeRelationship(data, '0', '3');
  assert.deepEqual(new Set(result.candidates), new Set(['表哥', '表弟']));
  assert.match(result.title, /长幼待确认/);
  assert.doesNotMatch(result.title, /性别待确认/);
});

test('equally short maternal and paternal paths are both evaluated independent of insertion order', () => {
  const data = chain(['f', 'xb', 's']);
  data.people.push({ id: 'mother', name: '母亲', gender: 'female', birth: '' });
  data.relations.push({ from: 'mother', to: '0', type: 'parent', kind: 'biological' }, { from: 'mother', to: '2', type: 'sibling' });
  const result = describeRelationship(data, '0', '3');
  assert.deepEqual(new Set(result.candidates), new Set(['堂哥', '堂弟', '表哥', '表弟']));
  assert.match(result.title, /多条/);
  data.relations.reverse();
  assert.deepEqual(new Set(describeRelationship(data, '0', '3').candidates), new Set(result.candidates));
});

for (const tokens of [['xb', 'f'], ['xb', 'xb'], ['s', 'm'], ['f', 'w'], ['h', 's'], ['w', 'h']]) {
  test(`chain ${tokens.join('/')} never invents a parent, sibling, spouse or identity`, () => {
    const data = chain(tokens);
    const before = structuredClone(data);
    const result = describeRelationship(data, '0', String(tokens.length));
    assert.equal(result.status, 'uncertain');
    assert.deepEqual(result.candidates, []);
    assert.match(result.title, /未确认|不能推断/);
    assert.deepEqual(data, before);
  });
}

test('non-biological paths keep their provenance instead of becoming biological titles', () => {
  const data = chain(['m', 'xs', 's']);
  data.relations[0].kind = 'adoptive';
  const result = describeRelationship(data, '0', '3');
  assert.match(result.title, /收养/);
  assert.equal(result.status, 'uncertain');
  assert.deepEqual(result.candidates, []);
});

test('long paths return an explicit bounded result without changing the genealogy', () => {
  const data = chain(Array(20).fill('f'));
  const result = describeRelationship(data, '0', '20');
  assert.match(result.title, /范围|过长/);
  assert.equal(result.path.length, 21);
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(result.candidates, []);
});

test('a cousin spouse title uses the cousin age, never the spouse age', () => {
  const data = chain(['f', 'xb', 's', 'w']);
  data.people[3].birth = '1995';
  data.people[4].birth = '2005';
  assert.deepEqual(describeRelationship(data, '0', '4').candidates, ['堂嫂']);
  data.people[3].birth = '2005';
  data.people[4].birth = '1995';
  assert.deepEqual(describeRelationship(data, '0', '4').candidates, ['堂弟媳']);
});

test('a spouse cousin title uses the spouse as its age anchor', () => {
  const data = chain(['w', 'f', 'xb', 's']);
  data.people[0].birth = '1980';
  data.people[1].birth = '2000';
  data.people[4].birth = '1995';
  const older = describeRelationship(data, '0', '4');
  data.people[0].birth = '2020';
  assert.deepEqual(describeRelationship(data, '0', '4').candidates, older.candidates);
  assert.equal(older.status, 'resolved');
  data.people[1].birth = '1990';
  assert.notDeepEqual(describeRelationship(data, '0', '4').candidates, older.candidates);
});

for (const [tokens, sourceGender, expected] of [
  [['w', 'f'], 'male', ['女婿']],
  [['h', 'm'], 'female', ['儿媳']],
  [['f', 'f', 'f'], 'female', ['曾孙女']],
  [['s', 's', 's'], 'male', ['曾祖父']],
  [['m', 'xs', 'h'], 'male', ['姨甥']],
]) {
  test(`reverse chain ${tokens.join('/')} derives the reciprocal title`, () => {
    const data = chain(tokens, sourceGender);
    assert.deepEqual(describeRelationship(data, String(tokens.length), '0').candidates, expected);
  });
}

test('path overflow cannot be presented as a unique or exhaustive result', () => {
  const data = emptyFamily();
  data.people = [{ id: 'source', name: '起点', gender: 'male' }, { id: 'target', name: '终点', gender: 'male' }];
  for (let i = 0; i < 35; i++) {
    const id = `parent-${i}`;
    data.people.push({ id, name: id, gender: 'male' });
    data.relations.push({ from: id, to: 'source', type: 'parent', kind: 'biological' }, { from: id, to: 'target', type: 'sibling' });
  }
  const result = describeRelationship(data, 'source', 'target');
  assert.equal(result.alternatives.length, 32);
  assert.equal(result.status, 'uncertain');
  assert.match(result.title, /路径过多.*不完整/);
  assert.deepEqual(result.daily?.candidates, []);
  assert.match(result.daily.title, /姓名/);
  assert.match(result.daily.reasons.join('；'), /路径过多/);
});

test('unknown-gender combination overflow is explicit and non-destructive', () => {
  const data = chain(Array(7).fill('f'));
  data.people.slice(1).forEach(person => { person.gender = 'unknown'; });
  const before = structuredClone(data);
  const result = describeRelationship(data, '0', '7');
  assert.equal(result.status, 'uncertain');
  assert.deepEqual(result.candidates, []);
  assert.match(result.title, /候选组合过多/);
  assert.deepEqual(data, before);
});

test('a gender-specific dictionary hit cannot hide another unsupported possibility', () => {
  const data = chain(['m', 'xs', 'd', 's', 's', 's'], 'unknown');
  const result = describeRelationship(data, '0', '6');
  assert.equal(result.status, 'uncertain');
  assert.ok(result.candidates.length > 0);
  assert.match(result.title, /部分候选.*未.*覆盖/);
});

test('a direct known relationship wins over a longer speculative chain', () => {
  const data = chain(['f', 'w']);
  data.relations.push({ from: '2', to: '0', type: 'parent', kind: 'biological' });
  assert.deepEqual(describeRelationship(data, '0', '2').candidates, ['妈妈']);
  assert.equal(describeRelationship(data, '0', '2').path.length, 2);
});

test('maximum-size sibling families remain queryable without duplicate paths', () => {
  const data = emptyFamily();
  data.people.push({ id: 'p', name: '家长', gender: 'female' });
  for (let i = 0; i < 499; i++) {
    const id = String(i);
    data.people.push({ id, name: id, gender: 'male', birth: String(1500 + i) });
    data.relations.push({ from: 'p', to: id, type: 'parent', kind: 'biological' });
  }
  const result = describeRelationship(data, '0', '498');
  assert.deepEqual(result.candidates, ['弟弟']);
  assert.equal(result.alternatives.length, 1);
});

for (const [tokens, expected] of [
  [['m'], ['妈妈']],
  [['f', 'lb'], ['叔叔']],
  [['m', 'xb', 'w'], ['舅妈']],
  [['w', 'f'], ['岳父']],
  [['f', 'f', 'lb'], ['叔爷爷']],
  [['f', 'f', 'xs'], ['姑奶奶']],
  [['m', 'm', 'xb'], ['舅公']],
  [['f', 'f', 'f', 'xb', 's', 's', 's'], ['堂哥']],
  [['f', 'm', 'xb', 's', 's'], ['表哥']],
  [['f', 'f', 'xs', 's', 's'], ['表哥']],
  [['f', 'f', 'xb', 'd', 's'], ['表哥']],
  [['m', 'f', 'xb', 's'], ['舅舅']],
  [['f', 'f', 'xs', 'd'], ['姑姑']],
  [['f', 'f', 'xb', 's', 's', 's'], ['侄子']],
  [['f', 'f', 'xb', 's', 'd', 's'], ['外甥']],
]) {
  test(`daily address for ${tokens.join('/')} uses familiar names without rewriting genealogy`, () => {
    const data = chain(tokens);
    data.people.at(-1).birth = '1995';
    const before = structuredClone(data);
    const result = describeRelationship(data, '0', String(tokens.length));
    assert.deepEqual(result.daily?.candidates, expected);
    assert.deepEqual(data, before);
    assert.ok(result.candidates.length, 'Full terminology remains available');
  });
}

test('daily addresses handle unselected, self, and disconnected people explicitly', () => {
  const data = chain(['m']);
  assert.equal(describeRelationship(data, '0', 'missing').daily?.title, '请选择两位成员');
  assert.deepEqual(describeRelationship(data, '0', '0').daily?.candidates, ['本人']);
  data.relations = [];
  const disconnected = describeRelationship(data, '0', '1');
  assert.deepEqual(disconnected.daily?.candidates, []);
  assert.match(disconnected.daily.title, /姓名/);
  assert.match(disconnected.daily.reasons.join('；'), /尚未找到/);
});

for (const [tokens, expected] of [
  [['f', 'f', 'xb', 's', 'd'], ['堂姐']],
  [['f', 'm', 'xb', 's', 'd'], ['表姐']],
  [['m', 'xb', 's', 'w'], ['表嫂']],
  [['f', 'm', 'xb', 's', 'd', 'h'], ['表姐夫']],
  [['f', 'f', 'f', 'xb', 's'], ['伯爷爷', '叔爷爷']],
]) {
  test(`daily female, spouse and grandparent-generation address for ${tokens.join('/')}`, () => {
    const data = chain(tokens);
    data.people[tokens.at(-1) === 'h' || tokens.at(-1) === 'w' ? tokens.length - 1 : tokens.length].birth = '1995';
    assert.deepEqual(describeRelationship(data, '0', String(tokens.length)).daily?.candidates, expected);
  });
}

test('a supported alternative cannot mask an unconfirmed shortest path in daily addresses', () => {
  const data = chain(['f', 'xb']);
  data.people.push({ id: 'spouse', name: '配偶', gender: 'female' });
  data.relations.push({ from: '0', to: 'spouse', type: 'spouse' }, { from: 'spouse', to: '2', type: 'parent', kind: 'biological' });
  const result = describeRelationship(data, '0', '2');
  assert.equal(result.alternatives.length, 2);
  assert.deepEqual(result.daily?.candidates, []);
  assert.match(result.daily.reasons.join('；'), /未确认/);
});

test('distant cousins retain their full terminology alongside reciprocal everyday addresses', () => {
  const data = chain(['f', 'f', 'f', 'xb', 's', 's', 's']);
  data.people[7].birth = '1995';
  const forward = describeRelationship(data, '0', '7');
  assert.deepEqual(forward.candidates, ['族兄']);
  assert.deepEqual(forward.daily?.candidates, ['堂哥']);
  assert.deepEqual(describeRelationship(data, '7', '0').daily?.candidates, ['堂弟']);
  data.people[7].birth = '';
  const unknown = describeRelationship(data, '0', '7');
  assert.deepEqual(new Set(unknown.daily?.candidates), new Set(['堂哥', '堂弟']));
  assert.match(unknown.daily.title, /长幼待确认/);
});

test('a distant parent-generation relative is ranked against the parent, not the viewer or ancestor', () => {
  const data = chain(['f', 'f', 'xb', 's']);
  data.people[1].birth = '1970'; data.people[4].birth = '1965';
  assert.deepEqual(describeRelationship(data, '0', '4').daily?.candidates, ['伯父']);
  data.people[4].birth = '1975';
  assert.deepEqual(describeRelationship(data, '0', '4').daily?.candidates, ['叔叔']);
  data.people[4].birth = '';
  const unknown = describeRelationship(data, '0', '4');
  assert.deepEqual(new Set(unknown.daily?.candidates), new Set(['伯父', '叔叔']));
  assert.match(unknown.daily.title, /长幼待确认/);
});

test('daily cousin-spouse addresses use the blood relative age', () => {
  const data = chain(['f', 'f', 'xb', 's', 's', 'w']);
  data.people[5].birth = '1995'; data.people[6].birth = '2010';
  assert.deepEqual(describeRelationship(data, '0', '6').daily?.candidates, ['堂嫂']);
  data.people[5].birth = '2005'; data.people[6].birth = '1990';
  assert.deepEqual(describeRelationship(data, '0', '6').daily?.candidates, ['堂弟媳']);
});

test('daily spouse-side cousin addresses follow the spouse age anchor', () => {
  const data = chain(['w', 'f', 'f', 'xb', 's', 's']);
  data.people[0].birth = '1980'; data.people[1].birth = '2000'; data.people[6].birth = '1995';
  assert.deepEqual(describeRelationship(data, '0', '6').daily?.candidates, ['堂哥']);
  data.people[1].birth = '1990';
  assert.deepEqual(describeRelationship(data, '0', '6').daily?.candidates, ['堂弟']);
});

test('daily addresses retain unknown gender and independent shortest-path alternatives', () => {
  const data = chain(['f', 'f', 'xb', 's', 's']);
  data.people[5].birth = '1995'; data.people[1].gender = 'unknown';
  assert.deepEqual(new Set(describeRelationship(data, '0', '5').daily?.candidates), new Set(['堂哥', '表哥']));
  data.people[1].gender = 'male';
  data.people.push({ id: 'mother', name: '母亲', gender: 'female' });
  data.relations.push({ from: 'mother', to: '0', type: 'parent', kind: 'biological' }, { from: '2', to: 'mother', type: 'parent', kind: 'biological' });
  const first = describeRelationship(data, '0', '5');
  assert.deepEqual(new Set(first.daily?.candidates), new Set(['堂哥', '表哥']));
  data.relations.reverse();
  assert.deepEqual(new Set(describeRelationship(data, '0', '5').daily?.candidates), new Set(first.daily.candidates));
});

for (const tokens of [['xb', 'f'], ['xb', 'xb'], ['s', 'm'], ['f', 'w'], ['h', 's'], ['w', 'h'], Array(20).fill('f')]) {
  test(`daily address for uncertain or excessive ${tokens.join('/')} does not invent a family role`, () => {
    const data = chain(tokens);
    const result = describeRelationship(data, '0', String(tokens.length));
    assert.deepEqual(result.daily?.candidates, []);
    assert.match(result.daily.title, /姓名/);
    assert.ok(result.daily.reasons.length);
  });
}

test('adoption and partial dictionary coverage do not become unconditional daily kinship claims', () => {
  const adopted = chain(['m', 'xs', 's']); adopted.relations[0].kind = 'adoptive';
  const partial = chain(['m', 'xs', 'd', 's', 's', 's'], 'unknown');
  for (const data of [adopted, partial]) {
    const result = describeRelationship(data, '0', data.people.at(-1).id);
    assert.deepEqual(result.daily?.candidates, []);
    assert.match(result.daily.title, /姓名/);
    assert.equal(result.status, 'uncertain');
  }
});
