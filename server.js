'use strict';
// claude-chats-web — tiny local server that lists claude-chats and runs each one
// in the browser via a PTY wrapping the real `chat` shell function.
//
// Security: binds to 127.0.0.1 ONLY, gated by a per-start token. Never expose
// this to a network — it runs an agent with --dangerously-skip-permissions.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const HOME = process.env.HOME;
const CHATS_ROOT = path.join(HOME, 'claude-chats');
const ARCHIVE_ROOT = path.join(CHATS_ROOT, '.archive');
const PORT = parseInt(process.env.CHATWEB_PORT || '8790', 10);
const HOST = '127.0.0.1';
const TOKEN = process.env.CHATWEB_TOKEN || crypto.randomBytes(9).toString('base64url');
// `chat` is a zsh function, so the PTY must run zsh even if the user's login shell
// is bash/fish — otherwise the session dies with "chat: command not found".
const LOGIN_SHELL = process.env.SHELL || '';
const SHELL = /(^|\/)zsh$/.test(LOGIN_SHELL) ? LOGIN_SHELL : '/bin/zsh';

// Only accept requests whose Host/Origin are our own loopback endpoint. This defeats
// DNS-rebinding (attacker page rebinds its domain to 127.0.0.1) and cross-origin
// driving from another site — even if the token somehow leaked. Requests with no
// Origin header (top-level navigation, curl) are allowed; the token still gates them.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const hostOk = (req) => ALLOWED_HOSTS.has(req.headers.host);
const originOk = (req) => { const o = req.headers.origin; return !o || ALLOWED_ORIGINS.has(o); };

// Lock the page to same-origin resources only; block external loads/exfiltration.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Chat names become directory names and are passed to the shell — keep them strict.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Vendor/build dirs never contain the user's notes, but they hold the overwhelming
// majority of the files — a single .venv or node_modules is tens of thousands of
// entries. Walking them made every search keystroke traverse the whole workspace AND
// polluted results with dependency READMEs. Skipped here plus all dotdirs.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.terraform', '.venv', 'venv', 'env', '__pycache__',
  'dist', 'build', 'out', '.next', '.nuxt', 'target', 'vendor', 'Pods',
  '.cache', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'coverage', '.gradle',
]);
const MAX_DEPTH = 6;             // notes nested deeper than this aren't notes
const MAX_WALK_ENTRIES = 5000;   // hard stop so one pathological dir can't stall a search
const MAX_MD_BYTES = 512 * 1024; // skip generated/huge .md — they aren't hand-written notes
const INDEX_TTL_MS = 1500;       // burst window: don't re-walk on every keystroke

// Persistent session registry: a chat's PTY lives here, DECOUPLED from any socket,
// so a dropped/closed connection does NOT kill Claude. Keyed by chat name.
const sessions = new Map(); // name -> { name, term, cols, rows, ws, buf[], bufLen, graceTimer, exited }
const MAX_BUFFER = 256 * 1024;                                  // replay tail kept per session
// 0 = never reap a disconnected session (default). A session lives until Claude
// exits, you close its tab (×), or you stop the server. Set >0 (ms) to auto-reap
// sessions left with no client attached for that long, to reclaim RAM.
const DETACH_GRACE_MS = parseInt(process.env.CHATWEB_DETACH_GRACE_MS || '0', 10);
const isLive = (name) => { const s = sessions.get(name); return !!s && !s.exited; };

