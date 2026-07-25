'use strict';
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const $ = (id) => document.getElementById(id);

function api(p, opt) {
  const sep = p.includes('?') ? '&' : '?';
  return fetch(p + sep + 'token=' + encodeURIComponent(TOKEN), opt);
}

let sessions = [];      // {name, term, fit, search, ws, wrap}
let active = 'home';    // 'home' | <chat name> — the focused session
let lastChats = [];     // last /api/chats result (for live checks)
let layout = 1;         // 1–4 panes shown at once
let panes = [];         // session names currently on screen, in pane order
let focusIdx = 0;       // which pane a newly-opened chat replaces

// ---------- formatting ----------
function fmt(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function ago(ms) {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- tabs ----------
function renderTabs() {
  let html = `<div class="tab ${active === 'home' ? 'active' : ''}" data-tab="home">▸ chats</div>`;
  for (const s of sessions) {
    html += `<div class="tab ${active === s.name ? 'active' : ''} ${panes.includes(s.name) ? 'shown' : ''} ${s.attn ? 'attn' : ''}" data-tab="${esc(s.name)}">
      <span class="live"></span>${esc(s.name)}<span class="x" data-close="${esc(s.name)}">×</span></div>`;
  }
  const bar = $('tabbar');
  bar.innerHTML = html;
  bar.querySelectorAll('.tab').forEach((el) => {
    el.onclick = (e) => {
      const close = e.target.dataset.close;
      if (close) { e.stopPropagation(); closeSession(close); return; }
      switchTo(el.dataset.tab);
    };
  });
}

function switchTo(tab) {
  if (tab === 'home') {
    active = 'home';
    $('home').style.display = 'block';
    $('terms').className = '';
    renderTabs();
    loadList();
    return;
  }
  active = tab;
  $('home').style.display = 'none';
  // Bring the chosen session on screen: keep it where it is, take a free slot, or
  // replace whichever pane currently has focus.
  const at = panes.indexOf(tab);
  if (at >= 0) focusIdx = at;
  else if (panes.length < layout) { panes.push(tab); focusIdx = panes.length - 1; }
  else { focusIdx = Math.min(focusIdx, layout - 1); panes[focusIdx] = tab; }
  renderPanes();
  renderTabs();
  const s = sessions.find((x) => x.name === tab);
  if (s && s.attn) seen(s);
  saveWorkspace();
}

// Apply `layout` + `panes` to the DOM, then re-fit every visible terminal (each pane
// has its own cols/rows, so all of them need a resize sent to their PTY).
function renderPanes() {
  const terms = $('terms');
  panes = panes.filter((n) => sessions.some((s) => s.name === n)).slice(0, layout);
  for (const s of sessions) {
    if (panes.length >= layout) break;
    if (!panes.includes(s.name)) panes.push(s.name);
  }
  if (panes.length && !panes.includes(active)) active = panes[Math.min(focusIdx, panes.length - 1)];
  focusIdx = Math.max(0, panes.indexOf(active));

  terms.className = 'on split-' + layout;
  for (const s of sessions) {
    const i = panes.indexOf(s.name);
    s.wrap.classList.toggle('pane', i >= 0);
    s.wrap.classList.toggle('focused', s.name === active && panes.length > 1);
    s.wrap.classList.toggle('span2', layout === 3 && i === 2);
    if (i >= 0) s.wrap.style.order = i;
  }
  // Let the grid settle before measuring, or fit() reads stale box sizes.
  setTimeout(() => {
    for (const n of panes) {
      const s = sessions.find((x) => x.name === n);
      if (!s) continue;
      try { s.fit.fit(); } catch {}
      sendResize(s);
    }
    const f = sessions.find((x) => x.name === active);
    if (f) f.term.focus();
  }, 40);
}

function setLayout(n) {
  layout = Math.max(1, Math.min(4, n));
  document.querySelectorAll('#layout button').forEach((b) => b.classList.toggle('on', +b.dataset.l === layout));
  if (active !== 'home') { renderPanes(); renderTabs(); }
  saveWorkspace();
}

// ---------- sessions ----------
function sendResize(s) { if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'resize', cols: s.term.cols, rows: s.term.rows })); }

