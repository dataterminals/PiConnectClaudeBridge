# The Pi Connect remote-shell wire protocol

Everything here was observed live against `connect.raspberrypi.com` on **2026-08-30**, in Edge,
against a Pi 4 B running Raspberry Pi OS (`Linux aarch64`). None of it is documented by Raspberry
Pi and none of it is promised to stay put. `__pix.health()` is the thing that tells you it moved.

## Shape of the session

The page at `/devices/<device-id>/remote-shell-session` is a Rails + Turbo app that renders an
xterm.js widget. The interesting part is that **the shell does not run over HTTP at all**.

The HTTP traffic during connection setup is only signalling:

| Request | Purpose |
|---|---|
| `GET  /devices/<id>.json` | device metadata |
| `POST /devices/<id>/connections` | offer the SDP, open a connection record |
| `GET  /devices/<id>/connections/<conn-id>` | poll for the answer / ICE candidates |

After that the browser and the Pi hold a **WebRTC peer connection** and every byte of the session
rides its data channels. There is no WebSocket anywhere in the page. This is what makes the whole
arrangement worth building on: the shell is peer-to-peer between this browser and the Pi, and the
Pi needs no inbound port.

## The two data channels

| Label | Opened by | Direction | Payload |
|---|---|---|---|
| `shell` | the browser, via `pc.createDataChannel('shell')` | both | raw PTY bytes |
| `resize` | the Pi, arriving as an `ondatachannel` event | browser → Pi | JSON geometry |

**The two directions of `shell` are not symmetric, and this is the detail that costs an afternoon
if you assume otherwise:**

* **Inbound** (Pi → browser) frames arrive as `ArrayBuffer`.
* **Outbound** (browser → Pi) frames are sent as plain JavaScript **strings**.

Both were confirmed by wrapping `send` and listening for `message` on the live channel. Typing `#`
in the terminal produced exactly:

```
send:shell:"#"                 <- outbound, a string
msg:shell:AB[1]"#"             <- inbound, an ArrayBuffer: the PTY echo
```

The first two frames of any session are the shell announcing itself:

```
AB[8]   \x1b[?2004h                                   bracketed paste mode on
AB[61]  \x1b]0;sylvi@sylpi: ~\x07\x1b[01;32m...        window title + coloured prompt
```

`resize` carries a JSON object the browser sends whenever the widget's geometry changes:

```json
{"cols":245,"rows":55,"colsChanged":true, ...}
```

`__pix.resize()` deliberately never synthesises this object from scratch. It clones the last one
the page itself sent and overwrites `cols`/`rows`, so any field this note failed to record is
carried along untouched.

## Why the bridge hooks `RTCPeerConnection`

There is no other seam. Specifically, all of these were checked and none of them work:

* **No global holds the terminal.** Scanning `window` for anything with `buffer`/`cols`/`rows`
  finds nothing; the xterm `Terminal` lives in a module closure in `application-<hash>.js`.
* **No framework back-pointer on the element.** `.xterm` has no `__reactFiber*`, `__vue__` or
  `__svelte*` key — the app is plain Turbo, so there is no component tree to walk.
* **The DOM is a lossy view of the session.** The renderer is the DOM renderer (`.xterm` carries
  `xterm-dom-renderer-owner-1`, and there is no `<canvas>`), which is convenient for reading the
  screen — but it only ever materialises the **viewport**. Scrollback is not in the DOM.
* **Rendering stops in a background tab.** xterm paints on `requestAnimationFrame`, which Chrome
  throttles to a standstill when the tab is not visible. Observed directly: a character injected
  into the terminal stayed invisible until the tab was foregrounded, at which point it appeared.
  Anything that reads the screen therefore reports "nothing happened" for a command that ran fine.

Hooking the data channel sidesteps all four. The capture is the byte stream itself, so it is
complete, ordered, unaffected by window size, and entirely indifferent to whether the tab is
visible.

The cost of that choice is the timing constraint: the patch must be installed **before** the page
bundle constructs its `RTCPeerConnection`, hence `@run-at document-start`. There is no way to
adopt a peer connection after the fact.

## Input paths, and why the obvious one is wrong

Synthetic input *does* reach the terminal — dispatching a `ClipboardEvent('paste')` with a real
`DataTransfer` at `.xterm-helper-textarea` works, and Chrome does preserve `clipboardData` on a
synthetic event (contrary to a lot of folklore). It is still the wrong path:

1. **Bracketed paste is on** (`\x1b[?2004h`, above). Readline wraps pasted text in
   `\x1b[200~ … \x1b[201~` and *inserts* it rather than executing it, so a trailing `\r` inside a
   paste does not submit the command. You end up needing a separate synthetic keydown anyway.
2. It requires the textarea to be focused, which the page can steal.
3. It tells you nothing about what came back.

Writing strings straight onto the `shell` channel has none of those problems: it is exactly what
the app does when you type, it needs no focus, and it works in a hidden tab.

## Delimiting a command

Raw PTY bytes have no notion of where a command's output starts or ends, and no exit status. The
bridge imposes both by wrapping every `run()` in markers:

```sh
printf '__PIX''BEG_<id>__\n'; printf %s '<base64>' | base64 -d | bash; printf '__PIX''END_<id>_%d__\n' "$?"
```

Three things are load-bearing:

* **The command travels as base64.** The interactive readline on the far end never sees the user's
  quoting, newlines or metacharacters — it sees one long base64 word. A multi-line script with
  backticks and nested quotes is as safe as `ls`.
* **`'__PIX''BEG_…'` is split on purpose.** The PTY echoes the command line back into the capture
  before any output arrives, so a marker written plainly would appear **twice**. A parser that
  latched onto the echo would return empty output and a nonsense exit code — and report success
  while doing it. The shell concatenates `'__PIX'` and `'BEG_…'` into the real marker, while the
  echoed bytes keep the quotes and can never match. `tests/protocol.test.js` guards this.
* **`"$?"` is captured after the pipeline**, giving the inner shell's real exit status.

The trade-off: because the inner `bash` reads its script from a pipe, **its stdin is not the
terminal**. Anything wanting to prompt — `sudo` without a cached credential, `ssh`, `passwd` —
fails fast instead of hanging. That is the right default for scripted work; drive interactive
programs with `send()` / `key()` / `expect()` and read `screen()` instead.

## Verified round trip

The design was proved end-to-end on the live Pi before any of it was written up. A three-line
script with an embedded quote and a deliberate non-zero exit:

```
begFound true | endFound true | exitCode 7 | stdout >>Linux aarch64
marker test ok<<
```

Correct exit code, both markers found, echo excluded, ANSI stripped.
