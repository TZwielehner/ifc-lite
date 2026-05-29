/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Chunked STEP entity scanner (Tier 2 of the 2 GB work).
 *
 * StepTokenizer.scanEntitiesFast scans a single contiguous `Uint8Array` — for
 * a 2 GB file that buffer can't even be allocated (it exceeds V8's ~2 GiB
 * ArrayBuffer limit, and copying it into wasm hits the 4 GiB wasm32 wall).
 * This scanner reads the source in fixed windows through the `SourceReader`
 * seam (a disk range read for OPFS-backed sources) and yields the SAME entity
 * references — `{ expressId, type, offset, length, line }` with ABSOLUTE file
 * offsets — never holding more than one window (plus a carry tail) in memory.
 *
 * Cross-window correctness: an entity (or a token, or a quoted string) can
 * straddle a window boundary. When a `#…;` declaration starts inside the
 * current buffer but its terminating `;` isn't present yet, the unfinished
 * bytes from that entity's start are carried into the next read. A single
 * entity larger than `windowBytes` (e.g. a multi-MB IfcCartesianPointList)
 * simply grows the working buffer across successive reads until it completes —
 * `windowBytes` is a minimum read granularity, not a cap on entity size.
 *
 * Equivalence to scanEntitiesFast is pinned by chunked-tokenizer.test.ts,
 * which diffs the output for window sizes from 1 byte upward.
 */

import type { SourceReader } from './columnar-parser.js';

export interface ScannedEntity {
  expressId: number;
  type: string;
  /** Absolute byte offset of the leading '#' in the file. */
  offset: number;
  /** Byte length from '#' through the terminating ';' inclusive. */
  length: number;
  /** 1-based line number of the leading '#'. */
  line: number;
}

const HASH = 0x23; // '#'
const EQUALS = 0x3d; // '='
const LPAREN = 0x28; // '('
const SEMICOLON = 0x3b; // ';'
const QUOTE = 0x27; // '\''
const NEWLINE = 0x0a; // '\n'

type EntityParse =
  | {
      kind: 'entity';
      expressId: number;
      type: string;
      length: number;
      nextPos: number;
      line: number;
    }
  | { kind: 'none'; nextPos: number; line: number }
  | { kind: 'need-more' };

/**
 * Attempt to parse one `#id=TYPE(...);` entity starting at `start`. Mirrors
 * the acceptance logic of StepTokenizer.scanEntitiesFast exactly so the two
 * produce identical results. Returns `need-more` when the declaration runs
 * past the end of `buf` and more bytes may follow (`!eof`); the caller then
 * carries `buf[start..]` into the next window. `none` means "not a valid
 * entity here" and reports where scanning should resume.
 */