function openChat(name) {
  if (sessions.find((s) => s.name === name)) { switchTo(name); return; }
  createSession(name);   // server reattaches if a session with this name is already running
}

function createSession(name) {
  const wrap = document.createElement('div');
  wrap.className = 'termwrap';
  const tag = document.createElement('div');
  tag.className = 'pane-tag';
  tag.textContent = name;
  wrap.appendChild(tag);
  $('terms').appendChild(wrap);
  // Clicking a pane focuses it, so the next tab you open replaces THAT pane.
  wrap.addEventListener('mousedown', () => {
    const me = sessions.find((x) => x.name === name);
    if (me && me.attn) seen(me);              // looking at it clears the indicator
    if (active === name) return;
    active = name;
    focusIdx = Math.max(0, panes.indexOf(name));
    for (const x of sessions) x.wrap.classList.toggle('focused', x.name === name && panes.length > 1);
    renderTabs();
    saveWorkspace();
  });

  const term = new Terminal({
    cursorBlink: true, fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    theme: { background: '#000000', foreground: '#e6edf3' },
    scrollback: 10000,
    allowProposedApi: true,     // required for search-match decorations
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.open(wrap);

  const s = { name, term, fit, search, ws: null, wrap, closing: false, backoff: 1000, pending: new Map(), attn: false };
  sessions.push(s);
  attachFind(s);

  // Register input handler ONCE per terminal (not per socket) so reconnects don't
  // stack duplicate listeners.
  term.onData((d) => { if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'in', data: d })); });

  // Drag-drop + clipboard-paste of images/files → sent to the server, which writes
  // a temp file and types its path in (like dragging into a real terminal).
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('dragover'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('dragover'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault(); wrap.classList.remove('dragover');
    // DataTransfer is neutered the moment this handler returns, so read every item
    // synchronously first, then do the async work.
    const items = [];
    for (const it of e.dataTransfer.items || []) {
      if (it.kind !== 'file') continue;
      items.push({ entry: it.webkitGetAsEntry ? it.webkitGetAsEntry() : null, file: it.getAsFile() });
    }
    if (!items.length) { for (const f of e.dataTransfer.files) sendFile(s, f); return; }
    for (const it of items) handleDrop(s, it);
  });
  wrap.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let handled = false;
    for (const it of items) { if (it.kind === 'file') { const f = it.getAsFile(); if (f) { sendFile(s, f); handled = true; } } }
    if (handled) e.preventDefault();   // else let xterm handle normal text paste
  });

  switchTo(name);           // makes wrap visible so fit() measures correctly
  fit.fit();
  connect(s);
}

// (Re)connect a session's WebSocket. Safe to call repeatedly — reused on drops.
function connect(s) {
  s.term.reset();           // clear before the server replays the current screen
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = `token=${encodeURIComponent(TOKEN)}&name=${encodeURIComponent(s.name)}&cols=${s.term.cols}&rows=${s.term.rows}`;
  const ws = new WebSocket(`${proto}://${location.host}/pty?${q}`);
  ws.binaryType = 'arraybuffer';
  s.ws = ws;
  ws.onopen = () => { s.backoff = 1000; sendResize(s); s.term.focus(); };
  // Binary frames are terminal bytes; text frames are JSON control messages.
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') { s.term.write(new Uint8Array(e.data)); return; }
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'resolve-result') onResolveResult(s, msg);
    else if (msg.type === 'resolved') s.pending.delete(msg.id);
    else if (msg.type === 'attn') onAttention(s, msg.reason);
    else if (msg.type === 'attn-clear') setAttn(s, false);
  };
  ws.onclose = () => {
    if (s.closing) return;                                  // user closed it on purpose
    s.term.write('\r\n\x1b[33m[reconnecting…]\x1b[0m\r\n');
    setTimeout(() => { if (!s.closing) connect(s); }, s.backoff);
    s.backoff = Math.min(s.backoff * 2, 5000);              // 1s→2s→4s→5s cap
  };
}

