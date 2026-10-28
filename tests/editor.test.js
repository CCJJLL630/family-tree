import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as family from '../src/family.js';
import * as library from '../src/library.js';

const source = (await readFile(new URL('../src/app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const fixture = () => ({ version: 2, activeId: 'a', families: ['a', 'b'].map(id => ({
  id, name: id, data: { ...family.emptyFamily(), selfId: 'same-id', people: [{ id: 'same-id', name: id, gender: 'unknown', notes: `${id} notes` }] }
})) });

async function editorApp(initial = fixture(), confirm = () => true, storageRequest = async () => ({ mode: 'browser', path: '', revision: 'browser' })) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', disabled: false, hidden: false, children: [], options: [], selectedOptions: [], handlers: {},
      elements: Object.fromEntries(['name', 'alias', 'gender', 'birth', 'death', 'city', 'occupation', 'notes'].map(key => [key, { value: '', focus() {} }])),
      addEventListener(type, fn) { this.handlers[type] = fn; },
      replaceChildren(...children) { this.children = children; }, reset() {},
      showModal() { this.open = true; }, close() { this.open = false; }
    });
    return nodes.get(id);
  };
  const prompts = [];
  const storage = { text: JSON.stringify(initial), writes: 0, getItem() { return this.text; }, setItem(key, value) { this.text = value; this.writes++; } };
  let release;
  let tail = new Promise(resolve => { release = resolve; });
  const locks = { request(name, fn) { assert.equal(name, family.STORAGE_KEY); const result = tail.then(fn); tail = result.catch(() => {}); return result; } };
  const context = vm.createContext({ ...family, ...library, storageRequest, crypto: { randomUUID }, navigator: { locks },
    window: { localStorage: storage, addEventListener() {} },
    document: { getElementById: node, createTextNode: text => text }, requestAnimationFrame() {},
    confirm: message => { prompts.push(message); return confirm(message); }
  });
  // Run the real editor and persistence handlers; only browser rendering is replaced.
  vm.runInContext(`${source}\nfunction render() {}\nfunction fitTree() {}\nfunction previewPhoto() {}\nfunction fillSelect() {}\nfunction addParentRow() {}\nfunction selectPerson(id) { selectedId = id; }`, context);
  await vm.runInContext('startup', context);
  return {
    node, storage, prompts, release, open: id => context.openEditor(id),
    changeLocation: directory => { node('storage-directory').value = directory; return node('storage-form').handlers.submit({ preventDefault() {} }); },
    change: expression => vm.runInContext(`commitLibrary(${expression}, 'test')`, context),
    act: action => node(action === 'save' ? 'person-form' : 'delete-person').handlers[action === 'save' ? 'submit' : 'click']({ preventDefault() {} })
  };
}

for (const action of ['save', 'delete']) {
  for (const change of ["selectFamily(library, 'b')", "replaceFamily(library, 'a', { ...data, people: [{ ...data.people[0], notes: 'newer record' }] })"]) {
    test(`${action} rejects an editor opened before a pending ${change.startsWith('select') ? 'family switch' : 'family update'} completes`, async () => {
      const app = await editorApp();
      const pending = app.change(change);
      app.open('same-id');
      app.node('person-form').elements.notes.value = 'stale edit';
      app.release(); await pending;
      const before = app.storage.text;
      await app.act(action);
      assert.equal(app.storage.text, before, 'A stale editor must not change either family');
      assert.equal(app.node('form-error').hidden, false);
      assert.match(app.node('form-error').textContent, /切换|更改|更新/);
      assert.equal(app.node('editor').open, true);
    });
  }
}

for (const action of ['save', 'delete']) {
  test(`${action} still works in the editor's unchanged family`, async () => {
    const app = await editorApp(); app.release(); app.open('same-id');
    app.node('person-form').elements.notes.value = 'updated notes';
    await app.act(action);
    const saved = JSON.parse(app.storage.text);
    assert.equal(saved.families[0].data.people.length, action === 'save' ? 1 : 0);
    if (action === 'save') assert.equal(saved.families[0].data.people[0].notes, 'updated notes');
    assert.equal(saved.families[1].data.people[0].notes, 'b notes');
    assert.equal(app.node('editor').open, false);
  });
}

function coParentFixture() {
  const initial = fixture();
  initial.families[0].data.people.push({ id: 'mother', name: '测试母亲', gender: 'female' }, { id: 'father', name: '测试父亲', gender: 'male' });
  initial.families[0].data.relations.push({ from: 'mother', to: 'same-id', type: 'parent', kind: 'biological' });
  return initial;
}
function setParents(app, kind = 'biological') {
  app.node('parent-rows').children = ['mother', 'father'].map(id => ({ querySelectorAll: () => [{ value: id }, { value: id === 'father' ? kind : 'biological' }] }));
}

