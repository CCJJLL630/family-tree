import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server.js';
import { storageRequest } from '../src/storage.js';

const fixture = () => ({ version: 2, activeId: 'one', families: ['one', 'two'].map(id => ({ id, name: id, data: { version: 1, selfId: id, people: [{ id, name: id, gender: 'unknown', notes: `${id} notes` }], relations: [] } })) });
async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'family-storage-')));
  const directory = join(root, '家谱 data'), other = join(root, 'other'), configPath = join(root, 'location.json');
  await mkdir(directory); await mkdir(other);
  let server, base;
  async function start() {
    server = createAppServer({ configPath });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await start();
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  async function request(route = '', body, headers = {}, method) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(`${base}/api/storage${route}`, { method: method || (body ? route ? 'POST' : 'PUT' : 'GET'), headers: { 'X-Family-Tree': '1', Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, response => {
        let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
        response.on('end', () => { let result; try { result = JSON.parse(text); } catch { result = { message: text }; } resolve({ status: response.statusCode, ...result }); });
      });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  async function connect() {
    const state = await request(); assert.equal(state.status, 200); assert.equal(state.mode, 'browser');
    const saved = await request('/location', { directory, library: fixture(), revision: state.revision });
    assert.equal(saved.status, 200); return saved;
  }
  return { root, directory, other, configPath, request, connect, client: (method, body, suffix) => storageRequest(method, body, suffix, (path, options) => fetch(base + path, options)), file: join(directory, 'family-tree-library.json'), async restart() { await new Promise(resolve => server.close(resolve)); await start(); } };
}

test('migrates every family, persists the chosen directory across restart, and keeps a previous disk revision', async t => {
  const app = await setup(t), initial = await app.connect();
  assert.equal(initial.mode, 'file'); assert.equal(initial.library.families.length, 2);
  const oldText = await readFile(app.file, 'utf8');
  await app.restart(); const reopened = await app.request();
  assert.equal(reopened.path, app.file); assert.equal(reopened.revision, initial.revision);
  reopened.library.families[0].data.people[0].notes = 'saved on disk';
  const saved = await app.request('', { library: reopened.library, revision: reopened.revision });
  assert.equal(saved.status, 200); assert.notEqual(saved.revision, reopened.revision);
  assert.equal(JSON.parse(await readFile(app.file, 'utf8')).families[0].data.people[0].notes, 'saved on disk');
  assert.equal(await readFile(`${app.file}.bak`, 'utf8'), oldText);
  assert.equal(saved.library.families[1].data.people[0].notes, 'two notes');
  assert.deepEqual((await readdir(app.root)).sort(), ['other', 'location.json', '家谱 data'].sort());
});

for (const hasBackup of [true, false]) test(`failed primary replacement preserves ${hasBackup ? 'the previous backup' : 'the absence of a backup'}`, async t => {
  const app = await setup(t), state = await app.connect(), original = await readFile(app.file, 'utf8');
  const previous = JSON.stringify({ ...state.library, activeId: 'two' });
  if (hasBackup) await writeFile(`${app.file}.bak`, previous);
  const rename = fs.rename;
  const fault = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === app.file) throw Object.assign(new Error('simulated primary rename denied'), { code: 'EPERM' });
    return rename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { fault.mock.restore(); syncBuiltinESMExports(); });
  const next = structuredClone(state.library); next.families[0].name = 'not committed';
  const result = await app.request('', { library: next, revision: state.revision });
  assert.equal(result.status, 500); assert.match(result.message, /primary rename denied/);
  assert.equal(await readFile(app.file, 'utf8'), original);
  if (hasBackup) assert.equal(await readFile(`${app.file}.bak`, 'utf8'), previous);
  else await assert.rejects(readFile(`${app.file}.bak`), { code: 'ENOENT' });
  assert.deepEqual((await readdir(app.directory)).sort(), hasBackup ? ['family-tree-library.json', 'family-tree-library.json.bak'] : ['family-tree-library.json']);
});

test('a failed backup rollback retains the previous backup in the reported recovery file', async t => {
  const app = await setup(t), state = await app.connect(), original = await readFile(app.file, 'utf8');
  const previous = JSON.stringify({ ...state.library, activeId: 'two' });
  await writeFile(`${app.file}.bak`, previous);
  const rename = fs.rename; let primaryDenied = false;
  const fault = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === app.file) { primaryDenied = true; throw new Error('primary rename denied'); }
    if (primaryDenied && to === `${app.file}.bak`) throw new Error('rollback rename denied');
    return rename(from, to);
  });
  syncBuiltinESMExports(); t.after(() => { fault.mock.restore(); syncBuiltinESMExports(); });
  const next = structuredClone(state.library); next.families[0].name = 'not committed';
  const result = await app.request('', { library: next, revision: state.revision });
  assert.equal(result.status, 503);
  assert.equal(await readFile(app.file, 'utf8'), original);
  const recovery = (await readdir(app.directory)).filter(name => name.endsWith('.tmp'));
  assert.equal(recovery.length, 1); assert.ok(result.message.includes(join(app.directory, recovery[0])));
  assert.equal(await readFile(join(app.directory, recovery[0]), 'utf8'), previous);
});

test('rejects stale and concurrent saves rather than losing updates', async t => {
  const app = await setup(t), state = await app.connect();
  const first = structuredClone(state.library), second = structuredClone(state.library);
  first.families[0].name = 'first'; second.families[0].name = 'second';
  const results = await Promise.all([app.request('', { library: first, revision: state.revision }), app.request('', { library: second, revision: state.revision })]);
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.ok(results.some(r => [409, 423].includes(r.status)));
  const stale = await app.request('', { library: second, revision: state.revision }); assert.equal(stale.status, 409);
});

