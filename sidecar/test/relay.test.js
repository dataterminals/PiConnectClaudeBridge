// Several sidecars, one port: the one that holds it is the hub, the rest relay through it, and
// one of them takes over when the holder goes away (src/relay.js). Every sidecar here is a real
// hub + relay pair on the same port, in this one process, so a "session ending" is a close().
//
//   node test/relay.test.js

import assert from 'node:assert';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createHub } from '../src/hub.js';
import { createRelay } from '../src/relay.js';

const ORIGIN = 'https://connect.raspberrypi.com';
const PORT = 8796;                     // not the default, so a running sidecar does not collide
const WSURL = 'ws://127.0.0.1:' + PORT + '/pix';
const RETRY = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(20);
  }
}

// Every sidecar a test starts, so the runner can shut down whatever a failing test left behind.
// Otherwise one failure leaves a holder on the port and every later test fails with it.
const live = new Set();

/** One session's sidecar: a hub and the relay around it. */
async function sidecar(retryMs = RETRY) {
  const hub = createHub({ port: PORT, helloTimeoutMs: 200 });
  const relay = createRelay({ hub, retryMs });
  const s = { hub, relay, async exit() { live.delete(s); relay.stop(); await hub.close(); } };
  live.add(s);
  await relay.start();
  return s;
}

/** The userscript's side of the link, answering whatever it is asked. */
function fakePage(handler) {
  const ws = new WebSocket(WSURL, { origin: ORIGIN });
  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString());
    try { ws.send(JSON.stringify({ id: msg.id, ok: true, result: await handler(msg) })); }
    catch (e) { ws.send(JSON.stringify({ id: msg.id, ok: false, error: e.message })); }
  });
  return new Promise((res, rej) => { ws.once('open', () => res(ws)); ws.once('error', rej); });
}

async function attach(handler) { const ws = await fakePage(handler); await sleep(50); return ws; }

/** Something on the port that is not a sidecar at all. */
function squat(handler) {
  const server = http.createServer(handler);
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(PORT, '127.0.0.1', () => res(server));
  });
}
const unsquat = (server) => new Promise((res) => server.close(res));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// The bug from 2026-10-07: the second session's tools could only say the port was taken.
test('the first sidecar holds the port and a second relays through it', async () => {
  const a = await sidecar();
  const b = await sidecar();
  try {
    assert.strictEqual(a.relay.isHub(), true);
    assert.strictEqual(b.relay.isHub(), false);
    const page = await attach((msg) => msg.method === 'run'
      ? { ok: true, exitCode: 0, stdout: 'ran ' + msg.params.command, ms: 1 }
      : 'tail from the page');

    const r = await b.relay.run({ command: 'uptime', timeout: 5000 }, 20000);
    assert.strictEqual(r.stdout, 'ran uptime');
    assert.strictEqual(await b.relay.call('tail', { chars: 10 }), 'tail from the page');
    page.close();
  } finally { await b.exit(); await a.exit(); }
});

test('pi_health from a relay names the holder and its page', async () => {
  const a = await sidecar();
  const b = await sidecar();
  try {
    const page = new WebSocket(WSURL, { origin: ORIGIN });
    page.once('open', () => page.send(JSON.stringify({ type: 'hello', version: '0.2.3', path: '/devices/x/remote-shell-session', shell: true })));
    page.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      page.send(JSON.stringify({ id: msg.id, ok: true, result: { ok: true, problems: [] } }));
    });
    await until('the page to say hello', () => a.hub.info() && a.hub.info().shell === true);

    const h = await b.relay.health();
    assert.match(h.holder, new RegExp('another sidecar \\(pid ' + process.pid + ', parent pid ' + process.ppid));
    assert.strictEqual(h.attachedPage.path, '/devices/x/remote-shell-session');
    assert.deepStrictEqual(h.bridge, { ok: true, problems: [] });
    assert.match((await a.relay.health()).holder, /^this sidecar/);
    page.close();
  } finally { await b.exit(); await a.exit(); }
});

