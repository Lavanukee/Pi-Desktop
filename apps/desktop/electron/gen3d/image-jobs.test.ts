import { describe, expect, it, vi } from 'vitest';
import { ImageJobTracker } from './image-jobs';

const artifact = (path: string) => ({ kind: 'image' as const, path });

describe('ImageJobTracker', () => {
  it('resolves with the image path the job produced', async () => {
    const t = new ImageJobTracker();
    const pending = t.wait('j1', 60_000);
    // The worker emits the artifact BEFORE the job ends — both events matter.
    t.note({ jobId: 'j1', artifact: artifact('/out/prompt-image.png'), done: false });
    t.note({ jobId: 'j1', done: true });
    await expect(pending).resolves.toEqual({ ok: true, path: '/out/prompt-image.png' });
    expect(t.pending).toBe(0);
  });

  it('resolves with the engine error when the job fails', async () => {
    const t = new ImageJobTracker();
    const pending = t.wait('j1', 60_000);
    t.note({ jobId: 'j1', done: true, error: 'Mage-Flow is not installed yet' });
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'Mage-Flow is not installed yet',
    });
  });

  it('an error WINS over a stale artifact', async () => {
    const t = new ImageJobTracker();
    const pending = t.wait('j1', 60_000);
    t.note({ jobId: 'j1', artifact: artifact('/out/a.png'), done: false });
    t.note({ jobId: 'j1', done: true, error: 'cancelled' });
    await expect(pending).resolves.toEqual({ ok: false, error: 'cancelled' });
  });

  it('says so when a job ends with no image at all', async () => {
    const t = new ImageJobTracker();
    const pending = t.wait('j1', 60_000);
    t.note({ jobId: 'j1', done: true });
    const res = await pending;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('without producing an image');
  });

  it('claims an outcome that arrived BEFORE the waiter (the POST/events race)', async () => {
    const t = new ImageJobTracker();
    // Job finishes while the caller is still awaiting the /generate response.
    t.note({ jobId: 'j1', artifact: artifact('/out/fast.png'), done: false });
    t.note({ jobId: 'j1', done: true });
    await expect(t.wait('j1', 60_000)).resolves.toEqual({ ok: true, path: '/out/fast.png' });
    // Claimed once only — a second wait must not re-serve it (it would hang
    // instead, which is the honest behaviour for an unknown job).
    const second = t.wait('j1', 10);
    await vi.waitFor(async () => expect((await second).ok).toBe(false));
  });

  it('times out instead of hanging forever on a silent engine', async () => {
    vi.useFakeTimers();
    try {
      const t = new ImageJobTracker();
      const pending = t.wait('j1', 5_000);
      vi.advanceTimersByTime(5_001);
      const res = await pending;
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('did not finish within 5s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores other jobs and non-image artifacts', async () => {
    const t = new ImageJobTracker();
    const pending = t.wait('j1', 60_000);
    t.note({ jobId: 'other', artifact: artifact('/out/theirs.png'), done: true });
    // A 3D mesh artifact on OUR job is not the image we are waiting for.
    t.note({ jobId: 'j1', artifact: { kind: 'model-glb', path: '/out/mesh.glb' }, done: false });
    t.note({ jobId: 'j1', done: true });
    const res = await pending;
    expect(res.ok).toBe(false);
  });

  it('does not grow without bound when nobody claims outcomes', () => {
    const t = new ImageJobTracker();
    for (let i = 0; i < 50; i++) {
      t.note({ jobId: `j${i}`, artifact: artifact(`/out/${i}.png`), done: true });
    }
    // The oldest were evicted; the most recent is still claimable.
    expect(t.pending).toBe(0);
    void expect(t.wait('j49', 60_000)).resolves.toEqual({ ok: true, path: '/out/49.png' });
  });
});
