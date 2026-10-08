// Index stores for validate-motion-lean.mjs. The validator keeps every collection whose size is
// controlled by the input (sequence spaces, sessions, calibrations, epochs, gap intervals, ...)
// behind this interface, so the same rules run on two backends:
//   MemoryStore  plain Maps; for small inputs and the library API
//   SqliteStore  an on-disk SQLite index with a bounded write-back cache; memory does not grow
//                with the input. Requires better-sqlite3 (loaded lazily).
// Both must give identical answers; test/run-differential.mjs checks that on every fixture.

import { createRequire } from 'node:module';

const ALL = '\u0000all';

// ------------------------------------------------------------------ memory

export class MemoryStore {
  idle() {}

  constructor() {
    this.kind = 'memory';
    this.maps = new Map();
    this.seqRows = new Map();
    this.cover = [];
    this.breaksBy = new Map();
    this.sessionList = [];
  }

  tick() {}

  kv(name) {
    if (!this.maps.has(name)) this.maps.set(name, new Map());
    return this.maps.get(name);
  }

  // Sequence index: one row per (namespace, source, sequence). `first` (hash, offset, length) is kept
  // from the first occurrence; `info` is replaced by every later occurrence (the C1 semantics).
  seqGet(ns, source, sequence) {
    return this.seqRows.get(`${ns}\u0000${source}\u0000${sequence}`);
  }

  seqPut(ns, source, sequence, first, info) {
    const key = `${ns}\u0000${source}\u0000${sequence}`;
    const row = this.seqRows.get(key);
    if (row) row.info = info;
    else this.seqRows.set(key, { first, info });
  }

  addCover(source, boot, from, to) {
    this.cover.push({ source: source ?? ALL, boot, from, to });
  }

  // Is there a cover interval of this source (or of all sources) in this boot with from <= hi and to >= lo?
  coverOverlaps(source, boot, lo, hi) {
    return this.cover.some((c) => (c.source === source || c.source === ALL) && c.boot === boot && c.from <= hi && c.to >= lo);
  }

  addBreak(source, boot, nextSeq) {
    if (!this.breaksBy.has(source)) this.breaksBy.set(source, []);
    this.breaksBy.get(source).push({ boot, nextSeq });
  }

  // Is there a break of this source in this boot with lo < nextSeq <= hi?
  breakIn(source, boot, lo, hi) {
    return (this.breaksBy.get(source) ?? []).some((b) => b.boot === boot && lo < b.nextSeq && b.nextSeq <= hi);
  }

  sessionPush() {
    this.sessionList.push(new Map());
    return this.sessionList.length - 1;
  }

  sessionCount() {
    return this.sessionList.length;
  }

  sessionDecl(index, source) {
    return this.sessionList[index]?.get(source);
  }

  sessionSetDecl(index, source, declaration) {
    this.sessionList[index].set(source, declaration);
  }

  close() {}
}

// ------------------------------------------------------------------ sqlite

// A Map-like view over one namespace of the shared kv table. Values are JSON. Objects returned by
// get() may be mutated by the caller (the validator does): the shared cache keeps them, writes them
// back on eviction, and never evicts an entry touched during the current record (see tick()).
class CachedKV {
  constructor(store, ns) {
    this.store = store;
    this.ns = ns;
  }

  get(key) {
    return this.store.cacheGet(this.ns, String(key));
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value) {
    this.store.cacheSet(this.ns, String(key), value);
    return this;
  }
}

