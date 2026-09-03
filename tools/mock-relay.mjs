// Local in-memory mock of the WeChat cloud relay (W1-W2). Not part of the mini program.
// Endpoints: /report /commands /status /events /register-pairing /pairing-status /bind-pairing.
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

function sha256(v) {
  return crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');
}

export function createMockRelay({ onReport, onCommand } = {}) {
  const events = [];
  const commands = [];
  const statuses = [];
  const pairings = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, data) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, events: events.length, pairings: pairings.length });
    if (req.method === 'GET' && url.pathname === '/events') return send(200, { events });
    if (req.method === 'GET' && url.pathname === '/commands') {
      const due = commands.filter((c) => c.status === 'pending');
      for (const c of due) c.status = 'delivered';
      return send(200, { commands: due });
    }
    if (req.method === 'POST' && url.pathname === '/report') {
      const body = await readBody(req);
      const batch = Array.isArray(body?.events) ? body.events : [];
      for (const event of batch) events.push({ ...event, relay_received_at: Date.now() });
      onReport?.(batch, body);
      return send(200, { ok: true, accepted: batch.length });
    }
    if (req.method === 'POST' && url.pathname === '/status') {
      const body = await readBody(req);
      statuses.push({ ...body, received_at: Date.now() });
      return send(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/commands') {
      const body = await readBody(req);
      const command = { command_id: `c_${crypto.randomUUID()}`, status: 'pending', created_at: Date.now(), ...body };
      commands.push(command);
      onCommand?.(command);
      return send(200, { ok: true, command });
    }
    if (req.method === 'POST' && url.pathname === '/register-pairing') {
      const body = await readBody(req);
      const pairing = { ...body, status: 'pending', created_at: Date.now() };
      pairings.push(pairing);
      return send(200, { ok: true, pairing_id: pairing.pairing_id, expires_at: Date.now() + Number(body.ttl_ms || 600000) });
    }
    if (req.method === 'GET' && url.pathname === '/pairing-status') {
      const pairing = pairings.find((p) => p.pairing_id === url.searchParams.get('pairing_id'));
      return send(200, { ok: Boolean(pairing), status: pairing?.status || 'not-found' });
    }
    if (req.method === 'POST' && url.pathname === '/bind-pairing') {
      const body = await readBody(req);
      let pairing;
      if (body.pairing_id) pairing = pairings.find((p) => p.pairing_id === body.pairing_id);
      else if (body.code) pairing = pairings.find((p) => p.pairing_code_hash === sha256(body.code));
      if (!pairing) return send(404, { ok: false, error: 'pairing-not-found' });
      if (pairing.pairing_id && body.nonce && pairing.nonce_hash !== sha256(body.nonce)) {
        return send(403, { ok: false, error: 'nonce-mismatch' });
      }
      if (pairing.status !== 'pending') return send(409, { ok: false, error: 'pairing-not-pending' });
      pairing.status = 'bound';
      pairing.bound_at = Date.now();
      return send(200, { ok: true, status: 'bound', device_id: pairing.device_id, device_name: pairing.device_name });
    }
    return send(404, { ok: false, error: 'not-found' });
  });

  return {
    server,
    events,
    commands,
    statuses,
    pairings,
    async start(port = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
      });
      return server.address().port;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || process.argv[2] || 8790);
  const relay = createMockRelay();
  await relay.start(port);
  console.log(`mock-relay listening http://127.0.0.1:${port}`);
}
