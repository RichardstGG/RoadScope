// Input and output plumbing for validate-motion-lean.mjs: byte-exact line readers (a whole buffer or a
// file read in fixed chunks), random re-reads of a line, findings sinks, and the resource guard.
// Splitting on the 0x0A byte and decoding each line equals decoding the whole file and splitting on
// '\n' (0x0A never occurs inside a multi-byte UTF-8 sequence), so both readers yield the same lines.

import { closeSync, constants, fstatSync, ftruncateSync, openSync, readSync, statfsSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const CHUNK = 64 * 1024;

// A tool-execution failure (exit 3): never a finding, never a PASS.
export class CapacityError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export class CancelledError extends Error {}

// ------------------------------------------------------------------ inputs

export class BufferInput {
  constructor(buffer) {
    this.buffer = buffer;
    this.size = buffer.length;
  }

  *lines(maxLineBytes = DEFAULT_MAX_LINE_BYTES) {
    const buf = this.buffer;
    let start = 0;
    let line = 0;
    while (start <= buf.length) {
      let end = buf.indexOf(0x0a, start);
      if (end === -1) end = buf.length;
      line += 1;
      if (end - start > maxLineBytes) throw new CapacityError('LINE_TOO_LONG', `line ${line} is longer than ${maxLineBytes} bytes`);
      yield { raw: buf.toString('utf8', start, end), line, offset: start, length: end - start };
      start = end + 1;
    }
  }

  readAt(offset, length) {
    return this.buffer.toString('utf8', offset, offset + length);
  }

  close() {}
}

export class FileInput {
  // The descriptor is opened once and used for everything (probing, validating, re-reading, hashing):
  // the identity checked against the findings output is the file actually read.
  constructor(path) {
    this.path = path;
    this.fd = openSync(path, 'r');
    const stat = fstatSync(this.fd);
    if (stat.isDirectory()) {
      closeSync(this.fd);
      const error = new Error(`${path} is a directory`);
      error.code = 'EISDIR';
      throw error;
    }
    this.size = stat.size;
    this.identity = `${stat.dev}:${stat.ino}`;
  }

  // Yields the same sequence as BufferInput over the whole file, holding at most one line plus one chunk.
  *lines(maxLineBytes = DEFAULT_MAX_LINE_BYTES) {
    const chunk = Buffer.allocUnsafe(CHUNK);
    let parts = [];
    let partBytes = 0;
    let lineStart = 0; // file offset of the current line
    let position = 0;
    let line = 0;
    const emit = (lineEnd) => {
      line += 1;
      const raw = parts.length === 1 ? parts[0].toString('utf8') : Buffer.concat(parts, partBytes).toString('utf8');
      const item = { raw, line, offset: lineStart, length: lineEnd - lineStart };
      parts = [];
      partBytes = 0;
      lineStart = lineEnd + 1;
      return item;
    };
    for (;;) {
      const read = readSync(this.fd, chunk, 0, CHUNK, position);
      if (read === 0) break;
      let from = 0;
      while (from < read) {
        const nl = chunk.indexOf(0x0a, from);
        const to = nl === -1 || nl >= read ? read : nl;
        if (to > from) {
          partBytes += to - from;
          if (partBytes > maxLineBytes) throw new CapacityError('LINE_TOO_LONG', `line ${line + 1} is longer than ${maxLineBytes} bytes`);
          parts.push(Buffer.from(chunk.subarray(from, to)));
        }
        if (to === read) break;
        yield emit(position + to);
        from = to + 1;
      }
      position += read;
    }
    yield emit(position);
  }

  readAt(offset, length) {
    const buffer = Buffer.allocUnsafe(length);
    readSync(this.fd, buffer, 0, length, offset);
    return buffer.toString('utf8');
  }

  close() {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }
}

// Opens the findings output WITHOUT truncating it, checks the identity of the open descriptor against
// every input (same path, relative path, symlink and hardlink all resolve to the same dev:ino), and
// truncates only after that check, through the same descriptor: nothing can swap the file in between.
export function openFindingsOutput(path, inputs) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT, 0o600);
  const stat = fstatSync(fd);
  const identity = `${stat.dev}:${stat.ino}`;
  const clash = inputs.find((input) => input.identity === identity);
  if (clash) {
    closeSync(fd);
    const error = new Error(`--findings-out ${path} is the same file as the input ${clash.path}; refusing to overwrite an input`);
    error.code = 'FINDINGS_OUTPUT_IS_INPUT';
    throw error;
  }
  // A regular file is emptied; a device or a pipe (/dev/stdout, a FIFO) is written as is.
  if (stat.isFile()) ftruncateSync(fd, 0);
  return fd;
}

// SHA-256 of the first `length` bytes of a FileInput, in chunks, under the resource guard; yields to the
// event loop so that a cancellation is seen while hashing a large parent.
export async function prefixDigestAsync(input, length, guard) {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(CHUNK);
  let position = 0;
  let chunks = 0;
  while (position < Math.min(length, input.size)) {
    const read = readSync(input.fd, chunk, 0, Math.min(CHUNK, length - position), position);
    if (read === 0) break;
    hash.update(chunk.subarray(0, read));
    position += read;
    chunks += 1;
    guard.checkNow(position);
    if (chunks % 256 === 0) await new Promise((done) => setImmediate(done));
  }
  return { size: input.size, sha256: hash.digest('hex') };
}

