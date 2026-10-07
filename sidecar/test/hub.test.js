// Tests for the loopback hub: the CORS/PNA preflight it has to answer, the origin allowlist, and
// the request/response correlation that everything else depends on.
//
//   node test/hub.test.js

import assert from 'node:assert';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createHub } from '../src/hub.js';

const ORIGIN = 'https://connect.raspberrypi.com';
const PORT = 8799;                     // not the default, so a running sidecar does not collide
const BASE = 'http://127.0.0.1:' + PORT;
const WSURL = 'ws://127.0.0.1:' + PORT + '/pix';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for the userscript: answers whatever the hub asks. Given `hello`, it introduces
 * itself on open the way the real one does ({ version, path, shell }).
 */
function fakePage(handler, { hello, origin = ORIGIN } = {}) {
  const ws = new WebSocket(WSURL, { origin });
  if (hello) ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', ...hello })));
  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString());
    try {
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: await handler(msg) }));
    } catch (e) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, error: e.message }));
    }
  });
  return ws;
}

const opened = (ws) => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
// Resolves with the close code. Times out instead of hanging, so a page that was wrongly allowed
// to stay fails the test rather than stalling the whole run.
const closed = (ws, ms = 2000) => new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error('the page was never closed')), ms);
  ws.once('close', (code) => { clearTimeout(timer); res(code); });
});
const status = (ws, shell) => ws.send(JSON.stringify({ type: 'status', shell }));

const DASHBOARD = { version: '0.2.2', path: '/devices', shell: false };
const SHELL_A = { version: '0.2.2', path: '/devices/a/remote-shell-session', shell: true };
const SHELL_B = { version: '0.2.2', path: '/devices/b/remote-shell-session', shell: true };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// The whole reason hub.js runs its own HTTP server instead of letting `ws` bind the port. Without
// these exact headers a browser on an HTTPS origin cannot reach loopback at all, and it fails by
// hanging silently rather than by erroring.
test('answers the Private Network Access preflight', async () => {
  const res = await fetch(BASE + '/pix', {
    method: 'OPTIONS',
    headers: {
      'Origin': ORIGIN,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Private-Network': 'true'
    }
  });
  assert.strictEqual(res.status, 204);
  assert.strictEqual(res.headers.get('access-control-allow-private-network'), 'true');
  assert.strictEqual(res.headers.get('access-control-allow-origin'), ORIGIN);
});

test('does not hand an allow-origin header to a stranger', async () => {
  const res = await fetch(BASE + '/pix', {
    method: 'OPTIONS',
    headers: { 'Origin': 'https://evil.example', 'Access-Control-Request-Method': 'GET' }
  });
  assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
});

test('serves a health endpoint', async () => {
  const body = await (await fetch(BASE + '/health')).json();
  assert.strictEqual(body.ok, true);
});

test('round-trips a call to the page', async () => {
  const ws = fakePage((msg) => ({ echo: msg.method, got: msg.params }));
  await opened(ws);
  await sleep(50);
  const r = await hub.call('run', { command: 'uptime' });
  assert.strictEqual(r.echo, 'run');
  assert.strictEqual(r.got.command, 'uptime');
  ws.close();
  await sleep(50);
});

test('surfaces an error the page reports', async () => {
  const ws = fakePage(() => { throw new Error('no shell channel'); });
  await opened(ws);
  await sleep(50);
  await assert.rejects(() => hub.call('run', { command: 'x' }), /no shell channel/);
  ws.close();
  await sleep(50);
});

test('refuses a connection from any other origin', async () => {
  const ws = new WebSocket(WSURL, { origin: 'https://evil.example' });
  const code = await new Promise((res) => { ws.once('close', (c) => res(c)); ws.once('error', () => res('error')); });
  assert.ok(code === 4003 || code === 'error', 'expected a refusal, got ' + code);
});

test('fails a call with a useful message when no page is connected', async () => {
  await assert.rejects(() => hub.call('run', { command: 'x' }), /no Pi Connect page is connected/);
});

// Two Pi Connect tabs would otherwise both answer every request and race. Preferring the newest
// is worse than it sounds: it makes each tab evict the other on a loop, forever. The incumbent
// keeps the slot instead, and this is the test that pins that. (Neither fake page says hello, so
// this also covers a newcomer that never introduces itself: it is stood by at the deadline.)
test('keeps the incumbent page and stands newcomers by', async () => {
  const first = fakePage(() => 'from first');
  await opened(first);
  await sleep(50);

  const second = fakePage(() => 'from second');
  const secondClosed = new Promise((res) => second.once('close', (c) => res(c)));
  assert.strictEqual(await secondClosed, 4001, 'the newcomer should be told to stand by');

  // The incumbent must be untouched and still serving.
  assert.strictEqual(await hub.call('tail', {}), 'from first');
  first.close();
  await sleep(50);
});