// Read a dropped/pasted file and ship its bytes (base64) over the socket. Used only
// as a fallback now — a real path beats a temp copy, since Claude then reads the file
// live instead of a snapshot.
function sendFile(s, file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { s.term.write('\r\n\x1b[31m[file too large (>20MB)]\x1b[0m\r\n'); return; }
  const reader = new FileReader();
  reader.onerror = () => s.term.write(`\r\n\x1b[31m[could not read ${file.name || 'file'}]\x1b[0m\r\n`);
  reader.onload = () => {
    const bytes = new Uint8Array(reader.result);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const data = btoa(bin);
    if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'file', name: file.name, mime: file.type, data }));
  };
  reader.readAsArrayBuffer(file);
}

// ---------- dropped folder/file → real path ----------
// The browser refuses to tell us a dragged item's true path. So we send what it DOES
// expose — name plus a signature (child names for a folder, size+mtime for a file) —
// and the local server finds the matching path on disk.
let dropId = 0;

function readDirNames(entry, max = 40) {
  return new Promise((resolve) => {
    const names = [];
    let reader;
    try { reader = entry.createReader(); } catch { return resolve(names); }
    const next = () => reader.readEntries((ents) => {
      if (!ents.length || names.length >= max) return resolve(names);
      for (const e of ents) names.push(e.name);
      next();
    }, () => resolve(names));
    next();
  });
}

async function handleDrop(s, it) {
  const { entry, file } = it;
  if (entry && entry.isDirectory) {
    const children = await readDirNames(entry);
    askResolve(s, { kind: 'dir', name: entry.name, children }, null);
  } else if (file) {
    askResolve(s, { kind: 'file', name: file.name, size: file.size, mtime: file.lastModified }, file);
  }
}

function askResolve(s, desc, fallbackFile) {
  if (!s.ws || s.ws.readyState !== 1) return;
  const id = ++dropId;
  s.pending.set(id, { desc, file: fallbackFile });
  s.ws.send(JSON.stringify({ type: 'resolve', id, ...desc }));
}

function onResolveResult(s, msg) {
  const p = s.pending.get(msg.id);
  s.pending.delete(msg.id);
  if (!msg.paths || !msg.paths.length) {
    // No match. A file can still be uploaded by value; a folder cannot.
    if (p && p.file) { sendFile(s, p.file); return; }
    s.term.write(`\r\n\x1b[31m[couldn't locate "${msg.name}" on disk — type the path instead]\x1b[0m\r\n`);
    return;
  }
  showPathChoices(s, msg.paths);
}

// More than one path matched the signature — let the user say which.
function showPathChoices(s, paths) {
  const old = s.wrap.querySelector('.pathpick');
  if (old) old.remove();
  const box = document.createElement('div');
  box.className = 'pathpick';
  box.innerHTML = `<div class="pathpick-h">${paths.length} matches — pick one:</div>` +
    paths.map((p) => `<button class="pathpick-b" data-p="${esc(p)}">${esc(p)}</button>`).join('') +
    `<button class="pathpick-x">cancel</button>`;
  s.wrap.appendChild(box);
  box.querySelectorAll('.pathpick-b').forEach((b) => (b.onclick = () => {
    if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'paste', path: b.dataset.p }));
    box.remove(); s.term.focus();
  }));
  box.querySelector('.pathpick-x').onclick = () => { box.remove(); s.term.focus(); };
}

function closeSession(name) {
  const i = sessions.findIndex((s) => s.name === name);
  if (i < 0) return;
  const s = sessions[i];
  s.closing = true;                                         // stop auto-reconnect
  try { if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'kill' })); } catch {}
  try { s.ws && s.ws.close(); } catch {}
  try { s.term.dispose(); } catch {}
  s.wrap.remove();
  sessions.splice(i, 1);
  panes = panes.filter((n) => n !== name);
  if (!sessions.length) { panes = []; switchTo('home'); return; }
  if (active === name) active = panes[0] || sessions[sessions.length - 1].name;
  renderPanes();
  renderTabs();
  saveWorkspace();
}