// Dropped/pasted images: the browser can't hand us a real file path, so we write
// the bytes to a temp file here (outside chat workspaces → not in backups) and type
// that path into the PTY, exactly like dragging a file into a real terminal.
const UPLOAD_DIR = path.join(__dirname, '.uploads');
const MAX_UPLOAD = 20 * 1024 * 1024;
function pruneUploads() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const p = path.join(UPLOAD_DIR, f);
      try { if (now - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}
function saveUpload(name, dataB64) {
  const buf = Buffer.from(String(dataB64 || ''), 'base64');
  if (!buf.length || buf.length > MAX_UPLOAD) return null;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const clean = (String(name || 'image.png').split(/[\\/]/).pop() || 'file')
    .replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(-80) || 'file';
  const fp = path.join(UPLOAD_DIR, crypto.randomBytes(4).toString('hex') + '-' + clean);
  fs.writeFileSync(fp, buf);
  return fp;
}

// ---- dragged folder/file → real filesystem path -------------------------------
// Browsers deliberately never expose the true path of a dragged item (File.path is
// Electron-only), which is why a Finder drag that works in the CLI did nothing here.
// But this server runs locally as the same user, so we can *find* it: look up the
// basename, then verify each candidate against a signature the browser CAN see —
// size+mtime for a file, child names for a folder. A single verified hit is typed in
// exactly like a real terminal drag.
const RESOLVE_ROOTS = [HOME, '/Volumes'];
const RESOLVE_TIMEOUT_MS = 5000;
const RESOLVE_MAX = 60;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: RESOLVE_TIMEOUT_MS, maxBuffer: 4 << 20, encoding: 'utf8' },
      (err, stdout) => resolve(err && !stdout ? '' : String(stdout || '')));
  });
}

async function findByName(base, wantDir) {
  const hits = new Set();
  const roots = RESOLVE_ROOTS.filter((r) => { try { return fs.existsSync(r); } catch { return false; } });

  // Spotlight is indexed and near-instant; it's the common path on macOS.
  if (process.platform === 'darwin') {
    for (const root of roots) {
      const out = await run('mdfind', ['-onlyin', root, `kMDItemFSName == ${JSON.stringify(base)}`]);
      for (const l of out.split('\n')) if (l && path.basename(l) === base) hits.add(l);
      if (hits.size >= RESOLVE_MAX) break;
    }
  }
  // Fallback (Linux, or anything Spotlight hasn't indexed / excluded).
  if (!hits.size) {
    const prune = [];
    for (const d of SKIP_DIRS) prune.push('-name', d, '-o');
    for (const root of roots) {
      const out = await run('find', [
        root, '-maxdepth', '8',
        '(', ...prune, '-name', '.*', ')', '-prune', '-o',
        '-name', base, '-type', wantDir ? 'd' : 'f', '-print',
      ]);
      for (const l of out.split('\n')) if (l) hits.add(l);
      if (hits.size >= RESOLVE_MAX) break;
    }
  }
  return [...hits].slice(0, RESOLVE_MAX);
}

// Score a candidate against the browser-visible signature. -1 = not a match.
function scoreCandidate(p, desc) {
  let st; try { st = fs.statSync(p); } catch { return -1; }
  if (desc.kind === 'dir') {
    if (!st.isDirectory()) return -1;
    const want = Array.isArray(desc.children) ? desc.children : [];
    if (!want.length) return 0;
    let have;
    try { have = new Set(fs.readdirSync(p)); } catch { return -1; }
    let n = 0;
    for (const c of want) if (have.has(c)) n++;
    // Every child the browser saw must exist here, else it's a different folder.
    return n === want.length ? n : -1;
  }
  if (!st.isFile()) return -1;
  if (typeof desc.size === 'number' && st.size !== desc.size) return -1;
  // Finder/browser mtime is ms but filesystems vary; allow a small skew.
  if (typeof desc.mtime === 'number' && Math.abs(st.mtimeMs - desc.mtime) > 2000) return -1;
  return 1;
}

async function resolveDrop(desc) {
  const base = String(desc.name || '').split(/[\\/]/).pop();
  if (!base || base === '.' || base === '..') return { paths: [] };
  const cands = await findByName(base, desc.kind === 'dir');
  const scored = [];
  for (const p of cands) {
    const sc = scoreCandidate(p, desc);
    if (sc >= 0) scored.push({ p, sc });
  }
  scored.sort((a, b) => b.sc - a.sc || a.p.length - b.p.length);
  return { paths: scored.map((x) => x.p) };
}

