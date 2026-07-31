/**
 * "Something produced an image the model could not see" — a one-bit want, set
 * where the image is made and acted on at a turn boundary.
 *
 * WHY IT IS NOT ACTED ON IMMEDIATELY. Going multimodal is a hard RESTART of
 * llama-server. Firing it the moment a browser screenshot is captured would kill
 * the very turn that captured it — the model would lose its work and, from the
 * user's side, the turn would simply die. So the capture records the want and the
 * turn boundary spends it.
 *
 * WHY IT EXISTS AT ALL. `ensureVisionMode()` in the renderer is reached only via
 * `messageNeedsVision({ imageDataUris })`, which sees images the USER attaches in
 * the composer. An image the MODEL produces — a screenshot, a rendered frame, an
 * image it just generated — never passes that check, so vision was never
 * requested for exactly the cases an agent needs it (LIVE-TEST-FINDINGS.md §2).
 */

let wanted = false;

/** Record that an image was produced while the server could not read images. */
export function wantVision(): void {
  wanted = true;
}

/** Take the want (and clear it). True at most once per set. */
export function takeVisionWant(): boolean {
  const w = wanted;
  wanted = false;
  return w;
}

/** Test seam. */
export function resetVisionWant(): void {
  wanted = false;
}
