// Minimal static server for local testing: node test/serve.js [port]
// Browsers allow the camera on http://localhost; a phone needs HTTPS.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

// The returned server has a `delayMs` property: set it to make every answer
// wait that long (a connection that hangs, for testing the offline copy).
export function startServer(port = 8123) {
  const server = http.createServer(async (req, res) => {
    if (server.delayMs) await new Promise((r) => { setTimeout(r, server.delayMs); });
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    const file = join(root, path || 'index.html');
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  server.delayMs = 0;
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 8123);
  startServer(port).then(() => console.log(`http://localhost:${port}/`));
}
