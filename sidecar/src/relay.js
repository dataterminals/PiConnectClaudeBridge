// Every session's sidecar gets working tools, whichever one holds the port.
//
// A sidecar starts with its Claude Code session, and only one process can listen on
// 127.0.0.1:8732. The first version tried the port once at startup and gave up, so the first
// session to start was the hub for as long as it lived, even one that never touched the Pi.
// Every later session's pi_* tools could only say the port was taken. When the holder's session
// closed, nothing took over: the sidecars already running never tried again. Everything that
// reaches the Pi through /run, including claudebot's route away from home, went dark until some
// new session happened to start. Seen 2026-10-07: an idle session held the hub for hours, and
// finding out which one took an hour.
//
// Now a sidecar that can't claim the port relays through the one that has it, over the same
// loopback routes a native program uses (POST /run, POST /call). It also tries the port again
// every few seconds. When the holder exits, the first sidecar to retry becomes the hub, and the
// page reconnects to it on its own backoff (1s, 2s, 4s...). No session is special.
//
// Claiming a port sends nothing anywhere. The relay reaches only 127.0.0.1, and only when a tool
// is called.

import { describeStartupFailure } from './hub.js';

/**
 * @param {object}   opts
 * @param {object}   opts.hub        a hub from createHub(), not yet listening
 * @param {number}   [opts.retryMs]  how often a sidecar that isn't the hub tries the port again
 * @param {function} [opts.log]      called with human-readable status lines
 */
export function createRelay({ hub, retryMs = 3000, log = () => {} }) {
  const port = hub.port;
  const base = 'http://127.0.0.1:' + port;
  let timer = null;
  let stopped = false;
  let claiming = null;      // the claim in flight, so two callers never listen() at once
  let bindError = null;     // why the last claim failed
  let told = false;         // whether this sidecar has said it is relaying

  const isHub = () => hub.listening();

  /** Try once to hold the port. Resolves true if this sidecar is the hub afterwards. */
  function claim() {
    if (isHub()) return Promise.resolve(true);
    if (!claiming) {
      claiming = hub.listen().then(
        () => {
          bindError = null;
          if (told) log('the sidecar that held 127.0.0.1:' + port + ' has gone; this one is the hub now');
          return true;
        },
        (e) => { bindError = e; return false; }
      ).finally(() => { claiming = null; });
    }
    return claiming;
  }

  async function tick() {
    timer = null;
    if (stopped || isHub()) return;
    if (await claim()) return;
    if (!told) {
      told = true;
      log(bindError.code === 'EADDRINUSE'
        ? 'another process holds 127.0.0.1:' + port + '; relaying through it, and trying the ' +
          'port again every ' + retryMs / 1000 + 's'
        : describeStartupFailure(bindError, port));
    }
    if (stopped) return;
    timer = setTimeout(tick, retryMs);
    timer.unref?.();
  }

  /** Make the first claim, and keep retrying in the background if it fails. */
  async function start() { stopped = false; await tick(); }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function relayError(e, path) {
    const code = e && e.cause && e.cause.code;
    if (code === 'ECONNREFUSED') {
      const err = new Error('nothing holds 127.0.0.1:' + port + ' right now: the sidecar that ' +
        'did has gone, and another takes over within ' + Math.ceil(retryMs / 1000) + 's. Try again.');
      err.refused = true;
      return err;
    }
    if (e && e.name === 'TimeoutError') {
      return new Error('the sidecar holding 127.0.0.1:' + port + ' did not answer ' + path + ' in time');
    }
    // The holder's session ended mid-call. As in hub.js, this claims nothing about whether the
    // command reached the Pi.
    return new Error('the sidecar holding 127.0.0.1:' + port + ' went away before answering; ' +
                     'the command may or may not have run');
  }

  async function post(path, body, waitMs) {
    let res;
    try {
      res = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(waitMs + 5000)
      });
    } catch (e) {
      throw relayError(e, path);
    }
    let data = null;
    try { data = JSON.parse(await res.text()); } catch { /* not JSON, so not a route of ours */ }
    if (res.status === 426 && path === '/call') {
      // A sidecar from before /call answers unknown routes with 426. It still serves /run.
      const err = new Error('the sidecar holding 127.0.0.1:' + port + ' is an older version ' +
        'without POST /call, so only pi_run can go through it. Restart the Claude Code session it ' +
        'belongs to (or wait for it to close); this sidecar takes over the port then.');
      err.olderHolder = true;
      throw err;
    }
    if (!data) throw new Error('whatever holds 127.0.0.1:' + port + ' answered ' + path + ' with HTTP ' + res.status);
    if (res.status !== 200) throw new Error(data.error || ('the hub answered ' + path + ' with HTTP ' + res.status));
    return data;
  }

  // In-process when this sidecar is the hub, over loopback when it isn't. Finding nobody on the
  // port means the holder just left: claim it, or, if another sidecar won that race, ask it.
  async function either(local, path, body, waitMs) {
    if (isHub()) return local();
    for (let attempt = 0; ; attempt++) {
      try {
        return await post(path, body, waitMs);
      } catch (e) {
        if (!e.refused || attempt > 0) throw e;
        if (await claim()) return local();
      }
    }
  }

  function run(params, waitMs) {
    return either(() => hub.run(params, waitMs), '/run',
                  { command: params.command, timeout: params.timeout, shell: params.shell }, waitMs);
  }

  async function call(method, params = {}, waitMs = 45000) {
    if (isHub()) return hub.call(method, params, waitMs);
    const r = await either(() => hub.call(method, params, waitMs).then((result) => ({ result })),
                           '/call', { method, params, timeout: waitMs }, waitMs);
    return r.result;
  }

  /** The holder's /health, or null if nothing that answers like a hub is there. */
  async function peek() {
    try {
      const res = await fetch(base + '/health', { signal: AbortSignal.timeout(3000) });
      const data = await res.json();
      return data && typeof data.connected === 'boolean' ? data : null;
    } catch {
      return null;
    }
  }

  /** What pi_health reports: who holds the port, the page it serves, and the page's own health. */
  async function health() {
    if (isHub()) {
      return { holder: 'this sidecar (pid ' + process.pid + ')', attachedPage: hub.info(),
               bridge: await hub.call('health', {}) };
    }
    const h = await peek();
    if (!h) {
      if (await claim()) return health();   // the holder had gone; this sidecar is the hub now
      throw new Error(describeStartupFailure(bindError, port));
    }
    const who = h.pid ? 'pid ' + h.pid + ', parent pid ' + h.parentPid : 'an older version that does not give its pid';
    // Who holds the port and which page it serves are worth showing even when the holder is too
    // old to pass the page's own health check along. Right after this change, every session
    // still running is in that position.
    let bridge;
    try {
      bridge = await call('health', {});
    } catch (e) {
      if (!e.olderHolder) throw e;
      bridge = 'not available: ' + e.message;
    }
    return {
      holder: 'another sidecar (' + who + '); this one relays through it and takes over if it exits',
      attachedPage: h.page,
      bridge
    };
  }

  return { start, stop, run, call, health, isHub, port };
}
