// End-to-end check across the whole chain, through the real MCP interface:
//
//   this script -> MCP stdio -> hub -> loopback WebSocket -> userscript -> WebRTC -> the Pi
//
// Unlike the other suites this one needs the real world: a browser with the bridge installed, a
// Pi Connect remote-shell tab open, and a Pi on the other end. It is not part of `npm test`.
//
//   node test/live-e2e.js
//
// It runs `uname -a` and a deliberate `exit 7`, so it proves output capture and exit-code
// propagation without changing anything on the device.

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'src', 'server.js');

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
const waiters = new Map();
child.stdout.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});

let nextId = 1;
function rpc(method, params, timeoutMs = 90000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiters.set(id, resolve);
    setTimeout(() => reject(new Error('no reply to ' + method)), timeoutMs);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const callTool = (name, args) => rpc('tools/call', { name, arguments: args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  };

  await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-e2e', version: '0' }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // The page reconnects on a backoff that tops out at 30s, so give it room after a fresh start.
  process.stdout.write('  waiting for the browser page to attach');
  let attached = false;
  for (let i = 0; i < 45 && !attached; i++) {
    const h = await callTool('pi_health', {});
    attached = !h.result.isError;
    if (!attached) { process.stdout.write('.'); await sleep(2000); }
  }
  console.log(attached ? ' attached' : ' gave up');
  if (!attached) {
    console.log('\nNo page attached. Open the Pi Connect remote shell with the bridge installed.');
    child.kill();
    process.exit(1);
  }

  await check('pi_health reports a healthy bridge', async () => {
    const r = await callTool('pi_health', {});
    const h = JSON.parse(r.result.content[0].text).bridge;   // beside attachedPage, since b8ada87
    assert.strictEqual(h.ok, true, 'problems: ' + JSON.stringify(h.problems));
    assert.strictEqual(h.status.shell, 'open');
  });

  await check('pi_run returns real output from the device', async () => {
    const r = await callTool('pi_run', { command: 'uname -a' });
    const text = r.result.content[0].text;
    assert.ok(!r.result.isError, text);
    assert.match(text, /exit 0/);
    assert.match(text, /Linux/);
    console.log('       -> ' + text.split('\n').pop().slice(0, 90));
  });

  await check('pi_run propagates a non-zero exit code', async () => {
    const r = await callTool('pi_run', { command: 'echo checking; exit 7' });
    const text = r.result.content[0].text;
    assert.strictEqual(r.result.isError, true, 'a failing command should be flagged');
    assert.match(text, /exit 7/);
    assert.match(text, /checking/);
  });

  await check('pi_run survives quoting and newlines', async () => {
    const r = await callTool('pi_run', { command: 'for i in 1 2 3; do\n  echo "line $i \'quoted\'"\ndone' });
    const text = r.result.content[0].text;
    assert.ok(!r.result.isError, text);
    assert.match(text, /line 1 'quoted'/);
    assert.match(text, /line 3 'quoted'/);
  });

  console.log('\n' + (4 - failed) + '/4 passed');
  child.kill();
  process.exit(failed ? 1 : 0);
})();