function tryParseEntity(
  buf: Uint8Array,
  start: number,
  len: number,
  startLine: number,
  typeCache: Map<number, string>,
  eof: boolean,
): EntityParse {
  let pos = start + 1; // skip '#'
  let line = startLine;

  // Express ID
  let expressId = 0;
  let hasDigits = false;
  while (pos < len) {
    const c = buf[pos];
    if (c >= 0x30 && c <= 0x39) {
      expressId = expressId * 10 + (c - 0x30);
      hasDigits = true;
      pos++;
    } else break;
  }
  if (pos >= len && !eof) return { kind: 'need-more' };
  if (!hasDigits) return { kind: 'none', nextPos: pos, line };

  // Whitespace
  while (pos < len) {
    const c = buf[pos];
    if (c === 0x20 || c === 0x09 || c === 0x0d) pos++;
    else if (c === NEWLINE) {
      line++;
      pos++;
    } else break;
  }
  if (pos >= len && !eof) return { kind: 'need-more' };
  if (pos >= len || buf[pos] !== EQUALS) return { kind: 'none', nextPos: pos, line };
  pos++; // skip '='

  // Whitespace
  while (pos < len) {
    const c = buf[pos];
    if (c === 0x20 || c === 0x09 || c === 0x0d) pos++;
    else if (c === NEWLINE) {
      line++;
      pos++;
    } else break;
  }
  if (pos >= len && !eof) return { kind: 'need-more' };

  // Type name (must start A-Z)
  const typeStart = pos;
  if (pos >= len || buf[pos] < 0x41 || buf[pos] > 0x5a)
    return { kind: 'none', nextPos: pos, line };
  while (pos < len) {
    const c = buf[pos];
    if (
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0x30 && c <= 0x39) ||
      c === 0x5f
    )
      pos++;
    else break;
  }
  // The type name might continue into the next window.
  if (pos >= len && !eof) return { kind: 'need-more' };
  if (pos === typeStart) return { kind: 'none', nextPos: pos, line };

  let typeHash = pos - typeStart;
  for (let i = typeStart; i < pos; i++) typeHash = (typeHash * 31 + buf[i]) | 0;
  let type = typeCache.get(typeHash);
  if (type === undefined) {
    type = String.fromCharCode(...buf.subarray(typeStart, pos));
    typeCache.set(typeHash, type);
  }

  // Whitespace
  while (pos < len) {
    const c = buf[pos];
    if (c === 0x20 || c === 0x09 || c === 0x0d) pos++;
    else if (c === NEWLINE) {
      line++;
      pos++;
    } else break;
  }
  if (pos >= len && !eof) return { kind: 'need-more' };
  if (pos >= len || buf[pos] !== LPAREN) return { kind: 'none', nextPos: pos, line };

  // Skip to the terminating ';' (string-aware, STEP doubled-quote escapes).
  let inString = false;
  while (pos < len) {
    const c = buf[pos];
    if (c === QUOTE) {
      if (inString && pos + 1 < len && buf[pos + 1] === QUOTE) {
        pos += 2; // escaped quote ''
        continue;
      }
      // A quote at the very end is ambiguous: the next byte could be a
      // doubled-quote escape. Demand more bytes unless we're at EOF.
      if (inString && pos + 1 >= len && !eof) return { kind: 'need-more' };
      inString = !inString;
    } else if (c === SEMICOLON && !inString) {
      return {
        kind: 'entity',
        expressId,
        type,
        length: pos - start + 1, // include ';'
        nextPos: pos + 1,
        line,
      };
    } else if (c === NEWLINE) {
      line++;
    }
    pos++;
  }
  // Ran out before ';'.
  return eof ? { kind: 'none', nextPos: pos, line } : { kind: 'need-more' };
}

/**
 * Scan `source` in windows, yielding every entity with absolute file offsets.
 * Memory use is bounded by `windowBytes` plus the largest single entity.
 */
export function* scanEntitiesChunked(
  source: SourceReader,
  windowBytes = 32 * 1024 * 1024,
): Generator<ScannedEntity> {
  const total = source.byteLength;
  const win = Math.max(1, windowBytes | 0);

  let carry = new Uint8Array(0); // unconsumed tail from the previous window
  let absBase = 0; // file offset of carry[0]
  let baseLine = 1; // line number at absBase
  let readPos = 0; // next file offset to read
  const typeCache = new Map<number, string>();

  while (true) {
    let combined: Uint8Array;
    if (readPos < total) {
      const want = Math.min(win, total - readPos);
      const chunk = source.subarray(readPos, readPos + want);
      readPos += want;
      if (carry.length === 0) {
        combined = chunk;
      } else {
        combined = new Uint8Array(carry.length + chunk.length);
        combined.set(carry);
        combined.set(chunk, carry.length);
      }
    } else {
      combined = carry;
    }

    const eof = readPos >= total;
    const len = combined.length;
    let pos = 0;
    let line = baseLine;
    let carryFrom = len; // default: nothing left over

    while (pos < len) {
      const c = combined[pos];
      if (c === HASH) {
        const startOffset = pos;
        const startLine = line;
        const r = tryParseEntity(combined, pos, len, line, typeCache, eof);
        if (r.kind === 'need-more') {
          carryFrom = startOffset; // re-read this entity from its '#'
          break;
        }
        if (r.kind === 'entity') {
          yield {
            expressId: r.expressId,
            type: r.type,
            offset: absBase + startOffset,
            length: r.length,
            line: startLine,
          };
          pos = r.nextPos;
          line = r.line;
        } else {
          // Not a valid entity — resume where scanEntitiesFast's `continue`
          // would (after the bytes it already consumed), never < start+1.
          pos = r.nextPos > startOffset ? r.nextPos : startOffset + 1;
          line = r.line;
        }
      } else if (c === NEWLINE) {
        line++;
        pos++;
      } else {
        pos++;
      }
    }

    if (eof) return;

    // `line` now equals the line number at `carryFrom` (on a need-more break we
    // never advanced past the entity's '#'; on a clean end carryFrom === len).
    baseLine = line;
    carry = combined.subarray(carryFrom).slice(); // detach from the window buffer
    absBase += carryFrom;
  }
}
