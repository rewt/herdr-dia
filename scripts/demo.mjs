#!/usr/bin/env node
// Serve the real panel against fixture data — no Herdr, no GitHub, no native host.
//
//   node scripts/demo.mjs        # then open the printed URL
//   node scripts/demo.mjs 8750   # a port of your choice (or PORT=8750)
//
// The default port is 8742. If something is already listening there (usually an earlier demo
// that was never stopped), the next free port is used and the printed URL says which. A port
// given explicitly is never changed: the demo stops and says so instead.
//
// panel.html/.css/.js are served straight from extension/ (unmodified); the only change is
// one injected <script> that installs a fake `chrome` object answering the host's routes with
// the invented repositories in docs/demo/fixtures.js. This is what the screenshots in
// docs/screenshots were taken from, so anyone can reproduce them without an account.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requested = process.argv[2] || process.env.PORT;
let port = Number(requested || 8742);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  try {
    if (path === '/' || path === '/index.html' || path === '/panel.html') {
      const html = await readFile(join(root, 'extension/panel.html'), 'utf8');
      // panel.js is a module script (it imports logic.js); fixtures.js is a classic one, so
      // it runs during parsing and has the fake `chrome` in place before the panel starts.
      const withFixtures = html.replace(
        /<script[^>]*src="panel\.js"[^>]*><\/script>/,
        (tag) => `<script src="fixtures.js"></script>\n  ${tag}`,
      );
      if (withFixtures === html) throw new Error('could not inject fixtures into panel.html');
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end(withFixtures);
    }

    const file = path === '/fixtures.js'
      ? join(root, 'docs/demo/fixtures.js')
      : join(root, 'extension', path.replace(/^\/+/, ''));
    if (!file.startsWith(root)) throw Object.assign(new Error('nope'), { code: 'ENOENT' });

    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' });
    res.end(String(error.message));
  }
});

server.on('error', (error) => {
  if (error.code !== 'EADDRINUSE') throw error;
  if (requested || port >= 8742 + 20) {
    console.error(`port ${port} is already in use. Stop whatever is listening there, or pick another: node scripts/demo.mjs 8750`);
    process.exit(1);
  }
  console.error(`port ${port} is in use (an earlier demo is probably still running there); trying ${port + 1}`);
  port += 1;
  server.listen(port);
});
server.on('listening', () => {
  console.log(`herdr-dia demo panel: http://localhost:${port}/`);
  console.log('Fixture data only — every repository, author and pull request in it is invented.');
  console.log('The panel is ~400px wide in a browser side panel; narrow the window to match.');
});
server.listen(port);
