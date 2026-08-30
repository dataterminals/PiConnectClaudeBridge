// Tests for the loopback hub: the CORS/PNA preflight it has to answer, the origin allowlist, and
// the request/response correlation that everything else depends on.
//
//   node test/hub.test.js

import assert from 'node:assert';
import { WebSocket } from 'ws';
import { createHub } from '../src/hub.js';

const ORIGIN = 'https://connect.raspberrypi.com';
const PORT = 8799;                     // not the default, so a running sidecar does not collide
const BASE = 'http://127.0.0.1:' + PORT;
const WSURL = 'ws://127.0.0.1:' + PORT + '/pix';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for the userscript: answers whatever the hub asks. */
function fakePage(handler, origin = ORIGIN) {
  const ws = new WebSocket(WSURL, { origin });
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

// Two Pi Connect tabs would otherwise both answer every request and race.
test('keeps only the newest page', async () => {
  const first = fakePage(() => 'from first');
  await opened(first);
  await sleep(50);
  const closedCode = new Promise((res) => first.once('close', (c) => res(c)));
  const second = fakePage(() => 'from second');
  await opened(second);
  await sleep(80);
  assert.strictEqual(await closedCode, 4000);
  assert.strictEqual(await hub.call('tail', {}), 'from second');
  second.close();
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

// ---------------------------------------------------------------------------

const hub = createHub({ port: PORT });

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