test('a standby page can take over once the holder leaves', async () => {
  const first = fakePage(() => 'from first');
  await opened(first);
  await sleep(50);
  first.close();
  await sleep(80);

  const second = fakePage(() => 'from second');
  await opened(second);
  await sleep(50);
  assert.strictEqual(await hub.call('tail', {}), 'from second');
  second.close();
  await sleep(50);
});

// The bug from 2026-10-06: the userscript runs on every connect.raspberrypi.com page, the /devices
// dashboard got there first, and it held the bridge with no shell behind it while the real
// remote-shell window stood by indefinitely.
test('a page with a live shell takes over from a holder without one', async () => {
  const dash = fakePage(() => 'from dashboard', { hello: DASHBOARD });
  await opened(dash);
  await sleep(50);
  assert.strictEqual(hub.info().shell, false);

  const dashClosed = closed(dash);
  const shell = fakePage(() => 'from shell', { hello: SHELL_A });
  await opened(shell);
  assert.strictEqual(await dashClosed, 4002, 'the shell-less holder should be told it was replaced');
  assert.strictEqual(await hub.call('tail', {}), 'from shell');
  assert.deepStrictEqual(hub.info(), SHELL_A);
  shell.close();
  await sleep(50);
});

// The guard against the ping-pong coming back: the page that lost the slot keeps reconnecting, and
// none of those attempts may take it back while the holder's shell is alive.
test('the displaced page cannot win the slot back', async () => {
  const dash = fakePage(() => 'from dashboard', { hello: DASHBOARD });
  await opened(dash);
  await sleep(50);
  const shell = fakePage(() => 'from shell', { hello: SHELL_A });
  await opened(shell);
  await sleep(50);

  for (let i = 0; i < 3; i++) {
    const again = fakePage(() => 'from dashboard', { hello: DASHBOARD });
    assert.strictEqual(await closed(again), 4001, 'attempt ' + (i + 1) + ' should stand by');
  }
  assert.strictEqual(shell.readyState, WebSocket.OPEN, 'the shell holder must never be dropped');
  assert.strictEqual(await hub.call('tail', {}), 'from shell');
  shell.close();
  await sleep(50);
});

// First come keeps it between two shell pages. A second device's shell must not grab the bridge
// out from under a session that is in use.
test('one shell page never displaces another', async () => {
  const a = fakePage(() => 'from a', { hello: SHELL_A });
  await opened(a);
  await sleep(50);
  const b = fakePage(() => 'from b', { hello: SHELL_B });
  assert.strictEqual(await closed(b), 4001);
  assert.strictEqual(await hub.call('tail', {}), 'from a');
  a.close();
  await sleep(50);
});

test('a page without a shell never displaces anyone', async () => {
  const dash = fakePage(() => 'from first dashboard', { hello: DASHBOARD });
  await opened(dash);
  await sleep(50);
  const other = fakePage(() => 'from second dashboard', { hello: DASHBOARD });
  assert.strictEqual(await closed(other), 4001);
  assert.strictEqual(await hub.call('tail', {}), 'from first dashboard');
  dash.close();
  await sleep(50);
});

// Bridges before 0.2.2 never mention a shell. Unknown is not "none": such a holder could be a
// working shell page, so it keeps the old first-come behaviour in both directions.
test('a holder that never reports its shell is not displaced', async () => {
  const old = fakePage(() => 'from old bridge', { hello: { version: '0.2.1', path: '/devices' } });
  await opened(old);
  await sleep(50);
  const shell = fakePage(() => 'from shell', { hello: SHELL_A });
  assert.strictEqual(await closed(shell), 4001);
  assert.strictEqual(await hub.call('tail', {}), 'from old bridge');
  old.close();
  await sleep(50);
});

// The shell comes up after the page attached, which is the normal order: the sidecar link opens
// at document-start, the WebRTC handshake a second or two later.
test('a holder whose shell came up afterwards keeps the bridge', async () => {
  const a = fakePage(() => 'from a', { hello: { ...SHELL_A, shell: false } });
  await opened(a);
  await sleep(50);
  status(a, true);
  await sleep(50);
  assert.strictEqual(hub.info().shell, true);

  const b = fakePage(() => 'from b', { hello: SHELL_B });
  assert.strictEqual(await closed(b), 4001);
  assert.strictEqual(await hub.call('tail', {}), 'from a');
  a.close();
  await sleep(50);
});

