import crypto from 'node:crypto';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';

export const COMATE_LOCAL_AUTH_HEADER = 'x-miniproctor-comate-auth';

export function deriveComateLocalAuth(license, nonce) {
  if (typeof license !== 'string' || !license || !/^[0-9a-f]{64}$/.test(nonce || '')) {
    throw new TypeError('Comate local authentication requires a credential and random nonce');
  }
  return crypto.createHmac('sha256', license).update(`miniproctor-comate-local:${nonce}`).digest('hex');
}

export function guardComateHttpHandler(handler, localAuth) {
  if (typeof handler !== 'function' || !/^[0-9a-f]{64}$/.test(localAuth || '')) {
    throw new TypeError('Comate HTTP guard requires a handler and local authentication');
  }
  const expected = Buffer.from(localAuth);
  return (req, res) => {
    const supplied = req.headers[COMATE_LOCAL_AUTH_HEADER];
    const bytes = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
    if (bytes.length !== expected.length || !crypto.timingSafeEqual(bytes, expected)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'local-auth-required' }));
    }
    const method = req.method;
    const route = req.url || '';
    const allowed = (method === 'POST' && route === '/api/v1/conversations/init')
      || (method === 'GET' && /^\/api\/v1\/conversations\/[A-Za-z0-9_-]{1,128}\/history$/.test(route))
      || (method === 'POST' && /^\/api\/v1\/conversations\/[A-Za-z0-9_-]{1,128}\/cancel$/.test(route));
    if (!allowed) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unsupported-local-route' }));
    }
    return handler(req, res);
  };
}

/** Dedicated Comate child process only; install before importing the pinned CLI core. */
export function installComateHttpGuard(localAuth) {
  // Validate before changing the built-in module.
  guardComateHttpHandler(() => {}, localAuth);
  const nativeCreateServer = http.createServer;
  const servers = [];
  const guardedCreateServer = (...args) => {
    const index = args.findLastIndex((arg) => typeof arg === 'function');
    if (index < 0) throw new Error('Unexpected Comate HTTP server shape');
    const handler = guardComateHttpHandler(args[index], localAuth);
    args[index] = handler;
    const server = nativeCreateServer(...args);
    const listen = server.listen.bind(server);
    server.listen = (port, host, ...rest) => {
      if (host !== '127.0.0.1' || server.listenerCount('request') !== 1
        || server.listeners('request')[0] !== handler) {
        throw new Error('Comate HTTP server must use loopback and the authentication guard');
      }
      return listen(port, host, ...rest);
    };
    servers.push(server);
    return server;
  };
  http.createServer = guardedCreateServer;
  syncBuiltinESMExports();
  return {
    servers,
    restore() {
      if (http.createServer !== guardedCreateServer) throw new Error('Comate HTTP guard was replaced');
      http.createServer = nativeCreateServer;
      syncBuiltinESMExports();
    },
  };
}