// SHA-256 of the first `length` bytes and the total size, without loading the file.
export function prefixDigest(source, length) {
  if (Buffer.isBuffer(source)) {
    return { size: source.length, sha256: createHash('sha256').update(source.subarray(0, length)).digest('hex') };
  }
  const fd = openSync(source, 'r');
  try {
    const size = fstatSync(fd).size;
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(CHUNK);
    let position = 0;
    while (position < Math.min(length, size)) {
      const read = readSync(fd, chunk, 0, Math.min(CHUNK, length - position), position);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      position += read;
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

// ------------------------------------------------------------------ findings

export class MemorySink {
  constructor() {
    this.findings = [];
    this.errors = 0;
    this.total = 0;
  }

  push(finding) {
    this.findings.push(finding);
    this.total += 1;
    if (finding.severity === 'error') this.errors += 1;
  }

  *all() {
    yield* this.findings;
  }

  close() {}
}

// Streams every finding to a JSONL file as it is found; memory keeps only counts. The CLI replays the
// file afterwards, so the complete list is always available and memory does not grow with it.
export class FileSink {
  constructor(path, { fd = null, decorate = null } = {}) {
    this.path = path;
    this.fd = fd ?? openSync(path, 'w', 0o600);
    this.decorate = decorate; // e.g. add the input file to each finding
    this.buffer = [];
    this.bufferBytes = 0;
    this.errors = 0;
    this.total = 0;
    this.findings = [];
  }

  push(finding) {
    const text = `${JSON.stringify(this.decorate ? this.decorate(finding) : finding)}\n`;
    this.buffer.push(text);
    this.bufferBytes += text.length;
    this.total += 1;
    if (finding.severity === 'error') this.errors += 1;
    if (this.bufferBytes >= 64 * 1024) this.flush();
  }

  flush() {
    if (this.buffer.length === 0) return;
    writeSync(this.fd, this.buffer.join(''));
    this.buffer = [];
    this.bufferBytes = 0;
  }

  close() {
    if (this.fd === null) return;
    this.flush();
    closeSync(this.fd);
    this.fd = null;
  }

  // Replays the findings. A finding line is bounded by the input line it describes (detail strings come
  // from at most one record), so the replay uses a bound derived from the input line limit.
  *all(maxLineBytes = 4 * DEFAULT_MAX_LINE_BYTES + 4096) {
    this.flush();
    const input = new FileInput(this.path);
    try {
      for (const { raw } of input.lines(maxLineBytes)) if (raw !== '') yield JSON.parse(raw);
    } finally {
      input.close();
    }
  }
}

// Writes to two sinks: the replay sink of one file and, when asked, the user's --findings-out (streamed
// while validating, so findings found before a failure are kept).
export class TeeSink {
  constructor(primary, secondary) {
    this.primary = primary;
    this.secondary = secondary;
  }

  get path() {
    return this.primary.path;
  }

  get errors() {
    return this.primary.errors;
  }

  get total() {
    return this.primary.total;
  }

  get findings() {
    return [];
  }

  push(finding) {
    this.primary.push(finding);
    if (this.secondary) this.secondary.push(finding);
  }

  flush() {
    this.primary.flush();
    if (this.secondary) this.secondary.flush();
  }

  close() {
    this.flush();
  }

  all(maxLineBytes) {
    return this.primary.all(maxLineBytes);
  }
}

// ------------------------------------------------------------------ resource guard

// Checked from the validation loop (a synchronous loop never runs timers). Exceeding the RSS ceiling or
// the free-space floor aborts with a CapacityError: an aborted run is a failure, never a pass.
export class ResourceGuard {
  constructor({ rssLimitBytes = 0, tmpDir = null, minFreeBytes = 128 * 1024 * 1024, everyLines = 4096, everyBytes = 64 * 1024 * 1024 } = {}) {
    this.rssLimitBytes = rssLimitBytes;
    this.tmpDir = tmpDir;
    this.minFreeBytes = minFreeBytes;
    this.everyLines = everyLines;
    this.everyBytes = everyBytes;
    this.lines = 0;
    this.nextBytes = everyBytes;
    this.peakRss = 0;
    this.cancelled = false;
    this.rearm();
  }

  // A promise that settles on cancellation, to race against waits (e.g. a stdout drain).
  rearm() {
    this.cancelled = false;
    this.whenCancelled = new Promise((done) => {
      this.resolveCancel = done;
    });
  }

  cancel() {
    this.cancelled = true;
    this.resolveCancel();
  }

  check(offset) {
    this.lines += 1;
    if (this.lines % this.everyLines !== 0) return;
    this.checkNow(offset);
  }

  throwIfCancelled() {
    if (this.cancelled) throw new CancelledError('cancelled');
  }

  checkNow(offset) {
    this.throwIfCancelled();
    const rss = process.memoryUsage.rss();
    if (rss > this.peakRss) this.peakRss = rss;
    if (this.rssLimitBytes && rss > this.rssLimitBytes) {
      throw new CapacityError('RSS_LIMIT', `resident memory ${Math.round(rss / 2 ** 20)} MiB exceeds the ${Math.round(this.rssLimitBytes / 2 ** 20)} MiB ceiling`);
    }
    if (this.tmpDir && offset >= this.nextBytes) {
      this.nextBytes = offset + this.everyBytes;
      const fs = statfsSync(this.tmpDir);
      const free = fs.bavail * fs.bsize;
      if (free < this.minFreeBytes) {
        throw new CapacityError('DISK_FULL', `only ${Math.round(free / 2 ** 20)} MiB left in ${this.tmpDir} (floor ${Math.round(this.minFreeBytes / 2 ** 20)} MiB)`);
      }
    }
  }
}