export class SqliteStore {
  constructor(path, { cacheEntries = 20_000, pageCacheKiB = 8_192 } = {}) {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    this.kind = 'disk';
    this.db = new Database(path);
    this.db.pragma('journal_mode = OFF');
    this.db.pragma('synchronous = OFF');
    this.db.pragma('locking_mode = EXCLUSIVE');
    this.db.pragma('temp_store = FILE');
    this.db.pragma('mmap_size = 0');
    this.db.pragma(`cache_size = -${pageCacheKiB}`);
    this.db.exec(`
      CREATE TABLE kv (ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (ns, k)) WITHOUT ROWID;
      CREATE TABLE intern (s TEXT PRIMARY KEY, id INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE seq (ns INTEGER NOT NULL, src INTEGER NOT NULL, seq INTEGER NOT NULL,
                        hash BLOB NOT NULL, off INTEGER NOT NULL, len INTEGER NOT NULL, info TEXT NOT NULL,
                        PRIMARY KEY (ns, src, seq)) WITHOUT ROWID;
      CREATE TABLE cover (src INTEGER NOT NULL, boot INTEGER NOT NULL, frm INTEGER NOT NULL, too INTEGER NOT NULL);
      CREATE INDEX cover_by_key ON cover (src, boot, frm);
      CREATE TABLE breaks (src INTEGER NOT NULL, boot INTEGER NOT NULL, next INTEGER NOT NULL);
      CREATE INDEX breaks_by_key ON breaks (src, boot, next);
      CREATE TABLE sessions (i INTEGER NOT NULL, src INTEGER NOT NULL, decl TEXT NOT NULL, PRIMARY KEY (i, src)) WITHOUT ROWID;
    `);
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      kvGet: p('SELECT v FROM kv WHERE ns = ? AND k = ?').pluck(),
      kvPut: p('INSERT OR REPLACE INTO kv (ns, k, v) VALUES (?, ?, ?)'),
      internGet: p('SELECT id FROM intern WHERE s = ?').pluck(),
      internPut: p('INSERT INTO intern (s, id) VALUES (?, ?)'),
      seqInsert: p('INSERT OR IGNORE INTO seq (ns, src, seq, hash, off, len, info) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      seqUpdate: p('UPDATE seq SET info = ? WHERE ns = ? AND src = ? AND seq = ?'),
      seqGet: p('SELECT hash, off, len, info FROM seq WHERE ns = ? AND src = ? AND seq = ?'),
      coverPut: p('INSERT INTO cover (src, boot, frm, too) VALUES (?, ?, ?, ?)'),
      coverAny: p('SELECT 1 FROM cover WHERE src IN (?, ?) AND boot = ? AND frm <= ? AND too >= ? LIMIT 1').pluck(),
      breakPut: p('INSERT INTO breaks (src, boot, next) VALUES (?, ?, ?)'),
      breakAny: p('SELECT 1 FROM breaks WHERE src = ? AND boot = ? AND next > ? AND next <= ? LIMIT 1').pluck(),
      sessionPut: p('INSERT OR REPLACE INTO sessions (i, src, decl) VALUES (?, ?, ?)'),
      sessionGet: p('SELECT decl FROM sessions WHERE i = ? AND src = ?').pluck(),
    };
    this.cache = new Map(); // `${ns}\u0000${key}` -> {ns, key, value, tick}
    this.cacheEntries = cacheEntries;
    this.internCache = new Map();
    this.nextIntern = 1;
    this.tickNo = 0;
    this.sessions = 0;
    this.pending = 0;
    this.db.exec('BEGIN');
  }

  // Called once per input line. Entries touched during the current line are pinned: the validator
  // may still hold (and mutate) them. Writes are committed in batches.
  tick() {
    this.tickNo += 1;
    if (this.pending >= 20_000) {
      this.db.exec('COMMIT');
      this.db.exec('BEGIN');
      this.pending = 0;
    }
  }

  kv(name) {
    return new CachedKV(this, name);
  }

  // Hot keys (a source's sequence space, last sample, ...) are touched several times per line: reorder
  // an entry at most once per line and update it in place, so the cache allocates almost nothing.
  touch(id, entry) {
    if (entry.tick === this.tickNo) return;
    entry.tick = this.tickNo;
    this.cache.delete(id); // move to the most recent end
    this.cache.set(id, entry);
  }

