// Offline regression tests for the parts of the bridge that are easy to break and expensive to
// debug live: the command-delimiting protocol and the ANSI scrubber.
//
// There is no Pi here. A fake PTY stands in for one, and it is deliberately unhelpful in the same
// ways a real one is — it echoes the command line back before producing any output, it splits
// frames arbitrarily, and it wraps everything in CRLF and colour escapes. If run() can pull a
// clean stdout and a correct exit code out of that, it can do it against a real shell.
//
//   node tests/protocol.test.js

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'pi-connect-claude-bridge.user.js'), 'utf8');

// Frames have to be ArrayBuffers built *inside* the sandbox. `instanceof` is realm-sensitive, so
// a buffer allocated out here would fail the library's `d instanceof ArrayBuffer` check and take a
// fallback path the browser never takes — the test would then be exercising the wrong branch.
let toArrayBuffer = null;
const encBytes = (u8) => (toArrayBuffer ? toArrayBuffer(Array.from(u8)) : u8.buffer);
const enc = (s) => encBytes(new TextEncoder().encode(s));

/**
 * A fake `shell` data channel that behaves like the far end of a PTY.
 *
 * `respond(cmd)` is the test's stand-in for the Pi: it receives the decoded command and returns
 * {out, code}. Everything around it — the echo, the markers, the CRLF, the colour — is the noise
 * run() has to see through.
 */
function makeShellChannel(respond, opts) {
  opts = opts || {};
  const listeners = {};
  let acc = '';
  const ch = {
    label: 'shell',
    readyState: opts.readyState || 'open',
    sent: [],
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    emit(data) { (listeners.message || []).forEach((fn) => fn({ data })); },
    send(text) {
      ch.sent.push(text);
      if (opts.deaf) return;                       // simulate a command that never comes back
      acc += text;
      const i = acc.indexOf('\r');
      if (i === -1) return;                        // still mid-line: the caller chunks at 1 KiB
      const line = acc.slice(0, i);
      acc = acc.slice(i + 1);
      setTimeout(() => ch.emit(enc(line + '\r\n')), 0);   // the PTY echo, markers and all
      const id = (/__PIX''BEG_([a-z0-9]+)__/.exec(line) || [])[1];
      if (!id) return;
      const b64 = (/printf %s '([A-Za-z0-9+/=]*)'/.exec(line) || [])[1] || '';
      const cmd = Buffer.from(b64, 'base64').toString('utf8');
      const r = respond(cmd);
      setTimeout(() => {
        ch.emit(enc('__PIXBEG_' + id + '__\r\n'));
        if (r.out && opts.splitAt) {
          const b = new TextEncoder().encode(r.out);
          ch.emit(encBytes(b.slice(0, opts.splitAt)));
          ch.emit(encBytes(b.slice(opts.splitAt)));
        } else if (r.out) ch.emit(enc(r.out));
        ch.emit(enc('__PIXEND_' + id + '_' + r.code + '__\r\n'));
      }, 5);
    }
  };
  return ch;
}

/** Load the real userscript into a sandbox that looks enough like a browser tab. */
function loadBridge(channelFactory) {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.console = console;
  sandbox.TextDecoder = TextDecoder;
  sandbox.TextEncoder = TextEncoder;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.Promise = Promise;
  sandbox.Math = Math;
  sandbox.Date = Date;
  sandbox.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  sandbox.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  sandbox.location = { pathname: '/devices/test/remote-shell-session' };

  const ctx = vm.createContext(sandbox);
  toArrayBuffer = vm.runInContext(
    '(function (a) { var b = new ArrayBuffer(a.length), v = new Uint8Array(b);' +
    ' for (var i = 0; i < a.length; i++) v[i] = a[i]; return b; })', ctx);

  // The loader injects a <script> element. Honour that faithfully — evaluating the text in this
  // same context is exactly what a browser does, and it means the test exercises the real loader
  // rather than a bypass of it.
  sandbox.document = {
    head: null,
    documentElement: { appendChild(el) { vm.runInContext(el.textContent, ctx); } },
    createElement: () => ({ textContent: '', remove() {} }),
    querySelector: () => null
  };

  sandbox.RTCPeerConnection = class {
    constructor() { this._listeners = {}; }
    createDataChannel(label) { return channelFactory(label); }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  };

  vm.runInContext(SRC, ctx);
  return sandbox;
}

/** Bring up a bridge with one open shell channel, the way the page would. */
function connect(respond, opts) {
  let channel = null;
  const win = loadBridge((label) => (channel = makeShellChannel(respond, opts), channel));
  const pc = new win.RTCPeerConnection();
  pc.createDataChannel('shell');
  return { win, channel };
}

