// Smoke test for the MCP surface: spawn the real server, speak JSON-RPC at it over stdio, and
// check it advertises the tools and fails honestly when no page is connected.
//
//   node test/mcp.test.js

import assert from 'node:assert';
import { spawn } from 'node:child_process';
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
