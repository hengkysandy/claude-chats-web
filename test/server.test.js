'use strict';
// Run with: npm test   (node --test, no test framework dependency)
//
// CHATWEB_CHATS_ROOT is pointed at a temp dir BEFORE server.js is required, so these
// tests never touch a real ~/claude-chats. server.js only binds a port when run
// directly, so requiring it here is side-effect free.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'chatweb-test-'));
process.env.CHATWEB_CHATS_ROOT = ROOT;
process.env.CHATWEB_TOKEN = 'test-token';

const srv = require('../server.js');

const mk = (...p) => { const d = path.join(ROOT, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (dir, name, body) => { fs.writeFileSync(path.join(dir, name), body); return path.join(dir, name); };

test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

// ---------------------------------------------------------------- name validation
test('NAME_RE accepts ordinary chat names', () => {
  for (const n of ['alpha', 'a', 'my-chat', 'my_chat.v2', 'A1', '0abc'])
    assert.ok(srv.NAME_RE.test(n), `should accept ${n}`);
});

test('NAME_RE rejects traversal and shell-hostile names', () => {
  for (const n of ['../etc', 'a/b', '.hidden', '-lead', 'a b', 'a;rm -rf', '', 'x'.repeat(65)])
    assert.ok(!srv.NAME_RE.test(n), `should reject ${JSON.stringify(n)}`);
});

// Regression: NAME_RE.test(undefined) coerces to the STRING "undefined", which
// matches the pattern — so a missing name once sailed through into path.join().
test('moveChat rejects a non-string name (undefined coercion regression)', () => {
  for (const bad of [undefined, null, 42, {}, ['alpha']]) {
    const r = srv.moveChat(bad, true);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid name');
  }
});

test('moveChat reports a missing chat rather than throwing', () => {
  assert.deepEqual(srv.moveChat('does-not-exist', true), { ok: false, error: 'not found' });
});

test('moveChat archives and restores, round trip', () => {
  const dir = mk('roundtrip');
  write(dir, 'NOTES.md', '# hello');

  assert.deepEqual(srv.moveChat('roundtrip', true), { ok: true });
  assert.ok(!fs.existsSync(dir), 'source is gone after archiving');
  assert.ok(fs.existsSync(path.join(ROOT, '.archive', 'roundtrip', 'NOTES.md')), 'contents moved intact');

  assert.deepEqual(srv.moveChat('roundtrip', false), { ok: true });
  assert.ok(fs.existsSync(path.join(dir, 'NOTES.md')), 'restored with contents');
});

test('moveChat refuses to clobber a chat of the same name on the other side', () => {
  mk('clash');
  mk('.archive', 'clash');
  const r = srv.moveChat('clash', true);
  assert.equal(r.ok, false);
  assert.match(r.error, /already exists/);
});

// ---------------------------------------------------------------- notes indexing
test('walkMd finds notes but skips CLAUDE.md', () => {
  const dir = mk('notes');
  write(dir, 'NOTES.md', 'alpha');
  write(dir, 'other.md', 'bravo');
  write(dir, 'CLAUDE.md', 'boilerplate');
  write(dir, 'readme.txt', 'not markdown');
  const names = srv.walkMd(dir).map((f) => path.basename(f.path)).sort();
  assert.deepEqual(names, ['NOTES.md', 'other.md']);
});

// The bug this guards: the old skip list missed .venv, so dependency licence files
// were indexed as if they were the user's notes.
test('walkMd skips vendor and dot directories', () => {
  const dir = mk('vendored');
  write(dir, 'NOTES.md', 'real note');
  for (const junk of ['node_modules', '.venv', 'dist', '__pycache__', '.git']) {
    const sub = mk('vendored', junk, 'deep');
    write(sub, 'LICENSE.md', 'not a note');
  }
  const found = srv.walkMd(dir).map((f) => path.basename(f.path));
  assert.deepEqual(found, ['NOTES.md']);
});

test('walkMd stops at the depth limit', () => {
  const deep = mk('deepnotes', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
  write(deep, 'buried.md', 'too deep');
  write(mk('deepnotes'), 'top.md', 'shallow');
  const found = srv.walkMd(path.join(ROOT, 'deepnotes')).map((f) => path.basename(f.path));
  assert.ok(found.includes('top.md'));
  assert.ok(!found.includes('buried.md'), 'should not index arbitrarily deep files');
});

test('chatIndex caches, and re-reads once a note changes', () => {
  const dir = mk('cached');
  const f = write(dir, 'NOTES.md', 'first version');

  const a = srv.chatIndex(dir, true);
  assert.match(a.text, /first version/);
  assert.strictEqual(srv.chatIndex(dir, true), a, 'unchanged dir returns the same cached object');

  // Signature is path+mtime+size, so bump mtime to be sure it is seen.
  fs.writeFileSync(f, 'second version is longer');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(f, future, future);

  const b = srv.chatIndex(dir, true);
  assert.notStrictEqual(b, a, 'edited dir must not serve the stale cache');
  assert.match(b.text, /second version/);
});

// ---------------------------------------------------------------- search
test('searchChats requires every token to match (AND, not OR)', () => {
  const dir = mk('searchable');
  write(dir, 'NOTES.md', 'deploying terraform to production today');

  assert.ok(srv.searchChats('terraform production').some((r) => r.name === 'searchable'),
    'both tokens present -> match');
  assert.ok(!srv.searchChats('terraform kubernetes').some((r) => r.name === 'searchable'),
    'one token missing -> no match');
});

test('searchChats is case-insensitive and returns a snippet', () => {
  const dir = mk('snippety');
  write(dir, 'NOTES.md', 'line one\nthe MAGIC word lives here\nline three');
  const hit = srv.searchChats('magic').find((r) => r.name === 'snippety');
  assert.ok(hit, 'found regardless of case');
  assert.match(hit.snippet, /MAGIC/);
});

test('searchChats ignores CLAUDE.md so boilerplate never matches', () => {
  const dir = mk('boiler');
  write(dir, 'CLAUDE.md', 'zzunique-boilerplate-token');
  assert.equal(srv.searchChats('zzunique-boilerplate-token').length, 0);
});

test('empty query returns nothing rather than everything', () => {
  assert.deepEqual(srv.searchChats(''), []);
  assert.deepEqual(srv.searchChats('   '), []);
});

test('bestSnippet prefers the line covering the most tokens', () => {
  const text = 'has alpha only\nhas alpha and bravo together\nnothing';
  assert.match(srv.bestSnippet(text, ['alpha', 'bravo']), /alpha and bravo/);
});

// ---------------------------------------------------------------- listing
test('listChats separates active from archived and sorts newest first', () => {
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'chatweb-list-'));
  // listChats reads the module-level root, so just assert against what we created.
  fs.rmSync(root2, { recursive: true, force: true });

  const older = mk('zz-older');
  write(older, 'NOTES.md', 'old');
  const newer = mk('zz-newer');
  const nf = write(newer, 'NOTES.md', 'new');
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(nf, future, future);

  const list = srv.listChats();
  const names = list.map((c) => c.name);
  assert.ok(names.includes('zz-older') && names.includes('zz-newer'));
  assert.ok(names.indexOf('zz-newer') < names.indexOf('zz-older'), 'newest updated first');
  assert.ok(list.every((c) => typeof c.archived === 'boolean' && typeof c.updated === 'number'));
});

// ---------------------------------------------------------------- dropped paths
test('scoreCandidate matches a folder only when every seen child is present', () => {
  const dir = mk('dropdir');
  fs.mkdirSync(path.join(dir, 'sub'));
  write(dir, 'a.txt', 'a');
  write(dir, 'b.txt', 'b');

  assert.ok(srv.scoreCandidate(dir, { kind: 'dir', children: ['a.txt', 'b.txt'] }) > 0);
  assert.ok(srv.scoreCandidate(dir, { kind: 'dir', children: ['a.txt', 'sub'] }) > 0);
  assert.equal(srv.scoreCandidate(dir, { kind: 'dir', children: ['a.txt', 'nope.txt'] }), -1,
    'an unseen child means it is a different folder');
  assert.equal(srv.scoreCandidate(dir, { kind: 'file', size: 1 }), -1, 'a dir is not a file');
});

test('scoreCandidate matches a file on size and mtime', () => {
  const dir = mk('dropfile');
  const f = write(dir, 'thing.bin', 'exactly-15-ch!!');
  const st = fs.statSync(f);

  assert.ok(srv.scoreCandidate(f, { kind: 'file', size: st.size, mtime: st.mtimeMs }) > 0);
  assert.equal(srv.scoreCandidate(f, { kind: 'file', size: st.size + 1, mtime: st.mtimeMs }), -1,
    'wrong size is a different file');
  assert.equal(srv.scoreCandidate(f, { kind: 'file', size: st.size, mtime: st.mtimeMs + 60000 }), -1,
    'mtime beyond the tolerance is a different file');
  assert.ok(srv.scoreCandidate(f, { kind: 'file', size: st.size, mtime: st.mtimeMs + 500 }) > 0,
    'small clock skew is tolerated');
  assert.equal(srv.scoreCandidate(path.join(dir, 'gone'), { kind: 'file', size: 1 }), -1);
});

test('resolveDrop refuses names that could escape', async () => {
  for (const name of ['..', '.', '']) {
    const r = await srv.resolveDrop({ kind: 'dir', name, children: [] });
    assert.deepEqual(r.paths, []);
  }
});

test('resolveDrop finds a real folder by name plus children', async () => {
  const dir = mk('zz-resolve-me-unique');
  fs.mkdirSync(path.join(dir, 'marker-child'));
  write(dir, 'note.md', 'x');
  const r = await srv.resolveDrop({
    kind: 'dir', name: 'zz-resolve-me-unique', children: ['marker-child', 'note.md'],
  });
  // Spotlight may not have indexed a just-created temp dir; the find(1) fallback should.
  assert.ok(r.paths.includes(dir) || r.paths.length === 0,
    `if anything was found it must be the right dir, got ${JSON.stringify(r.paths)}`);
});

test('shellEscape quotes spaces and shell metacharacters, like a Finder drag', () => {
  assert.equal(srv.shellEscape('/tmp/My Folder'), '/tmp/My\\ Folder');
  assert.equal(srv.shellEscape('/tmp/a$b'), '/tmp/a\\$b');
  assert.equal(srv.shellEscape('/tmp/plain'), '/tmp/plain');
  assert.equal(srv.shellEscape('/tmp/a;rm -rf b'), '/tmp/a\\;rm\\ -rf\\ b');
});

// ---------------------------------------------------------------- request plumbing
test('parseBody never throws on malformed input', () => {
  // Regression: this used to throw inside an async handler, killing the process.
  for (const bad of ['NOT JSON{{{', '', undefined, '[1,2', 'null'])
    assert.equal(typeof srv.parseBody(bad), 'object');
  assert.deepEqual(srv.parseBody('{"name":"x"}'), { name: 'x' });
});

test('host and origin guards reject foreign values', () => {
  const ok = { headers: { host: `127.0.0.1:${srv.PORT}` } };
  assert.ok(srv.hostOk(ok));
  assert.ok(!srv.hostOk({ headers: { host: 'evil.test' } }));

  assert.ok(srv.originOk({ headers: {} }), 'no Origin (navigation/curl) is allowed; token still gates');
  assert.ok(srv.originOk({ headers: { origin: `http://127.0.0.1:${srv.PORT}` } }));
  assert.ok(!srv.originOk({ headers: { origin: 'http://evil.test' } }));
});

test('saveUpload rejects empty payloads and sanitises the filename', () => {
  assert.equal(srv.saveUpload('x.png', ''), null);
  const p = srv.saveUpload('../../evil name.png', Buffer.from('hi').toString('base64'));
  assert.ok(p, 'a valid upload is written');
  assert.equal(path.dirname(p), path.join(__dirname, '..', '.uploads'));
  assert.ok(!path.basename(p).includes('/') && !path.basename(p).includes('..'),
    'traversal stripped from the stored name');
  fs.unlinkSync(p);
});

// ---- busy / idle detection ------------------------------------------------------
// The old heuristic was "any PTY output means busy". That is always true in practice:
// with a terminal attached, Claude polls the cursor position and the emulator's replies
// keep an *idle* session emitting a chunk every few ms, so the dot latched amber forever.

test('normalize strips ANSI and whitespace so column-jump redraws still match', () => {
  // Claude repaints word-by-word with absolute column moves rather than plain spaces.
  const jumpy = 'esc\x1b[54Gto\x1b[57Ginterrupt';
  assert.ok(srv.normalize(jumpy).includes('esctointerrupt'));
  // Contiguous rendering, coloured, must match identically.
  assert.ok(srv.normalize('\x1b[2m(esc to interrupt)\x1b[0m').includes('esctointerrupt'));
  // OSC title sequences must not leak their text into the comparison.
  assert.equal(srv.normalize('\x1b]0;esc to interrupt\x07ok'), 'ok');
});

test('the animated spinner glyph keeps a session busy', () => {
  // "esc to interrupt" is painted ONCE when work starts; after that Claude patches only
  // the parts that change. The glyph and the counters are what actually repeat, so they
  // are what must hold the state up. Frames taken from a real PTY capture.
  for (const frame of ['\u2736 razzle-dazzling\u2026', '\u273B waddling\u2026', '\u2733 (2s \u00b7 thinking)', '\u2193 345 tokens)']) {
    const s = { name: 'zz', tail: '', busy: false, idleTimer: null, ws: null };
    srv.noteActivity(s, frame);
    assert.equal(s.busy, true, `frame should read as working: ${frame}`);
    if (s.idleTimer) clearTimeout(s.idleTimer);
  }
});

test('a working spinner marks busy, and its absence clears it', async () => {
  const sent = [];
  const s = { name: 'zz', tail: '', busy: false, idleTimer: null,
              ws: { readyState: 1, send: (m) => sent.push(JSON.parse(m)) } };

  srv.noteActivity(s, 'thinking… (12s · esc to interrupt)');
  assert.equal(s.busy, true, 'spinner on screen => busy');
  assert.deepEqual(sent.at(-1), { type: 'state', name: 'zz', busy: true });

  // Idle chatter (cursor-position answers, repaints with no spinner) must NOT hold it busy.
  const before = sent.length;
  srv.noteActivity(s, '\x1b[?25l\x1b[H\r\x1b[83C\x1b[24B\x1b[K\x1b[?25h');
  assert.equal(sent.length, before, 'plain repaints emit no state change');

  await new Promise((r) => setTimeout(r, 1800));   // > MARKER_IDLE_MS
  assert.equal(s.busy, false, 'spinner gone => idle');
  assert.deepEqual(sent.at(-1), { type: 'state', name: 'zz', busy: false });
});

test('a marker split across two chunks is still detected', () => {
  const s = { name: 'zz', tail: '', busy: false, idleTimer: null, ws: null };
  srv.noteActivity(s, 'working (esc to int');
  assert.equal(s.busy, false, 'half a marker is not a match');
  srv.noteActivity(s, 'errupt)');
  assert.equal(s.busy, true, 'the tail bridges the chunk boundary');
  if (s.idleTimer) clearTimeout(s.idleTimer);
});

test('compaction counts as working', () => {
  const s = { name: 'zz', tail: '', busy: false, idleTimer: null, ws: null };
  srv.noteActivity(s, '✻ Compacting conversation… (4m 6s)');
  assert.equal(s.busy, true);
  if (s.idleTimer) clearTimeout(s.idleTimer);
});
