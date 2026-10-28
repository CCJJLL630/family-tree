import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createDiskLibrary } from './disk-library.js';
import { MAX_BACKUP_BYTES } from './src/family.js';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/node_modules/relationship.js/dist/relationship.min.mjs', ['node_modules/relationship.js/dist/relationship.min.mjs', 'text/javascript; charset=utf-8']],
  ...['app', 'family', 'demo', 'library', 'kinship', 'storage'].map(name => [`/src/${name}.js`, [`src/${name}.js`, 'text/javascript; charset=utf-8']])
]);
export function createAppServer({ configPath = fileURLToPath(new URL('.family-tree-storage.json', import.meta.url)) } = {}) {
  const disk = createDiskLibrary(configPath);
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { res.writeHead(400); res.end('Bad request'); return; }
    if (pathname === '/api/storage' || pathname === '/api/storage/location') {
      const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
      const host = req.headers.host, origin = req.headers.origin;
      if (![`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`].includes(host) ||
          (origin !== undefined && origin !== `http://${host}`) || req.headers['x-family-tree'] !== '1' ||
          (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
        send(403, { message: '仅允许本机家谱页面访问存档' }); return;
      }
      const allowed = pathname.endsWith('/location') ? ['POST'] : ['GET', 'PUT'];
      if (!allowed.includes(req.method)) { res.setHeader('Allow', allowed.join(', ')); send(405, { message: 'Method not allowed' }); return; }
      try {
        if (req.method === 'GET') { send(200, await disk.load()); return; }
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { send(415, { message: '请求必须使用 JSON' }); return; }
        let size = 0; const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BACKUP_BYTES + 65536) { send(413, { message: '存档超过容量限制' }); return; }
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(400, { message: '无效的 JSON 请求' }); return; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { send(400, { message: '无效的存档请求' }); return; }
        send(200, await (req.method === 'PUT' ? disk.save(body) : disk.select(body)));
      } catch (error) { send(error.status || 500, { message: error.message, ...(error.code === 'TARGET_EXISTS' ? { code: error.code, targetRevision: error.targetRevision } : {}) }); }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end('Method not allowed'); return; }
    if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const entry = files.get(pathname);
    if (!entry) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const content = await readFile(new URL(entry[0], import.meta.url));
      res.writeHead(200, { 'Content-Type': entry[1] }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch { res.writeHead(500); res.end('Unable to read application file'); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const server = createAppServer();
  server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`枝 · 家谱已启动：http://127.0.0.1:${port}\n仅接受本机访问。按 Ctrl+C 停止。`));
}