test('changing location preserves the old file and copies the current complete disk library', async t => {
  const app = await setup(t), state = await app.connect(), before = await readFile(app.file, 'utf8');
  const moved = await app.request('/location', { directory: app.other, revision: state.revision });
  assert.equal(moved.status, 200); assert.equal(await readFile(app.file, 'utf8'), before);
  assert.equal(JSON.parse(await readFile(moved.path, 'utf8')).families.length, 2);
  assert.equal((await app.request('', { library: state.library, revision: state.revision })).status, 409);
});

test('never overwrites an existing target without explicit open and rechecks it after confirmation', async t => {
  const app = await setup(t), state = await app.request(); assert.equal(state.status, 200);
  const original = JSON.stringify(fixture()); await writeFile(app.file, original);
  const body = { directory: app.directory, library: fixture(), revision: state.revision };
  const conflict = await app.request('/location', body);
  assert.equal(conflict.status, 409); assert.equal(conflict.code, 'TARGET_EXISTS');
  assert.equal(await readFile(app.file, 'utf8'), original);
  await writeFile(app.file, `${original}\n`);
  assert.equal((await app.request('/location', { ...body, openExisting: true, targetRevision: conflict.targetRevision })).status, 409);
  const again = await app.request('/location', body);
  const opened = await app.request('/location', { ...body, openExisting: true, targetRevision: again.targetRevision });
  assert.equal(opened.status, 200); assert.equal(await readFile(app.file, 'utf8'), `${original}\n`);
});

for (const issue of ['missing', 'corrupt', 'external edit']) test(`${issue} disk data cannot be silently replaced or downgraded to browser mode`, async t => {
  const app = await setup(t), state = await app.connect();
  if (issue === 'missing') await rm(app.file);
  else await writeFile(app.file, issue === 'corrupt' ? '{broken' : JSON.stringify({ ...state.library, activeId: 'two' }));
  const saved = await app.request('', { library: state.library, revision: state.revision });
  assert.notEqual(saved.status, 200);
  if (issue !== 'external edit') assert.notEqual((await app.request()).status, 200);
  else assert.equal(saved.status, 409);
  if (issue === 'corrupt') assert.equal(await readFile(app.file, 'utf8'), '{broken');
});

test('failed backup or destination selection preserves the current file and configuration', async t => {
  const app = await setup(t), state = await app.connect();
  const config = await readFile(app.configPath, 'utf8'), text = await readFile(app.file, 'utf8');
  await mkdir(`${app.file}.bak`);
  const library = structuredClone(state.library); library.families[0].name = 'must not persist';
  assert.notEqual((await app.request('', { library, revision: state.revision })).status, 200);
  assert.equal(await readFile(app.file, 'utf8'), text);
  assert.notEqual((await app.request('/location', { directory: join(app.root, 'missing'), revision: state.revision })).status, 200);
  assert.equal(await readFile(app.configPath, 'utf8'), config);
  assert.ok(!(await readdir(app.directory)).some(name => name.endsWith('.tmp')));
});

test('invalid input and relative paths cannot create a configured file', async t => {
  const app = await setup(t), state = await app.request(); assert.equal(state.status, 200);
  for (const body of [{ directory: 'relative', library: fixture() }, { directory: app.directory, library: { version: 2, families: [], activeId: 'missing' } }]) {
    assert.notEqual((await app.request('/location', { ...body, revision: state.revision })).status, 200);
  }
  assert.equal((await app.request()).mode, 'browser');
  assert.deepEqual(await readdir(app.directory), []);
});

test('the browser storage client uses the real API and retains conflict details for confirmation', async t => {
  const app = await setup(t), browser = await app.client();
  const saved = await app.client('POST', { directory: app.directory, library: fixture(), revision: browser.revision }, '/location');
  saved.library.families[0].data.people[0].notes = 'client write';
  const updated = await app.client('PUT', { library: saved.library, revision: saved.revision });
  assert.equal(JSON.parse(await readFile(app.file, 'utf8')).families[0].data.people[0].notes, 'client write');
  await assert.rejects(app.client('PUT', { library: saved.library, revision: saved.revision }), error => error.status === 409);
  await writeFile(join(app.other, 'family-tree-library.json'), JSON.stringify(fixture()));
  await assert.rejects(app.client('POST', { directory: app.other, revision: updated.revision }, '/location'), error => error.status === 409 && error.code === 'TARGET_EXISTS' && typeof error.targetRevision === 'string');
  await app.restart(); assert.equal((await app.client()).revision, updated.revision);
});

test('normalization cannot publish an oversized archive that cannot be loaded again', async t => {
  const app = await setup(t), state = await app.request();
  const large = { version: 2, activeId: 'large', families: [{ id: 'large', name: 'large', data: { version: 1, selfId: '', relations: [], people: Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, name: `p${i}`, gender: 'unknown', ...(i < 80 ? { photo: 'data:image/png;base64,' + 'A'.repeat(187000) } : {}) })) } }] };
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 15000000);
  const result = await app.request('/location', { directory: app.directory, library: large, revision: state.revision });
  assert.equal(result.status, 400); assert.equal((await app.request()).mode, 'browser');
  assert.deepEqual(await readdir(app.directory), []);
});

test('storage APIs reject hostile origins, missing custom headers, DNS-rebinding hosts and simple POSTs', async t => {
  const app = await setup(t); assert.equal((await app.request()).status, 200);
  for (const headers of [{ Origin: 'https://example.com' }, { Origin: 'null' }, { Host: 'evil.example:4173' }, { 'X-Family-Tree': '' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await app.request('', undefined, headers)).status, 403, JSON.stringify(headers));
  }
  assert.equal((await app.request('/location', { directory: app.directory }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await app.request('', undefined, {}, 'OPTIONS')).status, 405);
});
