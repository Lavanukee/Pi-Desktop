import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChecksumMismatchError, downloadFile } from './download.js';

/** Deterministic payload big enough to arrive in several chunks. */
const PAYLOAD = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 31 + 7) % 251));
const SHA = createHash('sha256').update(PAYLOAD).digest('hex');

interface Fixture {
  server: Server;
  url: string;
  /** Requests observed, with the Range header (if any). */
  requests: Array<{ range: string | undefined }>;
  /** When set, close the socket after writing this many bytes of the body. */
  cutAfter: number | undefined;
}

async function startFixture(): Promise<Fixture> {
  const fixture: Fixture = {
    server: undefined as unknown as Server,
    url: '',
    requests: [],
    cutAfter: undefined,
  };

  const server = createServer((req, res) => {
    const range = req.headers.range;
    fixture.requests.push({ range: typeof range === 'string' ? range : undefined });

    let start = 0;
    if (typeof range === 'string') {
      const m = /bytes=(\d+)-/.exec(range);
      if (m?.[1] !== undefined) start = Number(m[1]);
    }
    const slice = PAYLOAD.subarray(start);

    if (start > 0) {
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`);
    } else {
      res.statusCode = 200;
    }
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('content-length', String(slice.length));

    if (fixture.cutAfter !== undefined && slice.length > fixture.cutAfter) {
      // Simulate a mid-stream disconnect: write a prefix, then destroy socket.
      res.write(slice.subarray(0, fixture.cutAfter));
      res.socket?.destroy();
      return;
    }
    res.end(slice);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  fixture.server = server;
  fixture.url = `http://127.0.0.1:${addr.port}/file`;
  return fixture;
}

describe('downloadFile', () => {
  let fixture: Fixture;
  let dest: string;

  beforeEach(async () => {
    fixture = await startFixture();
    dest = join(tmpdir(), `pi-dl-${Math.random().toString(36).slice(2)}.bin`);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await rm(dest, { force: true });
    await rm(`${dest}.part`, { force: true });
  });

  it('downloads and verifies sha256, reporting progress', async () => {
    const progress: number[] = [];
    const result = await downloadFile({
      url: fixture.url,
      dest,
      expectedSha256: SHA,
      onProgress: (p) => progress.push(p.received),
      progressIntervalMs: 0,
    });
    expect(result.sha256).toBe(SHA);
    expect(result.bytes).toBe(PAYLOAD.length);
    expect(result.cached).toBe(false);
    expect((await readFile(dest)).equals(PAYLOAD)).toBe(true);
    // Progress is monotonic and reaches the total.
    expect(progress.at(-1)).toBe(PAYLOAD.length);
  });

  it('rejects a checksum mismatch', async () => {
    await expect(
      downloadFile({ url: fixture.url, dest, expectedSha256: 'deadbeef' }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
  });

  it('resumes from an existing .part via a Range request, re-hashing the prefix', async () => {
    // Seed a partial download (as a prior interrupted transfer would leave).
    const partSize = 80_000;
    await writeFile(`${dest}.part`, PAYLOAD.subarray(0, partSize));

    const result = await downloadFile({ url: fixture.url, dest, expectedSha256: SHA });
    expect(result.resumed).toBe(true);
    expect(result.sha256).toBe(SHA);
    expect((await readFile(dest)).equals(PAYLOAD)).toBe(true);

    // The (single) request carried a Range header starting at the .part size,
    // and the server served the remainder as a 206.
    expect(fixture.requests.at(-1)?.range).toBe(`bytes=${partSize}-`);
  });

  it('recovers on a re-run after a mid-stream disconnect', async () => {
    fixture.cutAfter = 80_000; // drop the first attempt partway through.
    await expect(
      downloadFile({ url: fixture.url, dest, expectedSha256: SHA }),
    ).rejects.toBeTruthy();

    // A subsequent attempt (with the server healthy) completes correctly,
    // whether or not a .part survived the reset.
    fixture.cutAfter = undefined;
    const result = await downloadFile({ url: fixture.url, dest, expectedSha256: SHA });
    expect(result.sha256).toBe(SHA);
    expect((await readFile(dest)).equals(PAYLOAD)).toBe(true);
  });

  it('honors an AbortSignal mid-stream: the streaming loop stops and does not finalize', async () => {
    // Deterministic two-chunk body via an injected fetch that ignores the signal
    // itself, so ONLY the download loop's `signal.aborted` check can stop it.
    // Abort fires after the first chunk is processed → the next loop iteration
    // throws before the file is renamed into place.
    const controller = new AbortController();
    const chunks = [PAYLOAD.subarray(0, 50_000), PAYLOAD.subarray(50_000)];
    let idx = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        const chunk = chunks[idx++];
        if (chunk !== undefined) ctrl.enqueue(chunk);
        else ctrl.close();
      },
    });
    const fetchImpl = (async () =>
      new Response(body, {
        status: 200,
        headers: {
          'content-length': String(PAYLOAD.length),
          'accept-ranges': 'bytes',
        },
      })) as unknown as typeof fetch;

    let sawBytes = false;
    await expect(
      downloadFile({
        url: fixture.url,
        dest,
        expectedSha256: SHA,
        signal: controller.signal,
        fetchImpl,
        progressIntervalMs: 0,
        // Abort once real bytes have landed (skip the initial received:0 emit).
        onProgress: (p) => {
          if (p.received > 0) {
            sawBytes = true;
            controller.abort();
          }
        },
      }),
    ).rejects.toThrow(/abort/i);

    // The loop processed a chunk (so it truly aborted mid-stream, not pre-flight)
    // and never finalized the destination — the transfer did not complete.
    expect(sawBytes).toBe(true);
    expect(existsSync(dest)).toBe(false);
  });

  it('a pre-flight aborted signal stops the transfer before finalizing', async () => {
    // An already-aborted signal: fetch itself rejects (real fetch honors it), so
    // no destination file is produced.
    const controller = new AbortController();
    controller.abort();
    await expect(
      downloadFile({ url: fixture.url, dest, expectedSha256: SHA, signal: controller.signal }),
    ).rejects.toBeTruthy();
    expect(existsSync(dest)).toBe(false);
  });

  it('is idempotent: a verified destination skips the transfer', async () => {
    await downloadFile({ url: fixture.url, dest, expectedSha256: SHA });
    const before = fixture.requests.length;
    const result = await downloadFile({ url: fixture.url, dest, expectedSha256: SHA });
    expect(result.cached).toBe(true);
    // No new HTTP request was made.
    expect(fixture.requests.length).toBe(before);
  });
});
