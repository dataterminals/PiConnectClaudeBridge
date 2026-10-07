// Smoke test for the MCP surface: spawn the real server, speak JSON-RPC at it over stdio, and
// check it advertises the tools and fails honestly when no page is connected.
//
//   node test/mcp.test.js

import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'src', 'server.js');
const PORT = 8798;                       // not the default, so a running sidecar does not collide

const child = spawn(process.execPath, [SERVER, '--port', String(PORT)], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let buffer = '';
const waiters = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiters.set(id, resolve);
    setTimeout(() => reject(new Error('no reply to ' + method)), 8000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('completes the MCP handshake', async () => {
  const r = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' }
  });
  assert.strictEqual(r.result.serverInfo.name, 'pi-connect-bridge');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

test('advertises the expected tools', async () => {
  const r = await rpc('tools/list', {});
  const names = r.result.tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names,
    ['pi_expect', 'pi_health', 'pi_key', 'pi_run', 'pi_screen', 'pi_send', 'pi_tail']);
  const run = r.result.tools.find((t) => t.name === 'pi_run');
  assert.strictEqual(run.inputSchema.required[0], 'command');
});

// The failure mode that matters most: if no browser is attached there is no shell, and the tool
// must say so plainly rather than return an empty success.
test('says so plainly when no page is connected', async () => {
  const r = await rpc('tools/call', { name: 'pi_run', arguments: { command: 'uptime' } });
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /no Pi Connect page is connected/);
});

// ---- several sessions, one port ---------------------------------------------
//
// Every Claude Code session starts a sidecar, and only one can hold the port. A busy port first
// killed the process outright ("Connection closed", no reason given), and later left its tools
// able only to say the port was taken. Seen 2026-10-07: an idle session held the hub for hours,
// and no other session could reach the Pi. Now the others relay through the holder and take over
// when it exits. These run real server.js processes on their own port.

const PORT2 = 8795;

/** A sidecar process with an MCP client attached to its stdio, already initialised. */
async function sidecar(extra = []) {
  const proc = spawn(process.execPath, [SERVER, '--port', String(PORT2), '--retry-ms', '300', ...extra], {
    stdio: ['pipe', 'pipe', 'ignore']
  });
  let buf = '';
  const waiting = new Map();
  proc.stdout.on('data', (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, resolve);
    setTimeout(() => reject(new Error('no reply to ' + method)), 15000);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return { proc, tool: (name, args = {}) => call('tools/call', { name, arguments: args }).then((r) => r.result) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whatever answers /health on PORT2, or null. */
async function holder() {
  try { return await (await fetch('http://127.0.0.1:' + PORT2 + '/health')).json(); } catch { return null; }
}

async function until(what, fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(50);
  }
}

/** The userscript's side of the link, attached to whichever sidecar holds PORT2. */
function fakePage(handler) {
  const ws = new WebSocket('ws://127.0.0.1:' + PORT2 + '/pix', { origin: 'https://connect.raspberrypi.com' });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    ws.send(JSON.stringify({ id: msg.id, ok: true, result: handler(msg) }));
  });
  return new Promise((res, rej) => { ws.once('open', () => res(ws)); ws.once('error', rej); });
}

const ranOn = (who) => (msg) => msg.method === 'run'
  ? { ok: true, exitCode: 0, stdout: 'ran ' + msg.params.command + ' via ' + who, ms: 1 }
  : { ok: true, problems: [] };

test('a second session\'s sidecar relays through the first', async () => {
  const first = await sidecar();
  const second = await sidecar();
  try {
    assert.strictEqual((await holder()).pid, first.proc.pid, 'the first sidecar should hold the port');
    const page = await fakePage(ranOn('the page'));
    await sleep(100);

    const r = await second.tool('pi_run', { command: 'uptime' });
    assert.notStrictEqual(r.isError, true, r.content[0].text);
    assert.match(r.content[0].text, /ran uptime via the page/);

    const h = await second.tool('pi_health');
    assert.notStrictEqual(h.isError, true, h.content[0].text);
    assert.match(JSON.parse(h.content[0].text).holder, new RegExp('another sidecar \\(pid ' + first.proc.pid));
    page.close();
  } finally { second.proc.kill(); first.proc.kill(); await sleep(200); }
});

test('when the first sidecar\'s session ends, the second takes over the port', async () => {
  const first = await sidecar();
  const second = await sidecar();
  try {
    first.proc.kill();
    await until('the second sidecar to hold the port', async () => (await holder())?.pid === second.proc.pid);
    const page = await fakePage(ranOn('the second sidecar'));
    await sleep(100);
    const r = await second.tool('pi_run', { command: 'id' });
    assert.match(r.content[0].text, /ran id via the second sidecar/);
    page.close();
  } finally { second.proc.kill(); first.proc.kill(); await sleep(200); }
});

test('a port held by something that is not a sidecar is explained', async () => {
  const stranger = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => stranger.listen(PORT2, '127.0.0.1', r));
  const s = await sidecar();
  try {
    const h = await s.tool('pi_health');
    assert.strictEqual(h.isError, true);
    assert.match(h.content[0].text, /does not answer like another Pi Connect sidecar/);
    assert.match(h.content[0].text, new RegExp(String(PORT2)));
  } finally { s.proc.kill(); await new Promise((r) => stranger.close(r)); }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  child.kill();
  process.exit(failed ? 1 : 0);
})();
