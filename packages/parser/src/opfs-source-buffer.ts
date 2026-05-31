/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * OPFS-backed source buffer - stores the IFC source file in the Origin Private
 * File System instead of keeping the entire Uint8Array in the JS heap.
 *
 * For a 487MB IFC file, this moves ~487MB out of the JS heap into OPFS storage
 * that is backed by disk. Range reads are used for on-demand entity extraction.
 *
 * Falls back to in-memory Uint8Array when OPFS is not available (e.g., in
 * workers without navigator.storage, or non-secure contexts).
 */

// Minimal type declarations for OPFS APIs (File System Access API)
// These are not included in TypeScript's default lib.
interface OpfsSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface OpfsFileHandle {
  createSyncAccessHandle(): Promise<OpfsSyncAccessHandle>;
}

/**
 * A source buffer that can be backed by either in-memory Uint8Array or OPFS.
 * Provides sync and async read interfaces.
 *
 * Usage:
 * ```ts
 * const source = await OpfsSourceBuffer.create(uint8Buffer);
 * // On-demand entity extraction:
 * const bytes = await source.readRange(byteOffset, byteLength);
 * // Or use the sync subarray for backwards compatibility:
 * const view = source.subarray(byteOffset, byteOffset + byteLength);
 * ```
 */
export class OpfsSourceBuffer {
  /** In-memory buffer (null when offloaded to OPFS) */
  private memoryBuffer: Uint8Array | null;
  /** OPFS sync access handle for range reads (null when in-memory) */
  private fileHandle: OpfsSyncAccessHandle | null = null;
  /** Async file handle wrapper */
  private asyncFileHandle: OpfsFileHandle | null = null;
  /** Total file size in bytes */
  readonly byteLength: number;
  /** Whether the source is backed by OPFS */
  readonly isOpfsBacked: boolean;
  /** OPFS file name (for cleanup) */
  private opfsFileName: string | null = null;

  /**
   * Sliding read-window size for the OPFS-backed path. One handle.read() fills
   * the window; subsequent readRange() calls inside it are served by an
   * in-memory copy instead of a fresh OPFS read. Without this, the fix loop's
   * per-entity reads (millions of them) each hit the disk — the same syscall
   * storm that froze the Node CLI path before its window cache. A file larger
   * than the window slides (bounded source footprint); files at/under it are
   * cached whole. Mutable for tests. Mirrors the CLI's IFC_SOURCE_WINDOW_MIB
   * (default 256 MiB).
   */
  static windowBytes = 256 * 1024 * 1024;
  /** OPFS read window (lazily allocated on first OPFS read; null in-memory). */
  private window: Uint8Array | null = null;
  private winStart = 0;
  private winLen = 0;

  private constructor(
    memoryBuffer: Uint8Array | null,
    byteLength: number,
    isOpfsBacked: boolean
  ) {
    this.memoryBuffer = memoryBuffer;
    this.byteLength = byteLength;
    this.isOpfsBacked = isOpfsBacked;
  }