for (const accepted of [true, false]) {
  test(`a newly added second parent prompts once and ${accepted ? 'saves the confirmed spouse atomically' : 'preserves only parent links when declined'}`, async () => {
    const initial = coParentFixture(), app = await editorApp(initial, () => accepted);
    app.release(); app.open('same-id'); setParents(app);
    await app.act('save');
    assert.equal(app.prompts.length, 1);
    assert.match(app.prompts[0], /测试母亲/); assert.match(app.prompts[0], /测试父亲/);
    assert.match(app.prompts[0], /取消.*仅保存父母/);
    const saved = JSON.parse(app.storage.text), relations = saved.families[0].data.relations;
    assert.equal(relations.filter(r => r.type === 'parent').length, 2);
    assert.equal(relations.filter(r => r.type === 'spouse').length, accepted ? 1 : 0);
    if (accepted) assert.deepEqual(relations.find(r => r.type === 'spouse'), { from: 'father', to: 'mother', type: 'spouse' });
    assert.equal(app.storage.writes, 1);
    assert.deepEqual(saved.families[1].data, family.validateData(initial.families[1].data));
    assert.equal(app.node('editor').open, false);
  });
}

test('adding a new child with two parents only asks once and does not duplicate the spouse link', async () => {
  const app = await editorApp(coParentFixture()); app.release(); app.open(); setParents(app);
  app.node('person-form').elements.name.value = '新孩子';
  await app.act('save');
  assert.equal(app.prompts.length, 1);
  const saved = JSON.parse(app.storage.text).families[0].data;
  const child = saved.people.find(p => p.name === '新孩子');
  assert.equal(saved.relations.filter(r => r.type === 'parent' && r.to === child.id).length, 2);
  assert.equal(saved.relations.filter(r => r.type === 'spouse').length, 1);
});

for (const scenario of ['unchanged parents', 'existing spouse', 'explicit siblings', 'ancestor']) {
  test(`co-parent confirmation is not offered for ${scenario}`, async () => {
    const initial = coParentFixture(), relations = initial.families[0].data.relations;
    if (scenario === 'unchanged parents') relations.push({ from: 'father', to: 'same-id', type: 'parent', kind: 'biological' });
    if (scenario === 'existing spouse') relations.push({ from: 'mother', to: 'father', type: 'spouse' });
    if (scenario === 'explicit siblings') relations.push({ from: 'mother', to: 'father', type: 'sibling' });
    if (scenario === 'ancestor') relations.push({ from: 'mother', to: 'father', type: 'parent', kind: 'biological' });
    const app = await editorApp(initial); app.release(); app.open('same-id'); setParents(app);
    await app.act('save');
    assert.equal(app.prompts.length, 0);
    assert.equal(app.storage.writes, 1);
    assert.equal(JSON.parse(app.storage.text).families[0].data.relations.filter(r => r.type === 'spouse').length, scenario === 'existing spouse' ? 1 : 0);
  });
}

test('special parentage is stated in the confirmation without changing the parent relationship kind', async () => {
  const app = await editorApp(coParentFixture()); app.release(); app.open('same-id'); setParents(app, 'step');
  await app.act('save');
  assert.equal(app.prompts.length, 1); assert.match(app.prompts[0], /继亲/);
  const saved = JSON.parse(app.storage.text).families[0].data;
  assert.equal(saved.relations.find(r => r.type === 'parent' && r.from === 'father').kind, 'step');
  assert.equal(saved.relations.filter(r => r.type === 'spouse').length, 1);
});

test('another tab updating storage during spouse confirmation cannot be overwritten', async () => {
  const initial = coParentFixture(), newer = structuredClone(initial);
  newer.families[0].data.people[0].notes = 'newer tab';
  const newerText = JSON.stringify(newer);
  const app = await editorApp(initial, () => { app.storage.text = newerText; return true; });
  app.release(); app.open('same-id'); setParents(app);
  await app.act('save');
  assert.equal(app.prompts.length, 1);
  assert.equal(app.storage.text, newerText);
  assert.equal(app.storage.writes, 0);
  assert.equal(app.node('editor').open, true);
  assert.equal(app.node('save-person').disabled, false);
  assert.match(app.node('form-error').textContent, /其他页面修改/);
});

const fileState = initial => ({ mode: 'file', path: 'C:\\family\\family-tree-library.json', revision: 'file-1', library: library.readLibrary(JSON.stringify(initial)) });

test('configured storage loads and saves the complete disk library without changing the browser copy', async () => {
  const initial = fixture(), remote = fixture(); remote.families[0].data.people[0].notes = 'disk notes';
  let state = fileState(remote), writes = 0;
  const app = await editorApp(initial, () => true, async (method = 'GET', body) => {
    if (method === 'PUT') { assert.equal(body.revision, state.revision); writes++; state = { ...state, revision: 'file-2', library: body.library }; }
    return state;
  });
  app.release(); app.open('same-id');
  assert.equal(app.node('person-form').elements.notes.value, 'disk notes');
  app.node('person-form').elements.notes.value = 'saved to disk'; await app.act('save');
  assert.equal(writes, 1); assert.equal(state.library.families[0].data.people[0].notes, 'saved to disk');
  assert.equal(state.library.families[1].data.people[0].notes, 'b notes');
  assert.equal(app.storage.text, JSON.stringify(initial)); assert.equal(app.storage.writes, 0);
  assert.equal(app.node('editor').open, false);
});

