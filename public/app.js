'use strict';
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const $ = (id) => document.getElementById(id);

function api(p, opt) {
  const sep = p.includes('?') ? '&' : '?';
  return fetch(p + sep + 'token=' + encodeURIComponent(TOKEN), opt);
}

let sessions = [];      // {name, term, fit, ws, wrap}
let active = 'home';    // 'home' | <chat name>
let lastChats = [];     // last /api/chats result (for live checks)

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
    html += `<div class="tab ${active === s.name ? 'active' : ''}" data-tab="${esc(s.name)}">
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
  active = tab;
  if (tab === 'home') {
    $('home').style.display = 'block';
    $('terms').style.display = 'none';
    loadList();
  } else {
    $('home').style.display = 'none';
    $('terms').style.display = 'block';
    for (const s of sessions) s.wrap.style.display = s.name === tab ? 'block' : 'none';
    const s = sessions.find((x) => x.name === tab);
    if (s) setTimeout(() => { s.fit.fit(); sendResize(s); s.term.focus(); }, 30);
  }
  renderTabs();
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
  $('terms').appendChild(wrap);

  const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme: { background: '#000000', foreground: '#e6edf3' } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(wrap);

  const s = { name, term, fit, ws: null, wrap, closing: false, backoff: 1000 };
  sessions.push(s);

  // Register input handler ONCE per terminal (not per socket) so reconnects don't
  // stack duplicate listeners.
  term.onData((d) => { if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'in', data: d })); });

  // Drag-drop + clipboard-paste of images/files → sent to the server, which writes
  // a temp file and types its path in (like dragging into a real terminal).
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('dragover'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('dragover'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault(); wrap.classList.remove('dragover');
    for (const f of e.dataTransfer.files) sendFile(s, f);
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
  s.ws = ws;
  ws.onopen = () => { s.backoff = 1000; sendResize(s); s.term.focus(); };
  ws.onmessage = (e) => s.term.write(e.data);
  ws.onclose = () => {
    if (s.closing) return;                                  // user closed it on purpose
    s.term.write('\r\n\x1b[33m[reconnecting…]\x1b[0m\r\n');
    setTimeout(() => { if (!s.closing) connect(s); }, s.backoff);
    s.backoff = Math.min(s.backoff * 2, 5000);              // 1s→2s→4s→5s cap
  };
}

// Read a dropped/pasted file and ship its bytes (base64) over the socket.
function sendFile(s, file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { s.term.write('\r\n\x1b[31m[file too large (>20MB)]\x1b[0m\r\n'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const bytes = new Uint8Array(reader.result);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const data = btoa(bin);
    if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'file', name: file.name, mime: file.type, data }));
  };
  reader.readAsArrayBuffer(file);
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
  if (active === name) switchTo(sessions.length ? sessions[sessions.length - 1].name : 'home');
  else renderTabs();
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
window.addEventListener('resize', () => {
  const s = sessions.find((x) => x.name === active);
  if (s) { s.fit.fit(); sendResize(s); }
});

renderTabs();
loadList();