// ---------- "wants your attention" ----------
// The server tells us a session is waiting (bell, or output that stopped while you
// haven't typed). If you're already looking at that pane it isn't news — we ack it
// instead, so the indicator only ever means "somewhere you're NOT looking".
function watching(s) {
  return !document.hidden && active === s.name && panes.includes(s.name);
}
function setAttn(s, on) {
  if (s.attn === on) return;
  s.attn = on;
  renderTabs();
  s.wrap.classList.toggle('wants', on);
}
function onAttention(s, reason) {
  if (watching(s)) { seen(s); return; }
  setAttn(s, true);
  chime();
  notify(s, reason);
}

// Two-note chime, synthesised rather than shipped as an audio file — no asset, no
// extra request, nothing for the CSP to allow. Off by default; the header toggles it.
let audioCtx = null;
function chime() {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    [[880, 0], [1320, 0.11]].forEach(([freq, at]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // Quick fade in/out — a raw square edge clicks.
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.16, now + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.18);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.2);
    });
  } catch {}
}
let soundOn = false;
// `preview` is true only for a real click — that gesture is what unlocks audio in the
// browser, and it confirms the choice. Restoring the saved setting must stay silent.
function setSound(on, preview = false) {
  soundOn = on;
  const b = $('sound');
  if (b) { b.classList.toggle('on', on); b.textContent = on ? '🔔' : '🔕'; b.title = on ? 'sound on' : 'sound off'; }
  try { localStorage.setItem('chatweb:sound', on ? '1' : '0'); } catch {}
  if (on && preview) { enableNotifications(); chime(); }
}
function seen(s) {
  if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'seen' }));
  setAttn(s, false);
}

// Desktop notification, only while the tab is in the background — a banner for a
// window you're already staring at is noise. Permission is asked once, on first use.
let notifyOk = false;
function notify(s, reason) {
  if (!notifyOk || !document.hidden || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(`${s.name} is waiting`, {
      body: reason === 'bell' ? 'The session rang for attention.' : 'Output stopped — it looks done.',
      tag: 'chatweb-' + s.name,        // one live banner per session, not a pile
    });
    n.onclick = () => { window.focus(); switchTo(s.name); n.close(); };
  } catch {}
}
function enableNotifications() {
  if (!('Notification' in window)) return;
  notifyOk = true;
  if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

// ---------- workspace persistence ----------
// Remember which chats were open and the pane layout. Only sessions the server still
// reports as live get reopened — otherwise a refresh would silently spawn fresh Claude
// processes for chats that had already exited.
const STORE_KEY = 'chatweb:workspace';
function saveWorkspace() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      layout, panes, active, tabs: sessions.map((s) => s.name),
    }));
  } catch {}
}
async function restoreWorkspace() {
  let w;
  try { w = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return; }
  if (!w || !Array.isArray(w.tabs) || !w.tabs.length) return;
  if (w.layout) setLayout(w.layout);
  const live = new Set(lastChats.filter((c) => c.live).map((c) => c.name));
  const revive = w.tabs.filter((n) => live.has(n));
  if (!revive.length) return;
  for (const n of revive) if (!sessions.find((s) => s.name === n)) createSession(n);
  panes = (w.panes || []).filter((n) => revive.includes(n));
  if (revive.includes(w.active)) active = w.active;
  renderPanes();
  renderTabs();
}

