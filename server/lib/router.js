'use strict';

// Minimal dependency-free router with :param support and JSON body parsing.

class Router {
  constructor() {
    this.routes = []; // { method, pattern, keys, handler }
  }

  _register(method, pattern, handler) {
    const keys = [];
    const regexStr = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    const regex = new RegExp(`^${regexStr}/?$`);
    this.routes.push({ method, regex, keys, handler });
  }

  get(pattern, handler) { this._register('GET', pattern, handler); }
  post(pattern, handler) { this._register('POST', pattern, handler); }
  put(pattern, handler) { this._register('PUT', pattern, handler); }
  patch(pattern, handler) { this._register('PATCH', pattern, handler); }
  delete(pattern, handler) { this._register('DELETE', pattern, handler); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
    }
    return null;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 5 * 1024 * 1024; // 5MB cap
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

module.exports = { Router, readJsonBody, sendJson, HttpError };
