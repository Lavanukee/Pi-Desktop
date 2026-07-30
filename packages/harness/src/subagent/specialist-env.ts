/**
 * A specialist child's tool set — pinned, exact, and nothing else.
 *
 * jedd: "the model should be able to spawn a subagent that can do any of these
 * as specialist workflows, with just these tools loaded, those subagents are
 * only for that purpose, we aren't putting any of this as 'capability suites'."
 *
 * THE FIRST ATTEMPT ROUTED THROUGH CAPABILITIES and that was wrong. It told the
 * child, in prose, to call `capability("generation")` before starting — which
 * spends a turn, can be ignored, activates a whole group when the role wants four
 * tools out of it, and leaves the child holding the generic preset besides. A
 * specialist is not a chat that might need some tools; it is a process that
 * exists to do exactly one job.
 *
 * So the kind rides an env var to the child, and its harness sets the active
 * tools to precisely {@link specialistToolsFor} — replacing the preset rather
 * than unioning onto it. There is no discovery step and nothing to activate.
 *
 * Env rather than a bridge field because that is the seam the child launcher
 * already has (see apps/desktop/electron/pi/pi-main.ts `createChildBridge`,
 * which is also how subagent DEPTH is passed).
 */

import { MESH_SPECIALIST_KINDS, specialistToolsFor } from '../corp/corp-mesh.js';

/** Names the specialist a child pi is running as. Empty/absent → a normal child. */
export const SPECIALIST_ENV = 'PI_DESKTOP_SPECIALIST';

/** Read the kind off the environment, rejecting anything we have no charter for. */
export function specialistFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env[SPECIALIST_ENV];
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim().toLowerCase();
  return (MESH_SPECIALIST_KINDS as readonly string[]).find((k) => k === key);
}

/**
 * The EXACT tools a specialist child should have.
 *
 * Filtered to what this build actually registered — naming a tool that does not
 * exist would have the child call into nothing — and kept in the charter's own
 * order so the most-used tool for the role leads the list.
 *
 * Returns an empty array when none of them exist, which the caller must treat as
 * "leave the preset alone": pinning a specialist to zero tools would produce an
 * agent that can do nothing at all, which is worse than a generic one.
 */
export function specialistToolset(kind: string, available: readonly string[]): string[] {
  const have = new Set(available);
  return specialistToolsFor(kind).filter((t) => have.has(t));
}
