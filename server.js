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
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const HOME = process.env.HOME;
const CHATS_ROOT = path.join(HOME, 'claude-chats');
const ARCHIVE_ROOT = path.join(CHATS_ROOT, '.archive');
const PORT = parseInt(process.env.CHATWEB_PORT || '8790', 10);
const HOST = '127.0.0.1';
const TOKEN = process.env.CHATWEB_TOKEN || crypto.randomBytes(9).toString('base64url');
const SHELL = process.env.SHELL || '/bin/zsh';

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
const SKIP_DIRS = new Set(['.terraform', '.git', 'node_modules']);

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

function pushBuf(s, chunk) {
  s.buf.push(chunk); s.bufLen += chunk.length;
  while (s.bufLen > MAX_BUFFER && s.buf.length > 1) s.bufLen -= s.buf.shift().length;
}
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
  term.onData((d) => { pushBuf(s, d); if (s.ws && s.ws.readyState === 1) { try { s.ws.send(d); } catch {} } });
  term.onExit(() => {
    s.exited = true;
    if (s.ws && s.ws.readyState === 1) { try { s.ws.send('\r\n\x1b[90m[session ended]\x1b[0m\r\n'); } catch {} }
    sessions.delete(name);
  });
  return s;
}

const XTERM_DIR = path.dirname(require.resolve('@xterm/xterm/package.json'));
const FIT_DIR = path.dirname(require.resolve('@xterm/addon-fit/package.json'));

function listChats() {
  const out = [];
  for (const [root, archived] of [[CHATS_ROOT, false], [ARCHIVE_ROOT, true]]) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      let created = 0, updated = 0;
      try { const s = fs.statSync(dir); created = s.birthtimeMs || s.ctimeMs; updated = s.mtimeMs; } catch {}
      try { const n = fs.statSync(path.join(dir, 'NOTES.md')); if (n.mtimeMs > updated) updated = n.mtimeMs; } catch {}
      out.push({ name: e.name, archived, created, updated, live: !archived && isLive(e.name) });
    }
  }
  return out.sort((a, b) => b.updated - a.updated);
}

// Web equivalent of `chatfind`: multi-keyword AND search over *.md (minus CLAUDE.md).
// "github own" matches a chat whose notes contain BOTH "github" and "own" anywhere.
function searchChats(q) {
  const tokens = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const results = [];
  for (const [root, archived] of [[CHATS_ROOT, false], [ARCHIVE_ROOT, true]]) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const text = gatherMd(path.join(root, e.name));
      const lower = text.toLowerCase();
      if (tokens.every((t) => lower.includes(t))) {
        results.push({ name: e.name, archived, snippet: bestSnippet(text, tokens), live: !archived && isLive(e.name) });
      }
    }
  }
  return results;
}
// Concatenate all *.md (minus CLAUDE.md) in a chat dir.
function gatherMd(dir) {
  let out = '';
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(path.join(d, e.name)); continue; }
      if (e.isFile() && e.name.endsWith('.md') && e.name !== 'CLAUDE.md') {
        try { out += fs.readFileSync(path.join(d, e.name), 'utf8') + '\n'; } catch {}
      }
    }
  }
  return out;
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
  if (!NAME_RE.test(name)) return { ok: false, error: 'invalid name' };
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
function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': CT[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}
function json(res, obj, code = 200) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); }); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}`);
  const p = u.pathname;

  // Reject foreign Host/Origin (anti DNS-rebinding / cross-origin). Applies to
  // everything: legit same-origin sub-resource GETs send no Origin, so they pass.
  if (!hostOk(req) || !originOk(req)) { res.writeHead(403); res.end('forbidden'); return; }

  // Public static libs (no secrets) — no token, so <script>/<link> load cleanly.
  if (p === '/assets/xterm.js') return sendFile(res, path.join(XTERM_DIR, 'lib', 'xterm.js'));
  if (p === '/assets/xterm.css') return sendFile(res, path.join(XTERM_DIR, 'css', 'xterm.css'));
  if (p === '/assets/addon-fit.js') return sendFile(res, path.join(FIT_DIR, 'lib', 'addon-fit.js'));
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
    const b = JSON.parse((await readBody(req)) || '{}');
    return json(res, moveChat(b.name, true));
  }
  if (p === '/api/restore' && req.method === 'POST') {
    const b = JSON.parse((await readBody(req)) || '{}');
    return json(res, moveChat(b.name, false));
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/pty' });
wss.on('connection', (ws, req) => {
  const u = new URL(req.url, `http://${HOST}`);
  if (!hostOk(req) || !originOk(req)) { ws.close(); return; }
  if (u.searchParams.get('token') !== TOKEN) { ws.close(); return; }
  const name = u.searchParams.get('name') || '';
  if (!NAME_RE.test(name)) { ws.send('\r\n\x1b[31m[invalid chat name]\x1b[0m\r\n'); ws.close(); return; }

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
  if (reattach && s.bufLen) { try { ws.send(s.buf.join('')); } catch {} }
  try { s.term.resize(cols, rows); s.cols = cols; s.rows = rows; } catch {}

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'in') s.term.write(msg.data);
    else if (msg.type === 'resize') { try { s.term.resize(msg.cols, msg.rows); s.cols = msg.cols; s.rows = msg.rows; } catch {} }
    else if (msg.type === 'kill') { killSession(name); try { ws.close(); } catch {} }
    else if (msg.type === 'file') {
      const fp = saveUpload(msg.name, msg.data);
      // Wrap in bracketed-paste markers (ESC[200~ … ESC[201~) so Claude treats it as
      // a pasted path — same as dragging a file into a real terminal — and renders it
      // as [Image #N]. A raw write would look like typed chars and not be detected.
      if (fp) s.term.write('\x1b[200~' + fp + '\x1b[201~');
      else if (s.ws) { try { s.ws.send('\r\n\x1b[31m[upload rejected — empty or >20MB]\x1b[0m\r\n'); } catch {} }
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

server.listen(PORT, HOST, () => {
  pruneUploads();
  const url = `http://${HOST}:${PORT}/?token=${TOKEN}`;
  console.log('\n  claude-chats-web running (local only)\n');
  console.log('  ' + url + '\n');
  if (process.platform === 'darwin' && !process.env.CHATWEB_NO_OPEN) {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  }
});