// ---------- keyboard shortcuts ----------
// Capture phase so these win before xterm consumes the keystroke. Cmd on macOS,
// Ctrl elsewhere — the terminal itself never uses those, so nothing is shadowed.
// (Cmd-W is deliberately absent: browsers don't let a page override closing the tab.)
function onShortcut(e) {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return;
  if (e.key >= '1' && e.key <= '4' && !e.shiftKey) { e.preventDefault(); setLayout(+e.key); return; }
  if (e.key === '0') { e.preventDefault(); switchTo('home'); return; }
  if (e.shiftKey && (e.key === '[' || e.key === ']' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    if (panes.length < 2) return;
    const dir = (e.key === ']' || e.key === 'ArrowRight') ? 1 : -1;
    const i = (panes.indexOf(active) + dir + panes.length) % panes.length;
    switchTo(panes[i]);
  }
}

// ---------- in-terminal find (Cmd/Ctrl-F) ----------
// Browser find can't see terminal output, so we drive the xterm search addon instead:
// highlights every match in the viewport and steps through them. The fill colour is
// applied in CSS (see .xterm-find-result-decoration) because the DOM renderer honours
// only the outline from these options.
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const DECO = {
  matchBackground: '#5c5324', matchBorder: '#8a7b2e', matchOverviewRuler: '#d4c05a',
  activeMatchBackground: '#d97757', activeMatchBorder: '#ffab8f', activeMatchColorOverviewRuler: '#d97757',
};

function attachFind(s) {
  const bar = document.createElement('div');
  bar.className = 'findbar';
  bar.innerHTML = `
    <input class="find-q" placeholder="find in session" autocomplete="off" spellcheck="false" />
    <span class="find-n">0/0</span>
    <button class="find-b" data-d="prev" title="previous (Shift-Enter)">↑</button>
    <button class="find-b" data-d="next" title="next (Enter)">↓</button>
    <button class="find-b find-case" title="match case">Aa</button>
    <button class="find-b" data-d="close" title="close (Esc)">×</button>`;
  s.wrap.appendChild(bar);

  const q = bar.querySelector('.find-q');
  const counter = bar.querySelector('.find-n');
  const caseBtn = bar.querySelector('.find-case');
  let caseSensitive = false;
  s.findBar = bar;

  const opts = (incremental) => ({ decorations: DECO, caseSensitive, incremental });
  const run = (dir, incremental) => {
    const v = q.value;
    if (!v) { s.search.clearDecorations(); counter.textContent = '0/0'; return; }
    if (dir === 'prev') s.search.findPrevious(v, opts(false));
    else s.search.findNext(v, opts(incremental));
  };

  s.search.onDidChangeResults((r) => {
    if (!r || r.resultCount === 0) { counter.textContent = '0/0'; counter.classList.add('none'); return; }
    counter.classList.remove('none');
    counter.textContent = `${r.resultIndex >= 0 ? r.resultIndex + 1 : 0}/${r.resultCount}`;
  });

  q.addEventListener('input', () => run('next', true));
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(e.shiftKey ? 'prev' : 'next', false); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(s); }
  });
  bar.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => {
    const d = b.dataset.d;
    if (d === 'close') closeFind(s); else { run(d, false); q.focus(); }
  }));
  caseBtn.onclick = () => { caseSensitive = !caseSensitive; caseBtn.classList.toggle('on', caseSensitive); run('next', true); q.focus(); };

  // Intercept before xterm swallows the key. On macOS we bind Cmd-F, not Ctrl-F,
  // because Ctrl-F is forward-char in the prompt's readline and overriding it would
  // break cursor movement. Ctrl-Shift-F works everywhere as a fallback.
  s.term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const f = e.key === 'f' || e.key === 'F';
    const primary = (IS_MAC ? e.metaKey : e.ctrlKey) && !e.altKey;
    const fallback = e.ctrlKey && e.shiftKey;
    if (f && (primary || fallback)) { e.preventDefault(); openFind(s); return false; }
    if (e.key === 'Escape' && bar.classList.contains('open')) { closeFind(s); return false; }
    return true;
  });
}

function openFind(s) {
  s.findBar.classList.add('open');
  const q = s.findBar.querySelector('.find-q');
  const sel = s.term.getSelection();
  if (sel && !sel.includes('\n')) q.value = sel;
  q.focus(); q.select();
  if (q.value) s.search.findNext(q.value, { decorations: DECO, incremental: true });
}
function closeFind(s) {
  s.findBar.classList.remove('open');
  try { s.search.clearDecorations(); } catch {}
  s.term.focus();
}

// ---------- home list + search ----------
async function loadList() {
  const res = await api('/api/chats');
  if (!res.ok) { $('rows').innerHTML = `<div class="empty">failed to load (${res.status})</div>`; return; }
  lastChats = await res.json();
  renderRows(lastChats, false);
}

async function doSearch(q) {
  const res = await api('/api/find?q=' + encodeURIComponent(q));
  const results = res.ok ? await res.json() : [];
  if (!results.length) { $('rows').innerHTML = `<div class="empty">no chats mention: ${esc(q)}</div>`; return; }
  renderRows(results, true);
}

