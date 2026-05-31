import { afterEach, describe, expect, it } from 'vitest';
import { OpfsSourceBuffer } from './opfs-source-buffer.js';

// OPFS is unavailable in Node, so create() falls back to in-memory. To exercise
// the OPFS-backed sliding-window path we inject a fake sync access handle backed
// by an in-memory array and reach in via a cast (the constructor is private).
function makeOpfsBacked(data: Uint8Array): {
  buf: OpfsSourceBuffer;
  stats: () => { reads: number; bytesRead: number };
} {
  let reads = 0;
  let bytesRead = 0;
  const handle = {
    read(buffer: ArrayBufferView, options?: { at?: number }): number {
      const at = options?.at ?? 0;
      const dest = new Uint8Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength
      );
      const n = Math.max(0, Math.min(dest.length, data.length - at));
      dest.set(data.subarray(at, at + n));
      reads++;
      bytesRead += n;
      return n;
    },
    write(): number {
      return 0;
    },
    flush(): void {},
    close(): void {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buf = new (OpfsSourceBuffer as any)(null, data.length, true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (buf as any).fileHandle = handle;
  return { buf, stats: () => ({ reads, bytesRead }) };
}

function makeData(n: number): Uint8Array {
  const d = new Uint8Array(n);
  for (let i = 0; i < n; i++) d[i] = (i * 31 + 7) & 0xff;
  return d;
}

const DEFAULT_WINDOW = OpfsSourceBuffer.windowBytes;
afterEach(() => {
  OpfsSourceBuffer.windowBytes = DEFAULT_WINDOW;
});

describe('OpfsSourceBuffer windowed OPFS reads', () => {
  it('returns correct bytes for every range with a sliding (smaller-than-file) window', () => {
    const data = makeData(4096);
    OpfsSourceBuffer.windowBytes = 256; // window << file → forces sliding
    const { buf } = makeOpfsBacked(data);
    // Walk many ranges in varied order (forward, backward, random-ish).
    for (let pass = 0; pass < 3; pass++) {
      for (let off = 0; off < data.length; off += 17) {
        const len = Math.min(40, data.length - off);
        const got = buf.readRange(off, len);
        expect(Array.from(got)).toEqual(Array.from(data.subarray(off, off + len)));
      }
    }
  });

  it('serves repeated in-window reads without re-reading from disk', () => {
    const data = makeData(4096);
    OpfsSourceBuffer.windowBytes = 1024;
    const { buf, stats } = makeOpfsBacked(data);
    // 500 reads all within the first 1024 bytes → exactly one disk read.
    for (let i = 0; i < 500; i++) {
      const off = (i * 7) % 900;
      buf.readRange(off, 16);
    }
    expect(stats().reads).toBe(1);
  });

  it('caches the whole file when the window is >= file size (one read total)', () => {
    const data = makeData(2048);
    OpfsSourceBuffer.windowBytes = 1024 * 1024; // window >> file
    const { buf, stats } = makeOpfsBacked(data);
    buf.readRange(2000, 48); // first touch near the end
    buf.readRange(0, 10); // a read below the first offset must still hit
    expect(stats().reads).toBe(1);
    expect(Array.from(buf.readRange(0, 10))).toEqual(
      Array.from(data.subarray(0, 10))
    );
  });

  it('returns a stable copy across later refills (not a view into the window)', () => {
    const data = makeData(4096);
    OpfsSourceBuffer.windowBytes = 256;
    const { buf } = makeOpfsBacked(data);
    const first = buf.readRange(0, 32);
    const firstCopy = Array.from(first);
    // Force the window to slide far away (evicts [0,256)).
    buf.readRange(3000, 32);
    // The earlier slice must be unchanged.
    expect(Array.from(first)).toEqual(firstCopy);
    expect(Array.from(first)).toEqual(Array.from(data.subarray(0, 32)));
  });

  it('handles a range larger than the window via the bypass path', () => {
    const data = makeData(4096);
    OpfsSourceBuffer.windowBytes = 256;
    const { buf } = makeOpfsBacked(data);
    const got = buf.readRange(100, 1000); // 1000 > 256 → bypass
    expect(Array.from(got)).toEqual(Array.from(data.subarray(100, 1100)));
  });

  it('reads spanning a refill boundary stay correct', () => {
    const data = makeData(4096);
    OpfsSourceBuffer.windowBytes = 256;
    const { buf } = makeOpfsBacked(data);
    // Read at the very end of one window, then just past it.
    expect(Array.from(buf.readRange(240, 16))).toEqual(
      Array.from(data.subarray(240, 256))
    );
    expect(Array.from(buf.readRange(250, 20))).toEqual(
      Array.from(data.subarray(250, 270))
    );
  });
});

describe('OpfsSourceBuffer.fromOpfsFile', () => {
  // Stub navigator.storage with an in-memory OPFS so fromOpfsFile's
  // getDirectory → getDirectoryHandle → getFileHandle → createSyncAccessHandle
  // chain resolves in Node.
  function installFakeOpfs(files: Record<string, Uint8Array>) {
    const removed: string[] = [];
    const closed = { count: 0 };
    const makeHandle = (data: Uint8Array) => ({
      read(buffer: ArrayBufferView, options?: { at?: number }): number {
        const at = options?.at ?? 0;
        const dest = new Uint8Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength
        );
        const n = Math.max(0, Math.min(dest.length, data.length - at));
        dest.set(data.subarray(at, at + n));
        return n;
      },
      write: () => 0,
      getSize: () => data.length,
      flush: () => {},
      close: () => {
        closed.count++;
      },
    });
    const dir: Record<string, unknown> = {
      getFileHandle: async (name: string, opts?: { create?: boolean }) => {
        if (!(name in files) && !opts?.create) {
          throw new Error(`NotFoundError: ${name}`);
        }
        return { createSyncAccessHandle: async () => makeHandle(files[name]) };
      },
      getDirectoryHandle: async () => dir,
      removeEntry: async (name: string) => {
        removed.push(name);
      },
    };
    // navigator is a getter-only global in Node/vitest — define it instead of
    // assigning, and capture the original descriptor to restore.
    const prevDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { storage: { getDirectory: async () => dir } },
      configurable: true,
      writable: true,
    });
    return {
      removed,
      closed,
      restore: () => {
        if (prevDesc) Object.defineProperty(globalThis, 'navigator', prevDesc);
        else delete (globalThis as { navigator?: unknown }).navigator;
      },
    };
  }

  it('opens an existing file, reads correct bytes, and dispose() does NOT delete it', async () => {
    const data = makeData(3000);
    const fake = installFakeOpfs({ 'iter-3.bin': data });
    try {
      const src = await OpfsSourceBuffer.fromOpfsFile('iter-3.bin');
      expect(src.byteLength).toBe(3000);
      expect(Array.from(src.readRange(100, 50))).toEqual(
        Array.from(data.subarray(100, 150))
      );
      await src.dispose();
      // dispose closes the read handle but must NOT removeEntry the file:
      // the sink that wrote it owns deletion.
      expect(fake.closed.count).toBe(1);
      expect(fake.removed).toEqual([]);
    } finally {
      fake.restore();
    }
  });

  it('resolves a file inside a named subdirectory', async () => {
    const data = makeData(512);
    const fake = installFakeOpfs({ 'iter-0.bin': data });
    try {
      const src = await OpfsSourceBuffer.fromOpfsFile(
        'iter-0.bin',
        'ifc-check-recfix'
      );
      expect(src.byteLength).toBe(512);
      expect(Array.from(src.readRange(0, 16))).toEqual(
        Array.from(data.subarray(0, 16))
      );
      await src.dispose();
    } finally {
      fake.restore();
    }
  });
});
