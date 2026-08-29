'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { Router, readJsonBody, sendJson, HttpError } = require('./lib/router');
const auth = require('./lib/auth');

const router = new Router();
require('./routes/auth').register(router);
require('./routes/account').register(router);
require('./routes/musicians').register(router);
require('./routes/bookings').register(router);
require('./routes/favorites').register(router);
require('./routes/notifications').register(router);
require('./routes/equipment').register(router);
require('./routes/rentals').register(router);
require('./routes/admin').register(router);
require('./routes/reports').register(router);
require('./routes/disputes').register(router);

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, decodeURIComponent(pathname));
  if (pathname === '/' || pathname === '') filePath = path.join(PUBLIC_DIR, 'index.html');
  // Prevent path traversal outside PUBLIC_DIR.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback: unknown non-API GET routes serve index.html.
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexPath, (e2, data) => {
        if (e2) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (!pathname.startsWith('/api/')) {
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    res.writeHead(404);
    return res.end('Not found');
  }

  const query = {};
  parsedUrl.searchParams.forEach((v, k) => { query[k] = v; });

  const match = router.match(req.method, pathname);
  if (!match) return sendJson(res, 404, { error: 'Not found' });

  try {
    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      body = await readJsonBody(req);
    }
    const user = auth.getSessionUser(req);
    const ctx = { req, res, params: match.params, query, body, user };
    const result = await match.handler(ctx);
    sendJson(res, 200, result === undefined ? {} : result);
  } catch (err) {
    if (err instanceof HttpError || err.statusCode) {
      sendJson(res, err.statusCode, { error: err.message });
    } else {
      console.error(err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Musician Connect server running at http://localhost:${PORT}`);
});

module.exports = server;