function renderRows(items, isSearch) {
  const active_ = items.filter((c) => !c.archived);
  const archived = items.filter((c) => c.archived);
  let html = '';
  const block = (arr, label) => {
    if (!arr.length) return;
    html += `<div class="section-label">${label}</div>`;
    for (const c of arr) html += row(c, isSearch);
  };
  if (isSearch) {
    for (const c of items) html += row(c, true);
  } else {
    if (!active_.length && !archived.length) { html = `<div class="empty">No chats yet — start one above.</div>`; }
    block(active_, 'active');
    block(archived, 'archived');
  }
  $('rows').innerHTML = html;

  $('rows').querySelectorAll('[data-open]').forEach((el) => (el.onclick = () => openChat(el.dataset.open)));
  $('rows').querySelectorAll('[data-archive]').forEach((el) => (el.onclick = () => archiveChat(el.dataset.archive)));
  $('rows').querySelectorAll('[data-restore]').forEach((el) => (el.onclick = () => restoreChat(el.dataset.restore)));
}

function row(c, isSearch) {
  const mid = isSearch
    ? `<span class="snippet" title="${esc(c.snippet || '')}">${esc(c.snippet || '')}</span>`
    : `<span class="grow"></span><span class="meta"><span class="rel">${ago(c.updated)}</span><span class="abs">${fmt(c.updated)}</span></span>`;
  const secondary = c.archived
    ? `<button class="act" data-restore="${esc(c.name)}">restore</button>`
    : `<button class="act" data-archive="${esc(c.name)}">archive</button>`;
  return `
    <div class="chat">
      <span class="arrow" data-open="${esc(c.name)}">▸</span>
      ${c.live ? '<span class="live" title="running"></span>' : ''}
      <span class="name" data-open="${esc(c.name)}">${esc(c.name)}</span>
      ${c.archived ? '<span class="badge">archived</span>' : ''}
      ${mid}
      <span class="actions"><button class="act" data-open="${esc(c.name)}">open</button>${secondary}</span>
    </div>`;
}

async function archiveChat(name) {
  if (sessions.find((s) => s.name === name)) { alert(`Close the running "${name}" session (× on its tab) before archiving.`); return; }
  const res = await api('/api/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  const r = await res.json();
  if (!r.ok) alert('Archive failed: ' + r.error);
  refreshHome();
}
async function restoreChat(name) {
  const res = await api('/api/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  const r = await res.json();
  if (!r.ok) alert('Restore failed: ' + r.error);
  refreshHome();
}

function refreshHome() {
  const q = $('q').value.trim();
  if (q) doSearch(q); else loadList();
}

// ---------- wiring ----------
function startNew() {
  const v = ($('newname').value || '').trim();
  if (!NAME_RE.test(v)) { alert('Name must be letters/numbers/-/_/. and start alphanumeric.'); return; }
  $('newname').value = '';
  openChat(v);
}

$('newbtn').onclick = startNew;
$('newname').addEventListener('keydown', (e) => { if (e.key === 'Enter') startNew(); });

let searchTimer = null;
$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('q').value.trim();
  searchTimer = setTimeout(() => { if (q) doSearch(q); else loadList(); }, 200);
});

$('refresh').onclick = () => { if (active === 'home') refreshHome(); };

document.querySelectorAll('#layout button').forEach((b) => (b.onclick = () => setLayout(+b.dataset.l)));

// Every visible pane needs re-fitting, not just the focused one. Debounced so a
// drag-resize doesn't spam the PTYs with resize messages.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const n of panes) {
      const s = sessions.find((x) => x.name === n);
      if (!s) continue;
      try { s.fit.fit(); } catch {}
      sendResize(s);
    }
  }, 80);
});

document.addEventListener('keydown', onShortcut, true);   // capture: beat xterm to it
$('sound').onclick = () => setSound(!soundOn, true);
// Coming back to the tab means you're looking again — clear the focused pane's flag.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const s = sessions.find((x) => x.name === active);
  if (s && s.attn) seen(s);
});

renderTabs();
try { setSound(localStorage.getItem('chatweb:sound') === '1'); } catch {}
// Load the chat list first — restore needs to know which sessions are still live.
loadList().then(restoreWorkspace);
