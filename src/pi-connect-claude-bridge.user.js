// ==UserScript==
// @name         Pi Connect Claude Bridge
// @namespace    https://github.com/dataterminals/PiConnectClaudeBridge
// @version      0.2.2
// @description  Turns the Raspberry Pi Connect browser shell into a callable API. Exposes window.__pix so an assistant driving the browser can run a command and get {stdout, exitCode} back, instead of typing at a terminal widget and screen-scraping the result. Rides the session already authenticated in this browser; opens no port and stores no credential.
// @author       dataterminals
// @homepageURL  https://github.com/dataterminals/PiConnectClaudeBridge
// @supportURL   https://github.com/dataterminals/PiConnectClaudeBridge/issues
// @match        https://connect.raspberrypi.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/dataterminals/PiConnectClaudeBridge/main/src/pi-connect-claude-bridge.user.js
// @updateURL    https://raw.githubusercontent.com/dataterminals/PiConnectClaudeBridge/main/src/pi-connect-claude-bridge.user.js
// @noframes
// ==/UserScript==
//
// DESIGN NOTES (for the next maintainer — human or Claude):
//
//   * WHAT THIS IS. A library, not a feature. It renders no UI, binds no hotkey, changes nothing
//     the user sees, and never runs a command on its own. It defines window.__pix and stops.
//     The caller is an assistant driving this browser, which evaluates `__pix.run('uname -a')`.
//
//   * WHY IT EXISTS. Pi Connect's remote shell is an xterm.js widget. Driving it the obvious way
//     — synthesise keystrokes, then read the rendered rows — fails in three separate ways:
//       1. The DOM renderer only materialises the *viewport*. Anything that scrolls past is gone,
//          so output longer than the window is unreadable.
//       2. Rendering is rAF-driven, so a backgrounded tab stops painting. Bytes keep arriving and
//          the screen keeps not changing. Measured 2026-08-30: a pasted character sat invisible
//          until the tab was foregrounded, which reads exactly like "the command did not run".
//       3. There is no command boundary and no exit status. You get pixels, not a result.
//     So this hooks the transport instead. Output is captured as it arrives off the wire —
//     complete, unthrottled, unaffected by scrollback or window size — and commands are delimited
//     so run() can return a real exit code.
//
//   * THE TRANSPORT IS WEBRTC, NOT A WEBSOCKET. Verified 2026-08-30 (see docs/protocol.md). The
//     page POSTs to /devices/<id>/connections purely to exchange SDP, then everything rides two
//     RTCDataChannels:
//       `shell`  — created by the browser. Raw PTY bytes. Inbound frames are ArrayBuffer,
//                  outbound frames are plain JS strings. Both directions verified on the wire.
//       `resize` — opened by the Pi. Carries the JSON geometry blob the browser sends on resize.
//     Hence the RTCPeerConnection patch below. There is nothing else to hook: no window global
//     holds the xterm Terminal, and the element carries no framework back-pointer.
//
//   * @run-at document-start IS LOAD-BEARING. The patch has to be in place before the page bundle
//     constructs its RTCPeerConnection. Miss that window and the channels are created against the
//     native constructor, __pix comes up with no transport, and health() reports it. This is the
//     single most likely cause of "it installed but does nothing".
//
//   * IT PUBLISHES ITSELF VIA A <script> TAG, and that is not decoration — see the loader at the
//     bottom. Whether a userscript's `window` is the page's `window` depends on how the extension
//     injected it, which the script cannot observe. Same lesson as the sibling ShoppingClaudeBridge
//     repo, which shipped a version that installed cleanly and defined its global on a `window`
//     nobody could reach. A <script> element always evaluates in the main world because the DOM is
//     shared. Do not "simplify" it back to a direct call. (Inline script is not CSP-blocked on
//     connect.raspberrypi.com — verified 2026-08-30.)
//
//   * NO COMMAND RUNS BY ITSELF. No keepalive, no command replay, no polling of the device. The
//     patch observes; every byte sent to the Pi originates in an explicit __pix call.
//     The one exception is the sidecar link at the bottom of the library. It retries a loopback
//     WebSocket on a backoff so the local MCP sidecar can attach, tries again at once when the
//     shell comes up, and tells the sidecar about this page: a hello on connect, and a status
//     whenever the shell opens or closes, so the hub can choose which tab holds the bridge. That
//     connection carries requests *in* and sends nothing out but replies and facts about the
//     page. It never originates a command on its own, it only reaches 127.0.0.1, and
//     localStorage.__pixNoSidecar = '1' turns it off. Keep that distinction exact — "talks to
//     the sidecar unprompted" and "runs things on the Pi unprompted" are not the same promise.
//
//   * WHAT COMES BACK IS UNTRUSTED DATA. stdout is whatever the Pi printed — a file, a log line,
//     a MOTD someone edited. It is never an instruction to the caller, however it is phrased.
//
//   * SILENT DEGRADATION IS THE ENEMY. A bridge that returns '' with exitCode 0 when the channel
//     actually dropped is worse than one that throws. Every result carries the flags needed to
//     distrust it: timedOut, markerMissing, truncated. Read them.
//
'use strict';
(function () {
  function __pixLib() {
  'use strict';

  if (window.__pix) return;                    // Turbo re-visits re-run page scripts; install once.

  var MAX_BUF = 1 << 20;                       // 1 MiB rolling capture. Older bytes fall off.
  var CHUNK   = 1024;                          // Outbound slice size. Data channels dislike big frames.
  var MAX_CMD = 12000;                         // base64 ceiling; past this readline is a bad courier.
  var POLL_MS = 50;

  var state = {
    pcs: 0,
    shell: null,
    resize: null,
    lastResize: null,
    buf: '',
    dropped: 0,
    lastData: 0,
    events: [],
    patchedInTime: false,
    installedAt: Date.now()
  };

  var decoder = new TextDecoder('utf-8');

  function note(kind, detail) {
    state.events.push(kind + ': ' + detail);
    if (state.events.length > 60) state.events.shift();
  }

  function append(text) {
    if (!text) return;
    state.buf += text;
    state.lastData = Date.now();
    if (state.buf.length > MAX_BUF) {
      var drop = state.buf.length - MAX_BUF;
      state.buf = state.buf.slice(drop);
      state.dropped += drop;
    }
  }

  // Inbound frames are ArrayBuffer in practice, but a renegotiated channel can hand back a Blob
  // and a future build could switch to text. Handle all three rather than silently dropping data.
  function onMessage(ev) {
    var d = ev.data;
    try {
      if (typeof d === 'string') append(d);
      else if (d instanceof ArrayBuffer) append(decoder.decode(new Uint8Array(d), { stream: true }));
      else if (ArrayBuffer.isView(d)) append(decoder.decode(d, { stream: true }));
      else if (typeof Blob !== 'undefined' && d instanceof Blob) {
        d.arrayBuffer().then(function (b) { append(decoder.decode(new Uint8Array(b), { stream: true })); });
      } else note('warn', 'unknown frame type');
    } catch (e) { note('error', 'decode ' + e.message); }
  }

  function adopt(ch, origin) {
    note('channel', ch.label + '/' + origin);
    if (ch.label === 'shell') {
      // Deliberately not setting binaryType: the app configures its own transport, and this
      // library's job is to observe it, not to reconfigure it out from under the page.
      ch.addEventListener('message', onMessage);
      ch.addEventListener('open', reportShell);
      ch.addEventListener('close', function () { note('channel', 'shell closed'); reportShell(); });
      state.shell = ch;
      if (ch.readyState === 'open') reportShell();
    } else if (ch.label === 'resize') {
      state.resize = ch;
      // Wrap send only to learn the payload shape the app uses, so resize() can reuse it
      // verbatim instead of guessing at fields. Always passes through.
      try {
        var orig = ch.send.bind(ch);
        ch.send = function (x) {
          try { if (typeof x === 'string') state.lastResize = JSON.parse(x); } catch (ignored) {}
          return orig(x);
        };
      } catch (e) { note('error', 'resize wrap ' + e.message); }
    }
  }

  var Native = window.RTCPeerConnection;
  if (!Native) {
    note('error', 'no RTCPeerConnection in this context');
  } else {
    var Patched = function (config, constraints) {
      var pc = new Native(config, constraints);
      state.pcs++;
      note('pc', 'constructed');
      try {
        var origCreate = pc.createDataChannel.bind(pc);
        pc.createDataChannel = function () {
          var ch = origCreate.apply(null, arguments);
          try { adopt(ch, 'local'); } catch (e) { note('error', 'adopt ' + e.message); }
          return ch;
        };
        pc.addEventListener('datachannel', function (e) {
          try { adopt(e.channel, 'remote'); } catch (err) { note('error', 'adopt ' + err.message); }
        });
      } catch (e) { note('error', 'patch ' + e.message); }
      return pc;
    };
    Patched.prototype = Native.prototype;        // keeps `pc instanceof RTCPeerConnection` true
    Object.setPrototypeOf(Patched, Native);      // keeps static members reachable
    window.RTCPeerConnection = Patched;
    if (window.webkitRTCPeerConnection === Native) window.webkitRTCPeerConnection = Patched;
    state.patchedInTime = true;
  }

  // ---- text helpers -------------------------------------------------------

  // Order matters: OSC strings contain printable text and must go before the CSI pass, and
  // control-character scrubbing must go last or it would eat the ESC that delimits the rest.
  function stripAnsi(s) {
    return String(s)
      .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, '')   // OSC .. BEL | ST  (window titles)
      .replace(/\u001B[PX^_][\s\S]*?\u001B\\/g, '')          // DCS / PM / APC / SOS
      .replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, '')            // CSI  (colour, cursor moves)
      .replace(/\u001B[@-Z\\-_]/g, '')                       // single-character Fe escapes
      .replace(/\u001B[ -\/]*[0-~]/g, '')                    // anything else ESC-introduced
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  }

  function utf8ToB64(s) {
    var bytes = new TextEncoder().encode(s), bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function newId() {
    return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function write(text) {
    var ch = state.shell;
    if (!ch) throw new Error('no shell channel - is a remote shell session open?');
    if (ch.readyState !== 'open') throw new Error('shell channel is ' + ch.readyState);
    for (var i = 0; i < text.length; i += CHUNK) ch.send(text.slice(i, i + CHUNK));
    return text.length;
  }

  // ---- public API ---------------------------------------------------------

  var KEYS = {
    enter: '\r', tab: '\t', esc: '\u001B', space: ' ', backspace: '\u007F',
    up: '\u001B[A', down: '\u001B[B', right: '\u001B[C', left: '\u001B[D',
    home: '\u001B[H', end: '\u001B[F', pageup: '\u001B[5~', pagedown: '\u001B[6~',
    'delete': '\u001B[3~'
  };

  function keyToBytes(name) {
    var k = String(name).trim();
    var lower = k.toLowerCase();
    if (KEYS[lower]) return KEYS[lower];
    var m = /^(?:c-|ctrl[+-]|\^)([a-z@\[\]\\^_])$/i.exec(k);   // 'C-c', 'ctrl+d', '^Z'
    if (m) return String.fromCharCode(m[1].toUpperCase().charCodeAt(0) - 64);
    if (k.length === 1) return k;
    throw new Error('unknown key: ' + name);
  }

  var api = {
    /** Raw write to the PTY. No newline is added. */
    send: function (text) { return write(String(text)); },

    /** Named key or control combo: 'enter', 'up', 'C-c', 'ctrl+d', '^Z'. */
    key: function (name) { return write(keyToBytes(name)); },

    /** Ctrl-C. Named separately because it is the one you reach for in a hurry. */
    interrupt: function () { return write('\u0003'); },

    /** Last n characters of the captured stream, ANSI stripped. */
    tail: function (n) {
      var s = stripAnsi(state.buf);
      n = n || 2000;
      return s.length > n ? s.slice(s.length - n) : s;
    },

    /** Raw captured stream, escapes intact. For debugging the bridge itself. */
    raw: function (n) { return state.buf.slice(-(n || 2000)); },

    clear: function () { state.buf = ''; state.dropped = 0; return true; },

    /**
     * What the xterm widget is currently *rendering*. Only meaningful for full-screen interactive
     * programs (top, nano, less). This reads the DOM, so it is subject to the background-tab
     * throttling described at the top of this file, and it only ever shows the viewport. For
     * command output use run() or tail() - those read the wire, not the screen.
     */
    screen: function () {
      var rows = document.querySelector('.xterm-rows');
      if (!rows) return null;
      return Array.prototype.map.call(rows.children, function (r) {
        return r.textContent.replace(/\u00A0/g, ' ').replace(/\s+$/, '');
      }).join('\n').replace(/\n+$/, '');
    },

    /** Resize the PTY, reusing the exact payload shape the page itself last sent. */
    resize: function (cols, rows) {
      if (!state.resize || state.resize.readyState !== 'open') throw new Error('no resize channel');
      if (!state.lastResize) throw new Error('resize shape not observed yet - resize the window once');
      var p = {};
      for (var k in state.lastResize) p[k] = state.lastResize[k];
      p.cols = cols; p.rows = rows;
      if ('colsChanged' in p) p.colsChanged = true;
      if ('rowsChanged' in p) p.rowsChanged = true;
      state.resize.send(JSON.stringify(p));
      return p;
    },

    /** Resolve once the shell channel is open and has been quiet for `quiet` ms. */
    waitReady: async function (opts) {
      opts = opts || {};
      var timeout = opts.timeout || 20000;
      var quiet = opts.quiet == null ? 300 : opts.quiet;
      var deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (state.shell && state.shell.readyState === 'open' &&
            state.lastData && (Date.now() - state.lastData) >= quiet) return true;
        await sleep(POLL_MS);
      }
      return false;
    },

    /** Wait for a pattern to appear in the live stream. For interactive prompts. */
    expect: async function (pattern, opts) {
      opts = opts || {};
      var timeout = opts.timeout || 15000;
      var re = pattern instanceof RegExp
        ? pattern
        : new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      var from = state.buf.length;
      var deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        var hay = stripAnsi(state.buf.slice(from));
        var m = re.exec(hay);
        if (m) return { matched: true, match: m[0], groups: m.slice(1), text: hay };
        await sleep(POLL_MS);
      }
      return { matched: false, text: stripAnsi(state.buf.slice(from)) };
    },

    /**
     * Run a command and wait for it to finish. Returns {ok, exitCode, stdout, ms, ...}.
     *
     * The command is base64'd and fed to a fresh shell over a pipe, so quoting, newlines and
     * shell metacharacters in `cmd` are never seen by the interactive readline at the other end -
     * a multi-line script is as safe as `ls`. stdout and stderr are merged, in order, as a
     * terminal would show them.
     *
     * Because that inner shell reads its script from a pipe, its stdin is NOT the terminal.
     * Anything wanting to prompt interactively (`sudo` without a cached credential, `ssh`,
     * `passwd`) fails here rather than hangs. Drive those with send()/key()/expect() instead.
     */
    run: async function (cmd, opts) {
      opts = opts || {};
      var timeout = opts.timeout || 30000;
      var shell = opts.shell || 'bash';
      var t0 = Date.now();
      var id = newId();
      var beg = '__PIXBEG_' + id + '__';
      var endPrefix = '__PIXEND_' + id + '_';
      var b64 = utf8ToB64(String(cmd));

      if (b64.length > MAX_CMD) {
        throw new Error('command too large (' + b64.length + ' b64 chars, max ' + MAX_CMD +
                        '). Write it to a file on the Pi in pieces, then run the file.');
      }

      // The '' inside each printf literal is what keeps this honest. The PTY echoes the command
      // line straight back into the capture, so a marker written plainly would appear twice -
      // once as echo, once as output - and the parse could latch onto the echo and return an
      // empty result with a bogus exit code. Written as '__PIX''BEG_id__' the shell concatenates
      // it into the real marker, while the echoed bytes carry the quotes and never match.
      var line =
        "printf '__PIX''BEG_" + id + "__\\n'; " +
        "printf %s '" + b64 + "' | base64 -d | " + shell + "; " +
        "printf '__PIX''END_" + id + "_%d__\\n' \"$?\"\r";

      var from = state.buf.length;
      var droppedAtStart = state.dropped;
      write(line);

      var deadline = Date.now() + timeout;
      var hay = '', endAt = -1, closeAt = -1;
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        hay = state.buf.slice(from);
        endAt = hay.indexOf(endPrefix);
        if (endAt !== -1) {
          closeAt = hay.indexOf('__', endAt + endPrefix.length);
          if (closeAt !== -1) break;
        }
        endAt = -1;
      }

      var timedOut = endAt === -1;
      if (timedOut && opts.interruptOnTimeout !== false) {
        // Leave the session usable. The command being interrupted is one this call started.
        try { write('\u0003'); } catch (ignored) {}
      }

      var begAt = hay.indexOf(beg);
      var bodyFrom = begAt === -1 ? 0 : begAt + beg.length;
      var body = timedOut ? hay.slice(bodyFrom) : hay.slice(bodyFrom, endAt);
      var code = null;
      if (!timedOut) {
        var digits = hay.slice(endAt + endPrefix.length, closeAt);
        if (/^\d+$/.test(digits)) code = parseInt(digits, 10);
      }

      var truncated = state.dropped > droppedAtStart;

      return {
        ok: !timedOut && code === 0 && !truncated,
        exitCode: code,
        stdout: stripAnsi(body).replace(/^\n+/, '').replace(/\n+$/, ''),
        ms: Date.now() - t0,
        timedOut: timedOut || undefined,
        // begAt === -1 means the opening marker never arrived: capture started mid-stream, or the
        // buffer wrapped. stdout may be missing its head.
        markerMissing: begAt === -1 || undefined,
        truncated: truncated || undefined
      };
    },

    status: function () {
      return {
        shell: state.shell ? state.shell.readyState : null,
        resize: state.resize ? state.resize.readyState : null,
        peerConnections: state.pcs,
        bufferChars: state.buf.length,
        droppedChars: state.dropped,
        msSinceData: state.lastData ? Date.now() - state.lastData : null,
        geometry: state.lastResize ? { cols: state.lastResize.cols, rows: state.lastResize.rows } : null,
        path: location.pathname
      };
    },

    /** Is this bridge actually in a position to work? Check before trusting a thin result. */
    health: function () {
      var problems = [];
      if (!state.patchedInTime) problems.push('RTCPeerConnection was not patched');
      if (state.pcs === 0) problems.push('no peer connection seen - script may have loaded after the page bundle (needs @run-at document-start), or this page has no shell');
      if (!state.shell) problems.push('no shell channel - open a remote shell session');
      else if (state.shell.readyState !== 'open') problems.push('shell channel is ' + state.shell.readyState);
      if (!document.querySelector('.xterm-rows')) problems.push('no xterm widget on this page');
      return { ok: problems.length === 0, problems: problems, status: api.status(), events: state.events.slice(-12) };
    },

    version: '0.2.2'
  };

  window.__pix = api;

  // ---- optional sidecar link ----------------------------------------------
  //
  // If the local MCP sidecar is running, connect to it, so the assistant gets real tools instead
  // of evaluating JavaScript in this page. If it is not running, this amounts to one failed
  // loopback connection every few seconds and nothing else.
  //
  // This is the only thing in the bridge that acts without being asked, so keep its reach exact:
  // it *offers* a connection to 127.0.0.1, answers questions the sidecar asks, and on its own
  // says only what this page is: version, path, and whether its shell is open (see reportShell).
  // The sidecar can only invoke what __pix already exposes, only while a Pi Connect tab is open,
  // and only from this machine. Set localStorage.__pixNoSidecar = '1' to stop trying entirely.

  var SIDECAR_URL = 'ws://127.0.0.1:8732/pix';
  var backoff = 1000;
  var retry = null;           // the scheduled reconnect, if there is one
  var link = null;            // the socket to the sidecar while it is open
  var told = null;            // the shell state this link last reported
  var refusedAs = null;       // the shell state the hub judged this tab on when it stood us by

  function shellOpen() { return !!state.shell && state.shell.readyState === 'open'; }

  // Which tab holds the bridge turns on whether it has a live shell (see hub.js), so the sidecar
  // hears when that changes. Like the rest of this link it reaches only 127.0.0.1, and what it
  // carries is a fact about this page, never a command to the Pi.
  function reportShell() {
    var has = shellOpen();
    if (link) {
      if (has === told) return;
      told = has;
      try { link.send(JSON.stringify({ type: 'status', shell: has, path: location.pathname })); } catch (e) {}
    } else if (has && refusedAs === false && retry) {
      // Stood by for having no shell, and now there is one. The hub lets a page with a shell take
      // over from a holder without one, so ask again now instead of idling out the 30s. This is
      // still the same socket retry; it only moves the next attempt earlier.
      clearTimeout(retry);
      connectSidecar();
    }
  }

  function toPattern(p) {
    // A regex source if it parses as one, otherwise hand the raw string to expect(), which
    // escapes it and matches literally.
    try { return new RegExp(p); } catch (e) { return String(p); }
  }

  function dispatch(method, p) {
    p = p || {};
    switch (method) {
      case 'run':    return api.run(p.command, { timeout: p.timeout, shell: p.shell });
      case 'send':   return api.send(p.text);
      case 'key':    return api.key(p.key);
      case 'expect': return api.expect(toPattern(p.pattern), { timeout: p.timeout });
      case 'tail':   return api.tail(p.chars);
      case 'raw':    return api.raw(p.chars);
      case 'screen': return api.screen();
      case 'status': return api.status();
      case 'health': return api.health();
      case 'clear':  return api.clear();
      case 'resize': return api.resize(p.cols, p.rows);
      default: throw new Error('unknown method: ' + method);
    }
  }

  function scheduleReconnect() {
    retry = setTimeout(connectSidecar, backoff);
    backoff = Math.min(backoff * 2, 30000);
  }

  function connectSidecar() {
    retry = null;
    try { if (localStorage.getItem('__pixNoSidecar') === '1') return; } catch (e) { /* no storage */ }
    var ws;
    try { ws = new WebSocket(SIDECAR_URL); } catch (e) { return scheduleReconnect(); }
    var opened = false;
    var helloShell = null;

    ws.onopen = function () {
      opened = true;
      backoff = 1000;
      link = ws;
      refusedAs = null;
      told = helloShell = shellOpen();
      note('sidecar', 'connected');
      try {
        ws.send(JSON.stringify({ type: 'hello', version: api.version, path: location.pathname, shell: helloShell }));
      } catch (e) {}
    };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id == null) return;
      Promise.resolve()
        .then(function () { return dispatch(msg.method, msg.params); })
        .then(function (result) { ws.send(JSON.stringify({ id: msg.id, ok: true, result: result })); })
        .catch(function (err) {
          ws.send(JSON.stringify({ id: msg.id, ok: false, error: String((err && err.message) || err) }));
        });
    };

    ws.onclose = function (ev) {
      if (link === ws) link = null;
      // 4001 means another Pi Connect tab already holds the bridge; 4002 means this tab held it
      // without a shell and a tab with one took over. Retrying hard would produce the ping-pong
      // described in hub.js, so back off to a slow poll: this tab takes over within half a minute
      // of the holder going away, and stays quiet until then.
      var code = ev && ev.code;
      if (code === 4001 || code === 4002) {
        note('sidecar', code === 4001 ? 'standing by, another tab holds it'
                                      : 'standing by, a tab with a live shell took over');
        backoff = 30000;
        // A 4001 is decided on our hello; a 4002 because the hub believed we had no shell.
        refusedAs = code === 4001 ? helloShell : false;
      } else {
        refusedAs = null;
        if (opened) note('sidecar', 'disconnected');
      }
      scheduleReconnect();
      reportShell();      // a shell that came up after the hub judged us gets its say now
    };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* already closing */ } };
  }

  connectSidecar();
  }

  // Inject the library as a <script> tag rather than just calling it.
  //
  // Whether a userscript's `window` IS the page's `window` depends on how the extension injected
  // it, which depends on browser settings the script cannot see. Under Manifest V3 a manager may
  // run even a `@grant none` script in an isolated world - and then everything above executes
  // perfectly, patches an RTCPeerConnection the page will never call, and reports no error at all.
  // The DOM is shared across worlds, so a <script> element always evaluates in the page's main
  // world. Verified on connect.raspberrypi.com 2026-08-30: inline script is not CSP-blocked.
  try {
    var el = document.createElement('script');
    el.textContent = '(' + __pixLib.toString() + ')();';
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  } catch (e) {
    try { __pixLib(); } catch (ignored) { /* nothing left to try */ }
  }
})();
