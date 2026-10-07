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
 * Another sidecar holding the port is normal and never reaches this: relay.js routes through it.
 * What does reach it is a port held by something that does not answer like a hub. Saying
 * "EADDRINUSE" and stopping would leave the reader to work out what; a tool that cannot run
 * should still explain itself.
 */
export function describeStartupFailure(err, port) {
  if (err && err.code === 'EADDRINUSE') {
    return 'the sidecar could not claim 127.0.0.1:' + port + ', and whatever holds it does not ' +
      'answer like another Pi Connect sidecar. Find it (on Windows: netstat -ano | findstr :' +
      port + ') and stop it; this sidecar keeps trying the port and takes it once it is free. ' +
      'Or set PIX_PORT to another port. Note the userscript looks for ' + DEFAULT_PORT +
      ', so a different port needs the script changed to match.';
  }
  return 'the sidecar could not start its loopback listener: ' + (err && err.message);
}

/**
 * @param {object}   [opts]
 * @param {number}   [opts.port]
 * @param {string}   [opts.origin]  the only browser origin allowed to connect
 * @param {function} [opts.log]     called with human-readable status lines
 * @param {number}   [opts.helloTimeoutMs]  how long a second page has to introduce itself
 */
export function createHub(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  const origin = opts.origin ?? DEFAULT_ORIGIN;
  const log = opts.log ?? (() => {});
  const helloTimeoutMs = opts.helloTimeoutMs ?? 2000;

  let client = null;          // the one connected page
  let clientInfo = null;      // what it has told us about itself: version, path, shell
  let lastError = null;       // why the hub is not usable, if it is not
  let nextId = 1;
  const pending = new Map();  // id -> { resolve, reject, timer, ws }

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
      // pid and parentPid say which process holds the port, and so which Claude Code session:
      // its parent. Finding that by hand took an hour of matching process start times against
      // session creation times (2026-10-07).
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, connected: isConnected(), page: clientInfo,
                               pid: process.pid, parentPid: process.ppid }));
      return;
    }
    if (req.url === '/run') { handleRun(req, res); return; }
    if (req.url === '/call') { handleCall(req, res); return; }
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

    // What this page has said about itself. Kept per socket, because a second page's facts are
    // what decide whether it gets the bridge, before it holds anything.
    let info = null;
    let undecided = null;       // a second page's hello deadline; null once its fate is settled

    if (isConnected()) {
      undecided = setTimeout(() => { undecided = null; standBy(ws); }, helloTimeoutMs);
    } else {
      hold(ws, null);
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return log('ignored an unparseable frame'); }

      if (msg.type === 'hello' || msg.type === 'status') {
        info = readInfo(msg, msg.type === 'hello' ? null : info);
        if (ws === client) {
          clientInfo = info;
          if (msg.type === 'hello') log('bridge v' + info.version + ' on ' + info.path + shellNote(info));
          else log('the attached page' + shellNote(info));
        } else if (undecided && msg.type === 'hello') {
          clearTimeout(undecided);
          undecided = null;
          contend(ws, info);
        }
        return;
      }

      const entry = pending.get(msg.id);
      if (!entry || entry.ws !== ws) return;    // timed out already, or not asked of this page
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || 'the bridge reported an unspecified failure'));
    });

    ws.on('close', () => {
      if (undecided) { clearTimeout(undecided); undecided = null; }
      if (client === ws) { client = null; clientInfo = null; log('page disconnected'); }
      failCallsTo(ws);
    });
    ws.on('error', (e) => log('socket error: ' + e.message));
  });

  function hold(ws, info) {
    client = ws;
    clientInfo = info;
    log('page connected' + (info ? ': bridge v' + info.version + ' on ' + info.path + shellNote(info) : ''));
  }

  // A second Pi Connect page, judged on its hello.
  //
  // The first version of this preferred the *newest* page and closed the incumbent, which turned
  // two open tabs into an infinite ping-pong: each one is dropped, reconnects a second later,
  // drops the other, forever. Observed live: a page's event log read connected/disconnected/
  // connected/disconnected without end, and any command would land on whichever tab happened to
  // hold the slot at that instant. So the incumbent keeps the slot and newcomers stand by, retry
  // slowly, and take over within ~30s of the holder going away.
  //
  // That alone let the wrong page win. The userscript runs on every connect.raspberrypi.com page,
  // so the /devices dashboard attaches too, and when it got there first it held the bridge with
  // no shell behind it while the real remote-shell window stood by indefinitely (seen 2026-10-06:
  // pi_health named /devices, "no shell channel", 0 peer connections). Hence the one exception:
  // a page that reports a live shell replaces a holder that has reported having none.
  //
  // That exception cannot ping-pong. A takeover needs the holder to have said "no shell" and the
  // newcomer to have said "shell". Afterwards the holder has a shell and the displaced page has
  // none, so it can only win back if the new holder actually loses its shell -- a real event, not
  // a reconnect. Two shell pages, or two shell-less ones, never displace each other: first come
  // keeps it. A bridge older than 0.2.2 never mentions its shell, and unknown neither wins nor
  // loses, which is exactly the old behaviour.
  function contend(ws, info) {
    if (!isConnected()) { hold(ws, info); return; }          // the holder left while we waited
    if (info.shell === true && clientInfo && clientInfo.shell === false) {
      const displaced = client;
      log('a page with a live shell (' + info.path + ') takes over from one without (' +
          clientInfo.path + ')');
      hold(ws, info);
      try { displaced.close(4002, 'a page with a live shell took over'); } catch { /* gone */ }
      return;
    }
    standBy(ws);
  }

  function standBy(ws) {
    log('another page is already attached; asking the newcomer to stand by');
    ws.close(4001, 'another page already holds the bridge');
  }

  // A hello replaces what we knew about a page; a status updates it.
  function readInfo(msg, prev) {
    const next = { ...prev };
    if ('version' in msg) next.version = msg.version;
    if ('path' in msg) next.path = msg.path;
    if (typeof msg.shell === 'boolean') next.shell = msg.shell;
    return next;
  }

  function shellNote(info) {
    return info.shell === true ? ', shell open' : info.shell === false ? ', no shell' : '';
  }

  // A page that goes away mid-call will never answer. Say so now rather than after the timeout.
  // The command may already have reached the Pi, so this claims nothing about whether it ran.
  function failCallsTo(ws) {
    for (const [id, entry] of pending) {
      if (entry.ws !== ws) continue;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error('the page holding the bridge went away before answering; ' +
                             'the command may or may not have run'));
    }
  }

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
    const ws = client;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('the page did not answer within ' + timeoutMs + 'ms'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, ws });
      try {
        ws.send(JSON.stringify({ id, method, params }));
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

  // POST /run and POST /call: the same calls the pi_* tools make, for a native program on this
  // machine that wants the Pi without going through this process's tools. That is another MCP
  // server, a script, or another session's sidecar relaying through this one (relay.js).
  //
  // Web pages must never reach either route, and three guards keep them out. Any one of them is
  // enough:
  //   - A browser always sends Origin on a POST, and page JavaScript cannot remove it, so any
  //     request carrying an Origin is refused. That includes the Pi Connect page, which holds
  //     the shell already.
  //   - Host must be this loopback address itself, which defeats DNS rebinding.
  //   - The body must be application/json, which a plain HTML form cannot send.
  // A native process can forge all three, and that's accepted: it already runs as the user, with
  // more reach than this hub grants (CLAUDE.md, rule 12). Both routes go through readNative(), so
  // the guards cannot drift apart.
  const NATIVE_BODY_MAX = 64 * 1024;

  function answerNative(res, status, body) {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  /** Apply the guards, then hand the parsed JSON body to `then`, or answer the refusal. */
  function readNative(req, res, route, then) {
    const refuse = (status, error) => answerNative(res, status, { ok: false, error });
    if (req.method !== 'POST') return refuse(405, 'POST only');
    if (req.headers.origin !== undefined) return refuse(403, 'browsers may not call ' + route);
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
      if (size > NATIVE_BODY_MAX) { refuse(413, 'body over ' + NATIVE_BODY_MAX + ' bytes'); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return refuse(400, 'the body is not JSON'); }
      if (!body || typeof body !== 'object') return refuse(400, 'the body must be a JSON object');
      then(body, refuse);
    });
  }

  function handleRun(req, res) {
    readNative(req, res, '/run', async (body, refuse) => {
      if (typeof body.command !== 'string' || !body.command) {
        return refuse(400, 'command (a non-empty string) is required');
      }
      const timeout = Number.isFinite(body.timeout) && body.timeout > 0 ? body.timeout : 30000;
      try {
        // As pi_run does: the page gets longer than the command, so a slow command comes back
        // as a timed-out result rather than a dead transport.
        const result = await run({ command: body.command, timeout, shell: body.shell }, timeout + 15000);
        answerNative(res, 200, result);
      } catch (e) {
        refuse(503, e.message);
      }
    });
  }

  // POST /call: the rest of the tools, { method, params, timeout }, answered { ok, result }.
  // Only the methods the pi_* tools use. `run` stays on /run, where runs queue for the one
  // terminal; the page's other methods (clear, resize, raw) have no tool and no caller.
  const CALL_METHODS = ['send', 'key', 'expect', 'tail', 'screen', 'health'];
  const CALL_TIMEOUT_MAX = 10 * 60 * 1000;

  function handleCall(req, res) {
    readNative(req, res, '/call', async (body, refuse) => {
      if (!CALL_METHODS.includes(body.method)) {
        return refuse(400, 'method must be one of ' + CALL_METHODS.join(', ') + '; runs go to /run');
      }
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      const timeout = Number.isFinite(body.timeout) && body.timeout > 0
        ? Math.min(body.timeout, CALL_TIMEOUT_MAX) : 45000;
      try {
        answerNative(res, 200, { ok: true, result: await call(body.method, params, timeout) });
      } catch (e) {
        refuse(503, e.message);
      }
    });
  }

  // `ws` re-emits the HTTP server's errors on itself, and an 'error' event with no listener is a
  // throw. Without this, a busy port took down the whole process -- including the MCP server that
  // had not started yet -- and the caller saw only "Connection closed" with no hint of a port.
  // A busy port is not logged here: listen() rejects with it, and relay.js retries it every few
  // seconds, which would otherwise print the same line forever.
  wss.on('error', (e) => {
    lastError = e;
    if (e.code !== 'EADDRINUSE') log('websocket server error: ' + e.message);
  });

  // Safe to call again after it fails: Node lets a server retry listen() after an error, which
  // is how a sidecar that started second takes the port over once the holder exits.
  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (e) => { lastError = e; reject(e); };
      httpServer.once('error', onError);
      httpServer.listen(port, '127.0.0.1', () => {      // loopback only, never the LAN
        httpServer.removeListener('error', onError);
        lastError = null;
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

  return { call, run, listen, close, isConnected, listening: () => httpServer.listening,
           info: () => clientInfo, error: () => lastError, port };
}
