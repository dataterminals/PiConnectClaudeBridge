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
 * Turn a startup failure into something a person can act on.
 *
 * A busy port is overwhelmingly the common case, and it has one overwhelmingly common cause: an
 * earlier sidecar that never exited. Saying "EADDRINUSE" and stopping would leave the reader to
 * work that out; a tool that cannot run should still explain itself.
 */
export function describeStartupFailure(err, port) {
  if (err && err.code === 'EADDRINUSE') {
    return 'the sidecar could not claim 127.0.0.1:' + port + ' because something else already ' +
      'holds it — almost always an earlier sidecar that outlived its session. Stop that process ' +
      '(on Windows: netstat -ano | findstr :' + port + ', then taskkill /PID <pid> /F) and ' +
      'restart, or set PIX_PORT to another port. Note the userscript looks for ' + DEFAULT_PORT +
      ', so a different port needs the script changed to match.';
  }
  return 'the sidecar could not start its loopback listener: ' + (err && err.message);
}

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
  let lastError = null;       // why the hub is not usable, if it is not
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
    if (req.url === '/run') { handleRun(req, res); return; }
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
      // A second Pi Connect tab. The first version of this preferred the *newest* and closed the
      // incumbent — which turned two open tabs into an infinite ping-pong: each one is dropped,
      // reconnects a second later, drops the other, forever. Observed live: a page's event log
      // read connected/disconnected/connected/disconnected without end, and any command would
      // land on whichever tab happened to hold the slot at that instant.
      //
      // So the incumbent keeps the slot and newcomers are told to stand by. They retry slowly and
      // take over within ~30s of the holder going away, which is stable and needs no coordination
      // between tabs.
      log('another page is already attached; asking the newcomer to stand by');
      ws.close(4001, 'another page already holds the bridge');
      return;
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
    if (lastError) {
      return Promise.reject(new Error(describeStartupFailure(lastError, port)));
    }
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

  /**
   * Run a command on the page, one at a time.
   *
   * Every caller shares one terminal. Two runs in flight at once would type the second command
   * line into the PTY while the first is still printing, and its echo would land inside the
   * first one's output. So runs queue here, whether they come from pi_run or from POST /run.
   */
  let runChain = Promise.resolve();
  function run(params, timeoutMs) {
    const next = runChain.then(() => call('run', params, timeoutMs));
    runChain = next.catch(() => {});
    return next;
  }

  // POST /run: the same run as pi_run, for a native program on this machine (another MCP server,
  // a script) that wants the Pi without going through this process's tools.
  //
  // Web pages must never reach it, and three guards keep them out. Any one of them is enough:
  //   - A browser always sends Origin on a POST, and page JavaScript cannot remove it, so any
  //     request carrying an Origin is refused. That includes the Pi Connect page, which holds
  //     the shell already.
  //   - Host must be this loopback address itself, which defeats DNS rebinding.
  //   - The body must be application/json, which a plain HTML form cannot send.
  // A native process can forge all three, and that's accepted: it already runs as the user, with
  // more reach than this hub grants (CLAUDE.md, rule 12).
  const RUN_BODY_MAX = 64 * 1024;

  function answerRun(res, status, body) {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function handleRun(req, res) {
    const refuse = (status, error) => answerRun(res, status, { ok: false, error });
    if (req.method !== 'POST') return refuse(405, 'POST only');
    if (req.headers.origin !== undefined) return refuse(403, 'browsers may not call /run');
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) {
      return refuse(403, 'Host must be 127.0.0.1:' + port);
    }
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
      return refuse(415, 'send the body as application/json');
    }

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > RUN_BODY_MAX) { refuse(413, 'body over ' + RUN_BODY_MAX + ' bytes'); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', async () => {
      if (res.headersSent) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return refuse(400, 'the body is not JSON'); }
      if (!body || typeof body.command !== 'string' || !body.command) {
        return refuse(400, 'command (a non-empty string) is required');
      }
      const timeout = Number.isFinite(body.timeout) && body.timeout > 0 ? body.timeout : 30000;
      try {
        // As pi_run does: the page gets longer than the command, so a slow command comes back
        // as a timed-out result rather than a dead transport.
        const result = await run({ command: body.command, timeout, shell: body.shell }, timeout + 15000);
        answerRun(res, 200, result);
      } catch (e) {
        refuse(503, e.message);
      }
    });
  }

  // `ws` re-emits the HTTP server's errors on itself, and an 'error' event with no listener is a
  // throw. Without this, a busy port took down the whole process -- including the MCP server that
  // had not started yet -- and the caller saw only "Connection closed" with no hint of a port.
  wss.on('error', (e) => { lastError = e; log('websocket server error: ' + e.message); });

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (e) => { lastError = e; reject(e); };
      httpServer.once('error', onError);
      httpServer.listen(port, '127.0.0.1', () => {      // loopback only, never the LAN
        httpServer.removeListener('error', onError);
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

  return { call, run, listen, close, isConnected, info: () => clientInfo, error: () => lastError, port };
}