  /**
   * Create an OpfsSourceBuffer, offloading to OPFS when available.
   *
   * @param buffer - The source IFC file bytes
   * @param forceMemory - If true, skip OPFS and keep in memory
   * @returns A new OpfsSourceBuffer instance
   */
  static async create(buffer: Uint8Array, forceMemory: boolean = false): Promise<OpfsSourceBuffer> {
    if (forceMemory || !OpfsSourceBuffer.isOpfsAvailable()) {
      return new OpfsSourceBuffer(buffer, buffer.byteLength, false);
    }

    let fileName: string | null = null;
    let syncHandle: OpfsSyncAccessHandle | null = null;

    try {
      fileName = `ifc-source-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(fileName, { create: true }) as unknown as OpfsFileHandle;

      // Write buffer to OPFS using sync access handle (fastest path)
      syncHandle = await fileHandle.createSyncAccessHandle();
      const bytesWritten = syncHandle.write(buffer, { at: 0 });
      if (bytesWritten !== buffer.byteLength) {
        syncHandle.close();
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(fileName);
        throw new Error(
          `OPFS short write: wrote ${bytesWritten}/${buffer.byteLength} bytes`
        );
      }
      syncHandle.flush();

      const instance = new OpfsSourceBuffer(null, buffer.byteLength, true);
      instance.fileHandle = syncHandle;
      instance.asyncFileHandle = fileHandle;
      instance.opfsFileName = fileName;

      return instance;
    } catch {
      // OPFS failed — clean up partial resources and fall back to in-memory
      if (syncHandle) {
        try { syncHandle.close(); } catch { /* ignore */ }
      }
      if (fileName) {
        try {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry(fileName);
        } catch { /* ignore */ }
      }
      return new OpfsSourceBuffer(buffer, buffer.byteLength, false);
    }
  }

  /**
   * Open an EXISTING OPFS file as a disk-backed source — no write, no
   * materialize. The streaming convergence handoff: one iteration's sink file
   * becomes the next iteration's source directly, avoiding a whole-file
   * arrayBuffer() round-trip (which would also exceed V8's ~2 GiB ArrayBuffer
   * cap on a 2 GB file). NON-OWNING: dispose() closes the read handle but does
   * NOT delete the file — whoever wrote it (the sink) owns its lifetime.
   *
   * @param fileName - OPFS file name to open (must already exist)
   * @param dirName - optional OPFS subdirectory the file lives in (root if omitted)
   */
  static async fromOpfsFile(
    fileName: string,
    dirName?: string
  ): Promise<OpfsSourceBuffer> {
    if (!OpfsSourceBuffer.isOpfsAvailable()) {
      throw new Error('OpfsSourceBuffer.fromOpfsFile: OPFS unavailable');
    }
    const root = await navigator.storage.getDirectory();
    const dir = dirName ? await root.getDirectoryHandle(dirName) : root;
    // No { create } — the file must already exist (it's the prior iter's sink).
    const fileHandle = (await dir.getFileHandle(
      fileName
    )) as unknown as OpfsFileHandle;
    const syncHandle = await fileHandle.createSyncAccessHandle();
    const byteLength = syncHandle.getSize();
    const instance = new OpfsSourceBuffer(null, byteLength, true);
    instance.fileHandle = syncHandle;
    instance.asyncFileHandle = fileHandle;
    // opfsFileName stays null → dispose() closes the handle but never
    // removeEntry()s the file: the sink that wrote it owns deletion.
    return instance;
  }

  /**
   * Check if OPFS is available in the current context.
   */
  static isOpfsAvailable(): boolean {
    return (
      typeof globalThis !== 'undefined' &&
      typeof globalThis.navigator?.storage?.getDirectory === 'function'
    );
  }

  /**
   * Read a byte range from the source buffer.
   * Works for both in-memory and OPFS-backed buffers.
   */
  readRange(byteOffset: number, byteLength: number): Uint8Array {
    if (byteOffset < 0 || byteLength < 0 || byteOffset + byteLength > this.byteLength) {
      throw new RangeError(
        `OpfsSourceBuffer.readRange: offset=${byteOffset} length=${byteLength} exceeds buffer size=${this.byteLength}`
      );
    }

    if (this.memoryBuffer) {
      // In-memory: zero-copy subarray view
      return this.memoryBuffer.subarray(byteOffset, byteOffset + byteLength);
    }

    if (this.fileHandle) {
      const cap = Math.min(
        OpfsSourceBuffer.windowBytes,
        Math.max(this.byteLength, 1)
      );

      // Range larger than the window: bypass it with a direct read (rare —
      // e.g. a whole-source materialize on a >window file). Leaves the window
      // untouched.
      if (byteLength > cap) {
        const dest = new Uint8Array(byteLength);
        const bytesRead = this.fileHandle.read(dest, { at: byteOffset });
        if (bytesRead < byteLength) {
          throw new Error(
            `OpfsSourceBuffer.readRange: short read (${bytesRead}/${byteLength} bytes at offset ${byteOffset})`
          );
        }
        return dest;
      }

      if (this.window === null) this.window = new Uint8Array(cap);
      const end = byteOffset + byteLength;
      const inWindow =
        this.winLen > 0 &&
        byteOffset >= this.winStart &&
        end <= this.winStart + this.winLen;
      if (!inWindow) {
        // Fill so [byteOffset, end) is covered. When the window holds the whole
        // file, anchor at 0 so reads below the first touched offset still hit.
        const start = cap >= this.byteLength ? 0 : byteOffset;
        const want = Math.min(cap, this.byteLength - start);
        const got = this.fileHandle.read(this.window.subarray(0, want), {
          at: start,
        });
        if (got < want) {
          throw new Error(
            `OpfsSourceBuffer.readRange: short window read (${got}/${want} bytes at offset ${start})`
          );
        }
        this.winStart = start;
        this.winLen = want;
      }
      // Copy out — callers retain returned slices across later reads (the next
      // refill would overwrite a view into the shared window buffer).
      const rel = byteOffset - this.winStart;
      return this.window.slice(rel, rel + byteLength);
    }

    throw new Error('OpfsSourceBuffer: no backing store available');
  }

  /**
   * Synchronous subarray — for backward compatibility with code that
   * expects `source.subarray(start, end)`.
   *
   * When OPFS-backed, this allocates a new Uint8Array and reads from disk.
   * When in-memory, this returns a zero-copy view.
   */
  subarray(start: number, end: number): Uint8Array {
    return this.readRange(start, end - start);
  }

  /**
   * Get the full in-memory buffer (only available when not OPFS-backed).
   * Used as a migration aid — callers should prefer readRange().
   *
   * @throws Error if the buffer has been offloaded to OPFS
   */
  getMemoryBuffer(): Uint8Array {
    if (this.memoryBuffer) return this.memoryBuffer;
    throw new Error(
      'OpfsSourceBuffer: source has been offloaded to OPFS. Use readRange() instead.'
    );
  }

  /**
   * Check if the in-memory buffer is still available.
   */
  hasMemoryBuffer(): boolean {
    return this.memoryBuffer !== null;
  }

  /**
   * Release OPFS resources and clean up the temporary file.
   * Call this when the model is unloaded.
   */
  async dispose(): Promise<void> {
    if (this.fileHandle) {
      this.fileHandle.close();
      this.fileHandle = null;
    }

    if (this.opfsFileName) {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(this.opfsFileName);
      } catch {
        // Ignore cleanup errors
      }
      this.opfsFileName = null;
    }

    this.asyncFileHandle = null;
    this.memoryBuffer = null;
    this.window = null;
    this.winStart = 0;
    this.winLen = 0;
  }
}
