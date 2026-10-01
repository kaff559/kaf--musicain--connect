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
require('./routes/password-reset').register(router);
require('./routes/musicians').register(router);
require('./routes/bookings').register(router);
require('./routes/jobs').register(router);
require('./routes/favorites').register(router);
require('./routes/notifications').register(router);
require('./routes/equipment').register(router);
require('./routes/rentals').register(router);
require('./routes/admin').register(router);
require('./routes/reports').register(router);
require('./routes/disputes').register(router);

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Uploaded demo files live under data/uploads (not public/) so they sit on
// the same persistent disk as the SQLite database — see DEPLOY.md. Anything
// written to public/ instead would be lost on every redeploy just like the
// database would be without that persistent volume.
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

function serveUploads(req, res, pathname) {
  const rel = decodeURIComponent(pathname.slice('/uploads/'.length));
  const filePath = path.join(UPLOADS_DIR, rel);
  // Prevent path traversal outside UPLOADS_DIR.
  if (!filePath.startsWith(UPLOADS_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    // No caching: each uploaded filename is unique (upload writes a new file
    // rather than overwriting), but a removed demo should disappear for
    // viewers immediately rather than lingering from browser cache.
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

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

  if (pathname.startsWith('/uploads/')) {
    if (req.method === 'GET' || req.method === 'HEAD') return serveUploads(req, res, pathname);
    res.writeHead(404);
    return res.end('Not found');
  }

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
      // Demo file / profile photo uploads arrive as base64 JSON and need much
      // more headroom than every other (tiny) JSON body in this app.
      const BIG_BODY_ROUTES = [
        '/api/musicians/demo-upload',
        '/api/musicians/photo-upload',
        '/api/musicians/gallery-upload',
        '/api/equipment-owner/photo-upload',
      ];
      const maxBytes = BIG_BODY_ROUTES.includes(pathname) ? 16 * 1024 * 1024 : undefined;
      body = await readJsonBody(req, maxBytes);
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