// One terminal, so a relayed run must queue behind the holder's own.
test('runs from two sidecars still take turns', async () => {
  const a = await sidecar();
  const b = await sidecar();
  try {
    let inFlight = 0, most = 0;
    const page = await attach(async (msg) => {
      most = Math.max(most, ++inFlight);
      await sleep(60);
      inFlight--;
      return { stdout: msg.params.command };
    });
    const out = await Promise.all([
      a.relay.run({ command: 'a' }, 5000),
      b.relay.run({ command: 'b' }, 5000),
      a.relay.run({ command: 'c' }, 5000)
    ]);
    assert.deepStrictEqual(out.map((r) => r.stdout).sort(), ['a', 'b', 'c']);
    assert.strictEqual(most, 1, 'two runs were in flight at once');
    page.close();
  } finally { await b.exit(); await a.exit(); }
});

// The other half of the bug: when the holder's session closed, nobody took over.
test('a relay takes the port over when the holder exits', async () => {
  const a = await sidecar();
  const b = await sidecar();
  try {
    await a.exit();
    await until('the second sidecar to claim the port', () => b.relay.isHub(), RETRY * 10);
    // The page reconnects on its own backoff; here it simply connects again.
    const page = await attach(() => ({ ok: true, exitCode: 0, stdout: 'served by b', ms: 1 }));
    assert.strictEqual((await b.relay.run({ command: 'x', timeout: 5000 }, 20000)).stdout, 'served by b');
    page.close();
  } finally { await b.exit(); }
});

// Between the holder leaving and the next retry, a call finds nobody on the port. It claims the
// port then and there instead of failing with "nothing holds it".
test('a call that finds the port empty claims it at once', async () => {
  const a = await sidecar();
  const b = await sidecar(60000);        // no background retry inside this test
  try {
    await a.exit();
    await assert.rejects(() => b.relay.call('tail', {}), /no Pi Connect page is connected/);
    assert.strictEqual(b.relay.isHub(), true);
  } finally { await b.exit(); }
});

// Two relays find the port empty at the same moment. Exactly one may win, and the loser must
// reach the winner rather than report the port empty.
test('two relays racing for an empty port: one wins, the other relays through it', async () => {
  const a = await sidecar();
  const b = await sidecar(60000);
  const c = await sidecar(60000);
  try {
    await a.exit();
    const results = await Promise.allSettled([b.relay.call('tail', {}), c.relay.call('tail', {})]);
    for (const r of results) {
      assert.strictEqual(r.status, 'rejected');
      assert.match(r.reason.message, /no Pi Connect page is connected/, 'got: ' + r.reason.message);
    }
    assert.strictEqual([b, c].filter((s) => s.relay.isHub()).length, 1, 'exactly one should hold the port');
  } finally { await c.exit(); await b.exit(); }
});

test('a port held by something that is not a sidecar is explained', async () => {
  const stranger = await squat((req, res) => { res.writeHead(404); res.end('nope'); });
  const b = await sidecar(60000);
  try {
    assert.strictEqual(b.relay.isHub(), false);
    await assert.rejects(() => b.relay.health(), /does not answer like another Pi Connect sidecar/);
    await assert.rejects(() => b.relay.run({ command: 'x' }, 2000), /answered \/run with HTTP 404/);
  } finally { await b.exit(); await unsquat(stranger); }
});

// Sessions started before this change keep their old sidecar until they restart. One of those
// may hold the port: it serves /run but answers /call with 426 like any unknown route.
test('an older holder without /call: pi_run still works, the rest say why not', async () => {
  const old = await squat((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, connected: true, page: null }));
    }
    if (req.url === '/run') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, exitCode: 0, stdout: 'old hub ran it', ms: 1 }));
    }
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('Upgrade Required');
  });
  const b = await sidecar(60000);
  try {
    assert.strictEqual((await b.relay.run({ command: 'x', timeout: 1000 }, 5000)).stdout, 'old hub ran it');
    await assert.rejects(() => b.relay.call('tail', {}), /older version without POST \/call/);
    // pi_health still says who holds the port; only the page's own health is out of reach.
    const h = await b.relay.health();
    assert.match(h.holder, /an older version that does not give its pid/);
    assert.match(h.bridge, /^not available: .*older version without POST \/call/);
  } finally { await b.exit(); await unsquat(old); }
});

// ---------------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
    for (const s of [...live]) await s.exit();
    await sleep(50);
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
