// Input and output plumbing for validate-motion-lean.mjs: byte-exact line readers (a whole buffer or a
// file read in fixed chunks), random re-reads of a line, findings sinks, and the resource guard.
// Splitting on the 0x0A byte and decoding each line equals decoding the whole file and splitting on
// '\n' (0x0A never occurs inside a multi-byte UTF-8 sequence), so both readers yield the same lines.

import { closeSync, fstatSync, openSync, readSync, statfsSync, writeSync } from 'node:fs';
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
  constructor(path) {
    this.path = path;
    this.fd = openSync(path, 'r');
    this.size = fstatSync(this.fd).size;
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
    closeSync(this.fd);
  }
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
  constructor(path) {
    this.path = path;
    this.fd = openSync(path, 'w', 0o600);
    this.buffer = [];
    this.bufferBytes = 0;
    this.errors = 0;
    this.total = 0;
    this.findings = [];
  }

  push(finding) {
    const text = `${JSON.stringify(finding)}\n`;
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

  *all() {
    this.close();
    const input = new FileInput(this.path);
    try {
      for (const { raw } of input.lines(Number.MAX_SAFE_INTEGER)) if (raw !== '') yield JSON.parse(raw);
    } finally {
      input.close();
    }
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
  }

  check(offset) {
    this.lines += 1;
    if (this.lines % this.everyLines !== 0) return;
    if (this.cancelled) throw new CancelledError('cancelled');
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