test('location changes wait for pending save responses before another archive can open', async () => {
  const original = fileState(fixture()), existing = fileState(fixture());
  existing.path = 'C:\\other\\family-tree-library.json'; existing.revision = 'other';
  existing.library.families[0].data.people[0].notes = 'existing archive';
  let finishSave;
  const app = await editorApp(fixture(), () => true, async (method = 'GET', body) => {
    if (method === 'PUT') return new Promise(resolve => { finishSave = resolve; });
    if (method === 'POST') {
      if (!body.openExisting) throw Object.assign(new Error('target exists'), { code: 'TARGET_EXISTS', targetRevision: 'target' });
      return existing;
    }
    return original;
  });
  app.release(); const pending = app.change('library');
  await app.changeLocation('C:\\other');
  const blocked = app.node('storage-error').textContent;
  finishSave(original); await pending;
  assert.match(blocked || '', /正在保存|保存.*完成/);
  assert.equal(app.prompts.length, 0);
  await app.changeLocation('C:\\other');
  app.open('same-id');
  assert.equal(app.node('person-form').elements.notes.value, 'existing archive');
});

test('disk save failure keeps edits open and never falls back to browser storage', async () => {
  const app = await editorApp(fixture(), () => true, async (method = 'GET') => {
    if (method === 'PUT') throw new Error('disk unavailable'); return fileState(fixture());
  });
  app.release(); app.open('same-id'); app.node('person-form').elements.notes.value = 'unsaved';
  await app.act('save');
  assert.equal(app.storage.writes, 0); assert.equal(app.node('editor').open, true);
  assert.match(app.node('form-error').textContent, /disk unavailable/);
});

test('storage startup failure locks all writes instead of silently using the browser copy', async () => {
  const app = await editorApp(fixture(), () => true, async () => { throw new Error('cannot read disk'); });
  app.release(); await assert.rejects(app.change('library'), /停止写入|尚未/);
  assert.equal(app.storage.writes, 0);
});

test('a valid disk archive can load even if the retained browser copy is corrupt', async () => {
  const app = await editorApp({ broken: true }, () => true, async () => fileState(fixture()));
  app.release(); app.open('same-id');
  assert.equal(app.node('editor').open, true);
  assert.equal(app.node('person-form').elements.notes.value, 'a notes');
});

test('browser writes recheck the shared location before saving', async () => {
  let switched = false;
  const app = await editorApp(fixture(), () => true, async () => switched ? fileState(fixture()) : { mode: 'browser', path: '', revision: 'browser' });
  app.release(); switched = true;
  await assert.rejects(app.change("selectFamily(library, 'b')"), /位置|刷新/);
  assert.equal(app.storage.writes, 0);
});

test('choosing a folder migrates every family and preserves the original browser text', async () => {
  const initial = fixture(); let state = { mode: 'browser', path: '', revision: 'browser' }, migrated;
  const app = await editorApp(initial, () => true, async (method = 'GET', body, suffix) => {
    if (method === 'POST') { assert.equal(suffix, '/location'); assert.equal(body.directory, 'C:\\family'); migrated = body.library; state = fileState(migrated); }
    return state;
  });
  app.release(); await app.changeLocation('C:\\family');
  assert.equal(migrated.families.length, 2);
  assert.equal(app.storage.text, JSON.stringify(initial)); assert.equal(app.storage.writes, 0);
  assert.equal(app.node('storage-dialog').open, false);
});

test('browser changes while folder selection waits for a lock cannot be migrated as stale data', async () => {
  let posts = 0;
  const app = await editorApp(fixture(), () => true, async (method = 'GET') => { if (method === 'POST') posts++; return { mode: 'browser', path: '', revision: 'browser' }; });
  const pending = app.changeLocation('C:\\family'); app.storage.text = JSON.stringify({ newer: true }); app.release(); await pending;
  assert.equal(posts, 0); assert.equal(app.node('storage-error').hidden, false);
  assert.match(app.node('storage-error').textContent, /其他页面|刷新/);
});

for (const accepted of [true, false]) {
  test(`existing archive ${accepted ? 'opens only after explicit confirmation with the original target revision' : 'is not opened when confirmation is declined'}`, async () => {
    let posts = 0; const initial = fixture(), existing = fixture(); existing.families[0].data.people[0].notes = 'existing archive';
    const app = await editorApp(initial, () => accepted, async (method = 'GET', body) => {
      if (method === 'GET') return { mode: 'browser', path: '', revision: 'browser' };
      posts++;
      if (!body.openExisting) throw Object.assign(new Error('target exists'), { code: 'TARGET_EXISTS', targetRevision: 'target-original' });
      assert.equal(body.targetRevision, 'target-original'); return fileState(existing);
    });
    app.release(); await app.changeLocation('C:\\family');
    assert.equal(posts, accepted ? 2 : 1); assert.equal(app.prompts.length, 1);
    assert.match(app.prompts[0], /不合并|不会合并/); assert.equal(app.storage.text, JSON.stringify(initial));
    if (accepted) { app.open('same-id'); assert.equal(app.node('person-form').elements.notes.value, 'existing archive'); }
  });
}