// The same rule covers more than the dashboard: a shell window whose session has ended is just as
// useless as a holder, and a live one should be able to replace it.
test('a holder whose shell has closed can be replaced', async () => {
  const a = fakePage(() => 'from a', { hello: SHELL_A });
  await opened(a);
  await sleep(50);
  status(a, false);
  await sleep(50);
  assert.strictEqual(hub.info().shell, false);

  const aClosed = closed(a);
  const b = fakePage(() => 'from b', { hello: SHELL_B });
  await opened(b);
  assert.strictEqual(await aClosed, 4002);
  assert.strictEqual(await hub.call('tail', {}), 'from b');
  b.close();
  await sleep(50);
});

// A page that is closed mid-call used to leave the caller waiting out the full timeout. A takeover
// is one more way for the holder to vanish, so the call now fails at once and says why.
test('a call fails promptly when its page goes away', async () => {
  const ws = new WebSocket(WSURL, { origin: ORIGIN });      // connects, never replies
  await opened(ws);
  await sleep(50);
  const t0 = Date.now();
  const call = hub.call('run', { command: 'x' }, 10000);
  setTimeout(() => ws.close(), 100);
  await assert.rejects(call, /went away before answering/);
  assert.ok(Date.now() - t0 < 2000, 'should not have waited for the timeout');
  await sleep(50);
});

test('times out a page that never answers', async () => {
  const ws = new WebSocket(WSURL, { origin: ORIGIN });      // connects, never replies
  await opened(ws);
  await sleep(50);
  await assert.rejects(() => hub.call('run', { command: 'x' }, 200), /did not answer/);
  ws.close();
  await sleep(50);
});

// POST /run is for native programs on this machine. Each guard gets its own test, because any one
// of them failing open would let a web page run commands on the Pi.

/** A raw request, so the Host header can be set (fetch won't let a caller choose it). */
function rawPost(path, { headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const postRun = (body, headers = {}) =>
  fetch(BASE + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('/run relays to the page and returns its result', async () => {
  const ws = fakePage((msg) => ({ ok: true, exitCode: 0, stdout: 'ran ' + msg.params.command, timeout: msg.params.timeout }));
  await opened(ws);
  await sleep(50);
  const res = await postRun({ command: 'uptime', timeout: 5000 });
  assert.strictEqual(res.status, 200);
  const r = await res.json();
  assert.strictEqual(r.stdout, 'ran uptime');
  assert.strictEqual(r.timeout, 5000);
  ws.close();
  await sleep(50);
});

test('/run refuses anything carrying an Origin, the Pi Connect origin included', async () => {
  for (const o of ['https://evil.example', ORIGIN, 'null']) {
    const res = await postRun({ command: 'id' }, { Origin: o });
    assert.strictEqual(res.status, 403, 'Origin ' + o + ' got ' + res.status);
  }
});

test('/run refuses a Host that is not this loopback address (DNS rebinding)', async () => {
  const r = await rawPost('/run', {
    headers: { 'Host': 'rebind.example:' + PORT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'id' })
  });
  assert.strictEqual(r.status, 403);
});

test('/run refuses GET and non-JSON bodies', async () => {
  assert.strictEqual((await fetch(BASE + '/run')).status, 405);
  const form = await fetch(BASE + '/run', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'command=id'
  });
  assert.strictEqual(form.status, 415);
  assert.strictEqual((await postRun({ nope: 1 })).status, 400);
});

test('/run says why when no page is connected', async () => {
  const res = await postRun({ command: 'id' });
  assert.strictEqual(res.status, 503);
  assert.match((await res.json()).error, /no Pi Connect page is connected/);
});

// Both pi_run and /run type into one terminal, so they have to take turns.
test('runs take turns, never overlap', async () => {
  let inFlight = 0, most = 0;
  const ws = fakePage(async (msg) => {
    most = Math.max(most, ++inFlight);
    await sleep(60);
    inFlight--;
    return { stdout: msg.params.command };
  });
  await opened(ws);
  await sleep(50);
  const out = await Promise.all([
    hub.run({ command: 'a' }, 2000),
    postRun({ command: 'b' }).then((r) => r.json()),
    hub.run({ command: 'c' }, 2000)
  ]);
  assert.deepStrictEqual(out.map((r) => r.stdout), ['a', 'b', 'c']);
  assert.strictEqual(most, 1, 'two runs were in flight at once');
  ws.close();
  await sleep(50);
});

test('a failed run does not jam the queue behind it', async () => {
  const ws = fakePage((msg) => { if (msg.params.command === 'bad') throw new Error('boom'); return { stdout: 'fine' }; });
  await opened(ws);
  await sleep(50);
  await assert.rejects(() => hub.run({ command: 'bad' }, 2000), /boom/);
  assert.strictEqual((await hub.run({ command: 'ok' }, 2000)).stdout, 'fine');
  ws.close();
  await sleep(50);
});

// ---------------------------------------------------------------------------

const hub = createHub({ port: PORT, helloTimeoutMs: 200 });

(async () => {
  await hub.listen();
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  await hub.close();
  process.exit(failed ? 1 : 0);
})();