// Match a real terminal drag: Finder backslash-escapes spaces in the pasted path.
const shellEscape = (p) => p.replace(/([ "'\\()[\]{}$&;|<>*?!`~#])/g, '\\$1');

function pushBuf(s, chunk) {
  s.buf.push(chunk); s.bufLen += chunk.length;
  while (s.bufLen > MAX_BUFFER && s.buf.length > 1) s.bufLen -= s.buf.shift().length;
}
// Terminal bytes go as BINARY frames, control messages as TEXT JSON. The frame type
// keeps them unambiguous — PTY output can contain anything, including valid JSON.
function sendPty(ws, str) { if (ws && ws.readyState === 1) { try { ws.send(Buffer.from(str, 'utf8')); } catch {} } }
function sendCtl(ws, obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} } }
function killSession(name) {
  const s = sessions.get(name); if (!s) return;
  if (s.graceTimer) clearTimeout(s.graceTimer);
  sessions.delete(name);
  try { s.term.kill(); } catch {}
}
function startSession(name, cols, rows) {
  // Reuse the EXISTING `chat` function from ~/.zshrc. Name passed as $1 (argv),
  // never interpolated into the command string, so it can't inject shell.
  const term = pty.spawn(SHELL, ['-i', '-c', 'chat "$1"', 'claude-chats-web', name], {
    name: 'xterm-256color', cols, rows, cwd: HOME, env: process.env,
  });
  const s = { name, term, cols, rows, ws: null, buf: [], bufLen: 0, graceTimer: null, exited: false };
  sessions.set(name, s);
  term.onData((d) => { pushBuf(s, d); sendPty(s.ws, d); });
  term.onExit(() => {
    s.exited = true;
    sendPty(s.ws, '\r\n\x1b[90m[session ended]\x1b[0m\r\n');
    sessions.delete(name);
  });
  return s;
}

const XTERM_DIR = path.dirname(require.resolve('@xterm/xterm/package.json'));
const FIT_DIR = path.dirname(require.resolve('@xterm/addon-fit/package.json'));
const SEARCH_DIR = path.dirname(require.resolve('@xterm/addon-search/package.json'));

// Bounded walk for a chat's notes. Returns the *.md files (minus CLAUDE.md) with
// their stats — no file contents read, so it's cheap enough for the list view.
function walkMd(dir) {
  const files = [];
  const stack = [[dir, 0]];
  let seen = 0;
  while (stack.length) {
    const [d, depth] = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++seen > MAX_WALK_ENTRIES) return files;
      if (e.isDirectory()) {
        if (depth >= MAX_DEPTH || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        stack.push([path.join(d, e.name), depth + 1]);
      } else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'CLAUDE.md') {
        let st; try { st = fs.statSync(path.join(d, e.name)); } catch { continue; }
        files.push({ path: path.join(d, e.name), size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  return files;
}

// Per-chat search index, invalidated by a signature over the file set (path+mtime+size)
// so edits are picked up immediately, but an unchanged workspace is never re-read.
const indexCache = new Map(); // dir -> { at, sig, text, lower, updated }
function chatIndex(dir, withText) {
  const hit = indexCache.get(dir);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS && (!withText || hit.text !== null)) return hit;

  const files = walkMd(dir);
  let sig = '', updated = 0;
  for (const f of files) {
    sig += `${f.path}:${f.mtimeMs}:${f.size}|`;
    if (f.mtimeMs > updated) updated = f.mtimeMs;
  }
  if (hit && hit.sig === sig && (!withText || hit.text !== null)) { hit.at = Date.now(); return hit; }

  let text = null;
  if (withText) {
    text = '';
    for (const f of files) {
      if (f.size > MAX_MD_BYTES) continue;
      try { text += fs.readFileSync(f.path, 'utf8') + '\n'; } catch {}
    }
  }
  const rec = { at: Date.now(), sig, text, lower: text === null ? null : text.toLowerCase(), updated };
  indexCache.set(dir, rec);
  return rec;
}

// Iterate every chat dir across active + archive roots.
function eachChat(fn) {
  for (const [root, archived] of [[CHATS_ROOT, false], [ARCHIVE_ROOT, true]]) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      fn(e.name, path.join(root, e.name), archived);
    }
  }
}

function listChats() {
  const out = [];
  eachChat((name, dir, archived) => {
    let created = 0, updated = 0;
    try { const s = fs.statSync(dir); created = s.birthtimeMs || s.ctimeMs; updated = s.mtimeMs; } catch {}
    // Newest note wins — dir mtime alone misses edits to an existing file.
    const noteMtime = chatIndex(dir, false).updated;
    if (noteMtime > updated) updated = noteMtime;
    out.push({ name, archived, created, updated, live: !archived && isLive(name) });
  });
  return out.sort((a, b) => b.updated - a.updated);
}

// Web equivalent of `chatfind`: multi-keyword AND search over *.md (minus CLAUDE.md).
// "github own" matches a chat whose notes contain BOTH "github" and "own" anywhere.
function searchChats(q) {
  const tokens = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const results = [];
  eachChat((name, dir, archived) => {
    const idx = chatIndex(dir, true);
    if (tokens.every((t) => idx.lower.includes(t))) {
      results.push({ name, archived, snippet: bestSnippet(idx.text, tokens), live: !archived && isLive(name), updated: idx.updated });
    }
  });
  return results.sort((a, b) => b.updated - a.updated);
}
// The line covering the most query tokens (stops early on a full match).
function bestSnippet(text, tokens) {
  let best = null, bestScore = 0;
  for (const line of text.split('\n')) {
    const l = line.toLowerCase();
    let score = 0;
    for (const t of tokens) if (l.includes(t)) score++;
    if (score > bestScore) { bestScore = score; best = line.trim(); if (score === tokens.length) break; }
  }
  return best ? best.slice(0, 160) : null;
}

function moveChat(name, toArchive) {
  // Must be an explicit string: NAME_RE.test(undefined) coerces to "undefined",
  // which *passes* the pattern and used to reach path.join() as undefined.
  if (typeof name !== 'string' || !NAME_RE.test(name)) return { ok: false, error: 'invalid name' };
  if (toArchive && isLive(name)) return { ok: false, error: 'session is running — close it first' };
  const src = path.join(toArchive ? CHATS_ROOT : ARCHIVE_ROOT, name);
  const dst = path.join(toArchive ? ARCHIVE_ROOT : CHATS_ROOT, name);
  if (!fs.existsSync(src)) return { ok: false, error: 'not found' };
  if (fs.existsSync(dst)) return { ok: false, error: 'a chat with that name already exists on the other side' };
  try { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.renameSync(src, dst); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
  return { ok: true };
}

const CT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
// Vendor bundles (xterm + addons, ~370 KB) never change while the server runs, so
// they're read once. Our own public/ files are deliberately NOT cached — a contributor
// editing app.js/index.html should just reload the browser, not restart the server.
const fileCache = new Map();
function sendFile(res, file, cache = false) {
  const hit = cache && fileCache.get(file);
  if (hit) { res.writeHead(200, { 'content-type': hit.ct, 'cache-control': 'no-cache' }); res.end(hit.buf); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ct = CT[path.extname(file)] || 'application/octet-stream';
    if (cache) fileCache.set(file, { buf, ct });
    res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-cache' });
    res.end(buf);
  });
}
function json(res, obj, code = 200) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
// Cap the body: without a limit a stuck/hostile client can grow this unbounded.
const MAX_BODY = 64 * 1024;
function readBody(req) {
  return new Promise((resolve) => {
    let b = '', over = false;
    req.on('data', (c) => { if (over) return; b += c; if (b.length > MAX_BODY) { over = true; b = ''; } });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}
// JSON.parse on a malformed body used to throw inside the async handler — an
// unhandled rejection that takes the whole server down. Never throw here.
function parseBody(raw) { try { return JSON.parse(raw || '{}') || {}; } catch { return {}; } }

const server = http.createServer((req, res) => {
  // Any throw inside the handler must still produce a response — otherwise the
  // request hangs until the client times out.
  handle(req, res).catch((e) => {
    console.error('[chatweb]', e && e.message ? e.message : e);
    if (!res.headersSent) { res.writeHead(500); res.end('server error'); }
  });
});

async function handle(req, res) {
  const u = new URL(req.url, `http://${HOST}`);
  const p = u.pathname;

  // Reject foreign Host/Origin (anti DNS-rebinding / cross-origin). Applies to
  // everything: legit same-origin sub-resource GETs send no Origin, so they pass.
  if (!hostOk(req) || !originOk(req)) { res.writeHead(403); res.end('forbidden'); return; }

  // Public static libs (no secrets) — no token, so <script>/<link> load cleanly.
  if (p === '/assets/xterm.js') return sendFile(res, path.join(XTERM_DIR, 'lib', 'xterm.js'), true);
  if (p === '/assets/xterm.css') return sendFile(res, path.join(XTERM_DIR, 'css', 'xterm.css'), true);
  if (p === '/assets/addon-fit.js') return sendFile(res, path.join(FIT_DIR, 'lib', 'addon-fit.js'), true);
  if (p === '/assets/addon-search.js') return sendFile(res, path.join(SEARCH_DIR, 'lib', 'addon-search.js'), true);
  if (p === '/app.js') return sendFile(res, path.join(__dirname, 'public', 'app.js'));
  if (p === '/favicon.ico' || p === '/favicon.png') return sendFile(res, path.join(__dirname, 'public', 'favicon.png'));

  // Everything else is token-gated.
  if (u.searchParams.get('token') !== TOKEN) { res.writeHead(401); res.end('unauthorized'); return; }

  if (p === '/') {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');   // never leak the ?token= in a Referer
    res.setHeader('X-Frame-Options', 'DENY');
    return sendFile(res, path.join(__dirname, 'public', 'index.html'));
  }
  if (p === '/api/chats' && req.method === 'GET') return json(res, listChats());
  if (p === '/api/find' && req.method === 'GET') return json(res, searchChats(u.searchParams.get('q')));
  if (p === '/api/archive' && req.method === 'POST') {
    return json(res, moveChat(parseBody(await readBody(req)).name, true));
  }
  if (p === '/api/restore' && req.method === 'POST') {
    return json(res, moveChat(parseBody(await readBody(req)).name, false));
  }
  res.writeHead(404); res.end('not found');
}
// A handler that throws must not take the process down with it.
server.on('clientError', (e, sock) => { try { sock.destroy(); } catch {} });
process.on('unhandledRejection', (e) => console.error('[chatweb] unhandled:', e && e.message ? e.message : e));

// maxPayload caps an inbound frame; the base64 upload envelope is ~1.37x the file.
const wss = new WebSocketServer({ server, path: '/pty', maxPayload: Math.ceil(MAX_UPLOAD * 1.4) + (1 << 16) });
wss.on('connection', (ws, req) => {
  const u = new URL(req.url, `http://${HOST}`);
  if (!hostOk(req) || !originOk(req)) { ws.close(); return; }
  if (u.searchParams.get('token') !== TOKEN) { ws.close(); return; }
  const name = u.searchParams.get('name') || '';
  if (!NAME_RE.test(name)) { sendPty(ws, '\r\n\x1b[31m[invalid chat name]\x1b[0m\r\n'); ws.close(); return; }

  const cols = parseInt(u.searchParams.get('cols') || '100', 10);
  const rows = parseInt(u.searchParams.get('rows') || '30', 10);

  // Attach to the existing session (reconnect) or start a fresh one.
  let s = sessions.get(name);
  if (s && s.exited) { sessions.delete(name); s = null; }
  const reattach = !!s;
  if (!s) s = startSession(name, cols, rows);

  // Single viewer: a new socket takes over; kick any previous one (usually the
  // dead pre-drop socket, or another tab). The PTY keeps running throughout.
  if (s.ws && s.ws !== ws) { try { s.ws.close(); } catch {} }
  s.ws = ws;
  if (s.graceTimer) { clearTimeout(s.graceTimer); s.graceTimer = null; }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Repaint on reattach: replay the recent output, then resize to nudge the TUI
  // to redraw its current state cleanly.
  if (reattach && s.bufLen) sendPty(ws, s.buf.join(''));
  try { s.term.resize(cols, rows); s.cols = cols; s.rows = rows; } catch {}

  // Wrap in bracketed-paste markers (ESC[200~ … ESC[201~) so Claude treats it as a
  // pasted path — same as dragging into a real terminal. A raw write would look like
  // typed characters and not be detected as a path.
  const paste = (text) => { try { s.term.write('\x1b[200~' + text + '\x1b[201~'); } catch {} };

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'in') s.term.write(msg.data);
    else if (msg.type === 'resize') { try { s.term.resize(msg.cols, msg.rows); s.cols = msg.cols; s.rows = msg.rows; } catch {} }
    else if (msg.type === 'kill') { killSession(name); try { ws.close(); } catch {} }
    else if (msg.type === 'paste') { if (typeof msg.path === 'string') paste(shellEscape(msg.path)); }
    else if (msg.type === 'resolve') {
      // Try to name the real path of a dragged folder/file. On failure the client
      // falls back to uploading the bytes (files only — folders have no fallback).
      let paths = [];
      try { ({ paths } = await resolveDrop(msg)); } catch {}
      if (paths.length === 1) { paste(shellEscape(paths[0])); sendCtl(ws, { type: 'resolved', id: msg.id, path: paths[0] }); }
      else sendCtl(ws, { type: 'resolve-result', id: msg.id, kind: msg.kind, name: msg.name, paths });
    }
    else if (msg.type === 'file') {
      const fp = saveUpload(msg.name, msg.data);
      if (fp) paste(fp);
      else sendPty(ws, '\r\n\x1b[31m[upload rejected — empty or >20MB]\x1b[0m\r\n');
    }
  });

  // A dropped/closed socket only DETACHES — the session survives. It is reaped
  // only if DETACH_GRACE_MS > 0 and nobody reattaches within that window.
  ws.on('close', () => {
    if (s.ws !== ws) return;
    s.ws = null;
    if (!s.exited && DETACH_GRACE_MS > 0 && !s.graceTimer) {
      s.graceTimer = setTimeout(() => killSession(name), DETACH_GRACE_MS);
    }
  });
});

// Heartbeat: ping the attached socket every 25s; terminate a peer that missed the
// last pong (dead after sleep/blip). That just DETACHES — the session lives on and
// the browser reconnects. Also keeps the connection from being reaped while idle.
const heartbeat = setInterval(() => {
  for (const s of sessions.values()) {
    const ws = s.ws;
    if (!ws) continue;
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);
heartbeat.unref();

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  port ${PORT} is already in use — chatweb may already be running.`);
    console.error(`  stop it with:  chatweb-stop        (or use another port: CHATWEB_PORT=8791 chatweb)\n`);
    process.exit(1);
  }
  console.error('[chatweb]', e.message); process.exit(1);
});

server.listen(PORT, HOST, () => {
  pruneUploads();
  const url = `http://${HOST}:${PORT}/?token=${TOKEN}`;
  console.log('\n  claude-chats-web running (local only)\n');
  console.log('  ' + url + '\n');
  if (process.platform === 'darwin' && !process.env.CHATWEB_NO_OPEN) {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  }
});
