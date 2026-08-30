// The loopback hub: one WebSocket server that the bridge userscript connects back to, and a
// request/response correlator on top of it.
//
// WHY THERE IS AN HTTP SERVER HERE AT ALL. A bare `new WebSocketServer({ port })` does not work
// from connect.raspberrypi.com, and it fails in the least helpful way available: Chrome and Edge
// open the TCP connection, never complete the handshake, and fire no event and log no error. The
// page just sits there `pending` forever. Observed 2026-08-30 — netstat showed msedge ESTABLISHED
// against the node process while the server had logged no connection at all.
//
// The cause is Private Network Access. A public HTTPS origin reaching a loopback address must
// first pass a CORS preflight that the target answers with `Access-Control-Allow-Private-Network`.
// `ws`'s built-in server answers 426 to anything that is not an upgrade, which fails the
// preflight silently. So we run a real HTTP server, answer the preflight properly, and attach the
// WebSocket server to it.
//
// (`ws://` to a loopback host is NOT blocked as mixed content — loopback counts as a potentially
// trustworthy origin. PNA is a separate mechanism and the one that actually bites.)

import http from 'node:http';
import { WebSocketServer } from 'ws';

export const DEFAULT_PORT = 8732;
export const DEFAULT_ORIGIN = 'https://connect.raspberrypi.com';
export const WS_PATH = '/pix';

/**
 * @param {object}   [opts]
 * @param {number}   [opts.port]
 * @param {string}   [opts.origin]  the only browser origin allowed to connect
 * @param {function} [opts.log]     called with human-readable status lines
 */
export function createHub(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  const origin = opts.origin ?? DEFAULT_ORIGIN;
  const log = opts.log ?? (() => {});

  let client = null;          // the one connected page
  let clientInfo = null;      // whatever it told us about itself on connect
  let nextId = 1;
  const pending = new Map();  // id -> { resolve, reject, timer }

  function applyCorsHeaders(req, res) {
    if (req.headers.origin === origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    // The header that makes a public origin -> loopback request legal at all.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
  }

  const httpServer = http.createServer((req, res) => {
    applyCorsHeaders(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, connected: isConnected(), page: clientInfo }));
      return;
    }
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('Upgrade Required');
  });

  const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });

  wss.on('connection', (ws, req) => {
    // Browsers set Origin themselves and page JavaScript cannot forge it, so this keeps any other
    // website on this machine from reaching the Pi through the hub. It does NOT stop a native
    // process on this machine, which can send whatever headers it likes — but such a process
    // already has more reach than this hub grants. Documented, not pretended away.
    if (req.headers.origin !== origin) {
      log('refused a connection from origin ' + req.headers.origin);
      ws.close(4003, 'origin not allowed');
      return;
    }

    if (client && client.readyState === 1) {
      // A second Pi Connect tab. Prefer the newest, or two tabs would race for every reply.
      log('a newer page connected; dropping the previous one');
      try { client.close(4000, 'superseded by a newer tab'); } catch { /* already gone */ }
    }
    client = ws;
    clientInfo = null;
    log('page connected');

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return log('ignored an unparseable frame'); }

      if (msg.type === 'hello') {
        clientInfo = { version: msg.version, path: msg.path };
        log('bridge v' + msg.version + ' on ' + msg.path);
        return;
      }

      const entry = pending.get(msg.id);
      if (!entry) return;                       // a reply to something that already timed out
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || 'the bridge reported an unspecified failure'));
    });

    ws.on('close', () => {
      if (client === ws) { client = null; clientInfo = null; log('page disconnected'); }
    });
    ws.on('error', (e) => log('socket error: ' + e.message));
  });

  function isConnected() { return !!client && client.readyState === 1; }

  /**
   * Call a method on the page and wait for its reply.
   *
   * The timeout here is deliberately longer than the one the page applies to the command itself,
   * so that a slow command comes back as a proper `{timedOut: true}` *result* rather than as a
   * transport error. Only a genuinely unreachable page should trip this.
   */
  function call(method, params = {}, timeoutMs = 45000) {
    if (!isConnected()) {
      return Promise.reject(new Error(
        'no Pi Connect page is connected. Open the remote shell for the device in the browser ' +
        'and make sure the bridge userscript is installed and enabled.'));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('the page did not answer within ' + timeoutMs + 'ms'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        client.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  function listen() {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', () => {      // loopback only, never the LAN
        log('listening on 127.0.0.1:' + port);
        resolve();
      });
    });
  }

  function close() {
    for (const [, e] of pending) { clearTimeout(e.timer); e.reject(new Error('hub shutting down')); }
    pending.clear();
    for (const ws of wss.clients) { try { ws.close(1001, 'shutting down'); } catch { /* gone */ } }
    wss.close();
    return new Promise((resolve) => httpServer.close(resolve));
  }

  return { call, listen, close, isConnected, info: () => clientInfo, port };
}
