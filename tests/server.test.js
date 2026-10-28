import test from 'node:test';
import assert from 'node:assert/strict';
import * as serverModule from '../server.js';

test('serves the app locally while keeping arbitrary workspace files inaccessible', async () => {
  assert.equal(typeof serverModule.createAppServer, 'function');
  const server = serverModule.createAppServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const root = await fetch(base);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type'), /text\/html/);
    assert.match(root.headers.get('content-security-policy'), /connect-src 'self'/);
    for (const path of ['/package.json', '/server.js', '/disk-library.js', '/.family-tree-storage.json', '/.family-tree-storage.json.lock', '/family-tree-library.json', '/tests/server.test.js', '/%2e%2e%5cpackage.json', '/src/missing.js']) assert.equal((await fetch(base + path)).status, 404);
    assert.equal((await fetch(base, { method: 'POST', body: 'private' })).status, 405);
    assert.equal((await fetch(base + '/src/family.js')).status, 200);
    const library = await fetch(base + '/src/library.js');
    assert.equal(library.status, 200);
    assert.match(library.headers.get('content-type'), /javascript/);
    for (const path of ['/src/kinship.js', '/src/storage.js', '/node_modules/relationship.js/dist/relationship.min.mjs']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /javascript/);
      assert.ok((await response.text()).length > 0);
    }
    for (const path of ['/node_modules/relationship.js/package.json', '/node_modules/relationship.js/LICENSE', '/node_modules/relationship.js/dist/relationship.js']) {
      assert.equal((await fetch(base + path)).status, 404);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
