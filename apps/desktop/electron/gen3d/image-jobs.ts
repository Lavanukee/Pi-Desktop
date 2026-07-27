/**
 * Awaiting an image job — the electron-free half of the chat's image tools.
 *
 * The studio panels are event-driven (fire a generate, watch `gen3d:job`
 * broadcasts), but a TOOL CALL is request/response: it must await exactly one
 * image and get back either a path or a reason. This tracker turns the sidecar's
 * job event stream into that promise, with no polling.
 *
 * Two orderings have to work, because the `/generate` POST response and the
 * `/events` stream are independent:
 *   - the normal one — waiter registered, then artifact, then done;
 *   - the race — a job finishes before its caller learns the jobId, so the
 *     artifact and/or the terminal outcome arrive with no waiter yet. Both are
 *     remembered (boundedly) and claimed when the waiter shows up.
 *
 * Kept out of gen3d-main.ts so it can be unit-tested: electron/ tests may not
 * import the real `electron`, which gen3d-main does.
 */

export type ImageJobResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

/** The fields of a `JobUpdate` this tracker cares about. */
export interface ImageJobProgress {
  readonly jobId: string;
  readonly artifact?: { readonly kind: string; readonly path: string };
  readonly done: boolean;
  readonly error?: string;
}

/** How many finished-but-unclaimed jobs to remember. Only ever needs to cover
 * the microscopic window between a job ending and its waiter registering. */
const MEMORY = 8;

function evict<V>(map: Map<string, V>): void {
  while (map.size > MEMORY) {
    const oldest = map.keys().next();
    if (oldest.done === true) return;
    map.delete(oldest.value);
  }
}

export class ImageJobTracker {
  private readonly waiters = new Map<string, (r: ImageJobResult) => void>();
  /** jobId → image path, for artifacts seen before their waiter existed. */
  private readonly artifacts = new Map<string, string>();
  /** jobId → outcome, for jobs that finished before their waiter existed. */
  private readonly outcomes = new Map<string, ImageJobResult>();

  /** Fold one job update in, settling the waiter when the job ends. */
  note(update: ImageJobProgress): void {
    if (update.artifact?.kind === 'image' && update.artifact.path !== '') {
      this.artifacts.set(update.jobId, update.artifact.path);
      evict(this.artifacts);
    }
    if (!update.done) return;
    const path = this.artifacts.get(update.jobId);
    this.artifacts.delete(update.jobId);
    const result: ImageJobResult =
      update.error !== undefined && update.error !== ''
        ? { ok: false, error: update.error }
        : path !== undefined
          ? { ok: true, path }
          : { ok: false, error: 'the engine finished without producing an image' };
    const settle = this.waiters.get(update.jobId);
    if (settle !== undefined) {
      this.waiters.delete(update.jobId);
      settle(result);
      return;
    }
    this.outcomes.set(update.jobId, result);
    evict(this.outcomes);
  }

  /**
   * Resolve when the job ends — or with a timeout reason, so a caller can never
   * hang forever on an engine that stopped reporting.
   */
  wait(jobId: string, timeoutMs: number): Promise<ImageJobResult> {
    const already = this.outcomes.get(jobId);
    if (already !== undefined) {
      this.outcomes.delete(jobId);
      return Promise.resolve(already);
    }
    return new Promise<ImageJobResult>((resolve) => {
      let settled = false;
      const settle = (r: ImageJobResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(jobId);
        resolve(r);
      };
      const timer = setTimeout(() => {
        // Leave the engine alone — cancelling mid-model-load costs more than it
        // saves — but stop waiting, and say so.
        settle({
          ok: false,
          error: `the image job did not finish within ${Math.round(timeoutMs / 1000)}s`,
        });
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(jobId, settle);
    });
  }

  /** Test/lifecycle hook. */
  get pending(): number {
    return this.waiters.size;
  }
}