  cacheGet(ns, key) {
    const id = `${ns}\u0000${key}`;
    const hit = this.cache.get(id);
    if (hit) {
      this.touch(id, hit);
      return hit.value;
    }
    const raw = this.q.kvGet.get(ns, key);
    if (raw === undefined) return undefined;
    const value = JSON.parse(raw);
    this.cache.set(id, { ns, key, value, tick: this.tickNo });
    this.evict();
    return value;
  }

  cacheSet(ns, key, value) {
    const id = `${ns}\u0000${key}`;
    const hit = this.cache.get(id);
    if (hit) {
      hit.value = value;
      this.touch(id, hit);
      return;
    }
    this.cache.set(id, { ns, key, value, tick: this.tickNo });
    this.evict();
  }

  evict() {
    if (this.cache.size <= this.cacheEntries) return;
    for (const [id, entry] of this.cache) {
      if (this.cache.size <= this.cacheEntries) break;
      if (entry.tick === this.tickNo) continue; // pinned for the current line
      this.q.kvPut.run(entry.ns, entry.key, JSON.stringify(entry.value));
      this.pending += 1;
      this.cache.delete(id);
    }
  }

  intern(text) {
    const key = String(text);
    const cached = this.internCache.get(key);
    if (cached !== undefined) return cached;
    let id = this.q.internGet.get(key);
    if (id === undefined) {
      id = this.nextIntern;
      this.nextIntern += 1;
      this.q.internPut.run(key, id);
      this.pending += 1;
    }
    if (this.internCache.size >= 10_000) this.internCache.clear();
    this.internCache.set(key, id);
    return id;
  }

  seqGet(ns, source, sequence) {
    const row = this.q.seqGet.get(this.intern(ns), this.intern(source), sequence);
    if (!row) return undefined;
    return { first: { hash: row.hash, offset: row.off, length: row.len }, info: JSON.parse(row.info) };
  }

  seqPut(ns, source, sequence, first, info) {
    const n = this.intern(ns);
    const s = this.intern(source);
    const json = JSON.stringify(info);
    const inserted = this.q.seqInsert.run(n, s, sequence, first.hash, first.offset, first.length, json);
    if (inserted.changes === 0) this.q.seqUpdate.run(json, n, s, sequence);
    this.pending += 1;
  }

  addCover(source, boot, from, to) {
    this.q.coverPut.run(this.intern(source ?? ALL), this.intern(boot), from, to);
    this.pending += 1;
  }

  coverOverlaps(source, boot, lo, hi) {
    return this.q.coverAny.get(this.intern(source), this.intern(ALL), this.intern(boot), hi, lo) !== undefined;
  }

  addBreak(source, boot, nextSeq) {
    this.q.breakPut.run(this.intern(source), this.intern(boot), nextSeq);
    this.pending += 1;
  }

  breakIn(source, boot, lo, hi) {
    return this.q.breakAny.get(this.intern(source), this.intern(boot), lo, hi) !== undefined;
  }

  sessionPush() {
    this.sessions += 1;
    return this.sessions - 1;
  }

  sessionCount() {
    return this.sessions;
  }

  sessionDecl(index, source) {
    const raw = this.q.sessionGet.get(index, this.intern(source));
    return raw === undefined ? undefined : JSON.parse(raw);
  }

  sessionSetDecl(index, source, declaration) {
    this.q.sessionPut.run(index, this.intern(source), JSON.stringify(declaration));
    this.pending += 1;
  }

  // Between uses (e.g. the --motion index while other files are validated): write the cache back, drop
  // it, and let SQLite release its page cache. A later lookup simply re-reads from disk.
  idle() {
    for (const entry of this.cache.values()) this.q.kvPut.run(entry.ns, entry.key, JSON.stringify(entry.value));
    this.cache.clear();
    this.internCache.clear();
    this.db.exec('COMMIT');
    this.db.pragma('shrink_memory');
    this.db.exec('BEGIN');
    this.pending = 0;
  }

  close() {
    if (!this.db.open) return;
    try {
      this.db.exec('COMMIT');
    } catch {
      // nothing pending
    }
    this.db.close();
  }
}