// ---------------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('captures stdout and a zero exit code', async () => {
  const { win } = connect(() => ({ out: 'Linux aarch64\r\n', code: 0 }));
  const r = await win.__pix.run('uname -sm');
  assert.strictEqual(r.stdout, 'Linux aarch64');
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.timedOut, undefined);
  assert.strictEqual(r.markerMissing, undefined);
});

test('reports a non-zero exit code and does not call it ok', async () => {
  const { win } = connect(() => ({ out: 'nope\r\n', code: 7 }));
  const r = await win.__pix.run('false');
  assert.strictEqual(r.exitCode, 7);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stdout, 'nope');
});

// The whole reason the markers are written as '__PIX''BEG_id__'. The PTY echoes the command line
// back verbatim, so a plainly-written marker would appear in the capture twice and the parser
// could close on the echo — returning empty output and a garbage exit code, with no error.
test('is not fooled by the PTY echoing the marker command back', async () => {
  const { win, channel } = connect(() => ({ out: 'real output\r\n', code: 0 }));
  const r = await win.__pix.run('echo hi');
  const echoed = channel.sent.join('');
  assert.ok(echoed.includes("__PIX''BEG_"), 'the sent line should carry the split marker');
  assert.ok(!echoed.includes('__PIXBEG_'), 'the sent line must never contain a joined marker');
  assert.strictEqual(r.stdout, 'real output');
  assert.strictEqual(r.exitCode, 0);
});

test('passes multi-line scripts and shell metacharacters through untouched', async () => {
  const gnarly = 'echo "it\'s $HOME; `date`"\nfor i in 1 2; do echo $i; done\n';
  let seen = null;
  const { win } = connect((cmd) => (seen = cmd, { out: 'ok\r\n', code: 0 }));
  await win.__pix.run(gnarly);
  assert.strictEqual(seen, gnarly, 'the far end must receive the command byte-for-byte');
});

test('strips colour, cursor moves and window titles out of stdout', async () => {
  const noisy = '\u001B]0;sylvi@sylpi: ~\u0007\u001B[01;32mgreen\u001B[00m\r\n\u001B[2Kplain\r\n';
  const { win } = connect(() => ({ out: noisy, code: 0 }));
  const r = await win.__pix.run('ls --color');
  assert.strictEqual(r.stdout, 'green\nplain');
});

test('reassembles output split across frames and UTF-8 split mid-character', async () => {
  // The e-acute is two bytes, so splitting at byte 4 cuts it in half across two frames.
  const { win } = connect(() => ({ out: 'café ok\r\n', code: 0 }), { splitAt: 4 });
  const r = await win.__pix.run('echo cafe');
  assert.strictEqual(r.stdout, 'café ok');
});

test('flags a timeout instead of returning a confident empty result', async () => {
  const { win } = connect(() => ({ out: '', code: 0 }), { deaf: true });
  const r = await win.__pix.run('sleep 999', { timeout: 300 });
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.exitCode, null);
});

test('sends Ctrl-C on timeout so the session stays usable', async () => {
  const { win, channel } = connect(() => ({ out: '', code: 0 }), { deaf: true });
  await win.__pix.run('sleep 999', { timeout: 300 });
  assert.ok(channel.sent.includes('\u0003'), 'expected an interrupt after the timeout');
});

test('leaves the session alone when interruptOnTimeout is off', async () => {
  const { win, channel } = connect(() => ({ out: '', code: 0 }), { deaf: true });
  await win.__pix.run('sleep 999', { timeout: 300, interruptOnTimeout: false });
  assert.ok(!channel.sent.includes('\u0003'), 'should not have interrupted');
});

test('refuses a command too large to push through readline', async () => {
  const { win } = connect(() => ({ out: '', code: 0 }));
  await assert.rejects(() => win.__pix.run('x'.repeat(20000)), /too large/);
});

test('throws a useful error when there is no shell channel', async () => {
  const win = loadBridge(() => makeShellChannel(() => ({ out: '', code: 0 })));
  await assert.rejects(() => win.__pix.run('ls'), /no shell channel/);
});

test('health() names the problem when the transport never appeared', async () => {
  const win = loadBridge(() => makeShellChannel(() => ({ out: '', code: 0 })));
  const h = win.__pix.health();
  assert.strictEqual(h.ok, false);
  assert.ok(h.problems.some((p) => /no peer connection/.test(p)), h.problems.join(' / '));
});

test('key() encodes control combos and named keys', async () => {
  const { win, channel } = connect(() => ({ out: '', code: 0 }));
  win.__pix.key('C-c');      win.__pix.key('ctrl+d');
  win.__pix.key('up');       win.__pix.key('enter');
  assert.deepStrictEqual(channel.sent, ['\u0003', '\u0004', '\u001B[A', '\r']);
});

// ---------------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ok   ' + name);
    } catch (e) {
      failed++;
      console.log('  FAIL ' + name + '\n       ' + (e && e.message));
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
