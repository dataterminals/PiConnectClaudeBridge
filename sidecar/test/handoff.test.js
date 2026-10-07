// Which page holds the bridge, tested with both halves real: the hub from src/hub.js, and the
// actual userscript loaded into sandboxed "pages" whose sidecar link is a real WebSocket.
//
// hub.test.js pins the hub's rule with hand-written hellos. This suite checks that the userscript
// says the right things at the right moments, above all the order a real tab produces: the
// sidecar link opens at document-start and the shell channel a second or two later, so a fresh
// shell window is first turned away for having no shell and must then come back promptly.
//
//   node test/handoff.test.js

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createHub } from '../src/hub.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '..', '..', 'src', 'pi-connect-claude-bridge.user.js'), 'utf8');

const ORIGIN = 'https://connect.raspberrypi.com';
const PORT = 8797;                     // not the default, so a running sidecar does not collide
const DASHBOARD = '/devices';
const SHELL_A = '/devices/a/remote-shell-session';
const SHELL_B = '/devices/b/remote-shell-session';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(20);
  }
  return Date.now() - t0;
}

/** A data channel the test opens and closes by hand, the way WebRTC would. */
function fakeChannel(label) {
  const listeners = {};
  return {
    label,
    readyState: 'connecting',
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    send() {},
    fire(type) { (listeners[type] || []).forEach((fn) => fn({})); },
    open() { this.readyState = 'open'; this.fire('open'); },
    close() { this.readyState = 'closed'; this.fire('close'); }
  };
}

const pages = [];

/** Load the real userscript as a tab at `pathname`. Its sidecar link connects at once. */
function openPage(pathname) {
  const store = {};
  const sockets = [];
  const sandbox = {
    console, TextDecoder, TextEncoder, setTimeout, clearTimeout, Promise, Math, Date,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    location: { pathname },
    localStorage: { getItem: (k) => (k in store ? store[k] : null) },
    // The browser's WebSocket, but pointed at the test port and carrying the Origin a browser
    // would set. Everything else about it (onopen, onclose with a code) is the real thing.
    WebSocket: class extends WebSocket {
      constructor(url) {
        super(url.replace(':8732/', ':' + PORT + '/'), { origin: ORIGIN });
        sockets.push(this);
      }
    },
    RTCPeerConnection: class {
      createDataChannel(label) { return fakeChannel(label); }
      addEventListener() {}
    }
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  sandbox.document = {
    head: null,
    documentElement: { appendChild(el) { vm.runInContext(el.textContent, ctx); } },
    createElement: () => ({ textContent: '', remove() {} }),
    querySelector: () => null
  };
  vm.runInContext(SRC, ctx);

  const page = {
    path: pathname,
    shell: null,
    openShell() {
      page.shell = new sandbox.RTCPeerConnection().createDataChannel('shell');
      page.shell.open();
    },
    events: () => sandbox.__pix.health().events.join(' / '),
    stop() {
      store.__pixNoSidecar = '1';                     // the userscript's own off switch
      for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
    }
  };
  pages.push(page);
  return page;
}

const holder = () => hub.info() && hub.info().path;

async function stopAll() {
  while (pages.length) pages.pop().stop();
  await until('the hub to empty', () => !hub.isConnected());
  await sleep(50);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// The 2026-10-06 bug, end to end.
test('a shell window takes the bridge from the dashboard once its shell is up', async () => {
  const dash = openPage(DASHBOARD);
  await until('the dashboard to attach', () => holder() === DASHBOARD);
  assert.strictEqual(hub.info().shell, false);

  const win = openPage(SHELL_A);
  await until('the shell window to be stood by', () => /standing by/.test(win.events()));
  assert.strictEqual(holder(), DASHBOARD, 'with no shell yet, the window has no claim');

  win.openShell();
  // Its standby retry is 30s away; the shell coming up must bring the next attempt forward.
  const ms = await until('the shell window to take over', () => holder() === SHELL_A, 5000);
  assert.ok(ms < 5000, 'took ' + ms + 'ms');
  assert.strictEqual(hub.info().shell, true);
  assert.match(dash.events(), /a tab with a live shell took over/);

  const st = await hub.call('status', {});
  assert.strictEqual(st.path, SHELL_A);
  assert.strictEqual(st.shell, 'open');
  await stopAll();
});

test('a shell window whose shell is already up takes over at once', async () => {
  openPage(DASHBOARD);
  await until('the dashboard to attach', () => holder() === DASHBOARD);

  // A page whose link opens late -- a restarted sidecar, or a permission prompt answered after
  // the shell came up -- says "shell" in its very first hello. Opening the shell in the same tick
  // as the load puts it ahead of the socket's open event.
  const late = openPage(SHELL_A);
  late.openShell();
  await until('the late window to take over', () => holder() === SHELL_A);
  assert.doesNotMatch(late.events(), /standing by/, 'it should never have been turned away');
  await stopAll();
});

test('the page that held the bridge first tells the hub when its shell comes up', async () => {
  const win = openPage(SHELL_A);
  await until('the window to attach', () => holder() === SHELL_A);
  assert.strictEqual(hub.info().shell, false);
  win.openShell();
  await until('the hub to hear about the shell', () => hub.info().shell === true);

  // ...and having a shell, it is not displaced by a second one.
  const other = openPage(SHELL_B);
  other.openShell();
  await until('the second window to be stood by', () => /standing by/.test(other.events()));
  await sleep(300);
  assert.strictEqual(holder(), SHELL_A);

  win.shell.close();
  await until('the hub to hear the shell closed', () => hub.info().shell === false);
  await stopAll();
});

test('a dashboard opened later stands by and stays quiet', async () => {
  const win = openPage(SHELL_A);
  win.openShell();
  await until('the window to hold with a shell', () => holder() === SHELL_A && hub.info().shell);
  const dash = openPage(DASHBOARD);
  await until('the dashboard to be stood by', () => /standing by/.test(dash.events()));
  await sleep(500);
  assert.strictEqual(holder(), SHELL_A);
  assert.strictEqual((dash.events().match(/sidecar: connected/g) || []).length, 1,
    'one attempt, then a 30s wait: ' + dash.events());
  await stopAll();
});

// ---------------------------------------------------------------------------

const hub = createHub({ port: PORT, helloTimeoutMs: 300 });

(async () => {
  await hub.listen();
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) {
      failed++;
      console.log('  FAIL ' + name + '\n       ' + (e && e.message));
      for (const p of pages) console.log('       ' + p.path + ': ' + p.events());
      while (pages.length) pages.pop().stop();
      await sleep(100);
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  await hub.close();
  process.exit(failed ? 1 : 0);
})();
