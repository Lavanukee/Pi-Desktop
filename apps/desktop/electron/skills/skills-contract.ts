/**
 * Skills IPC contract — the connectors screen's Skills tab lists the bundled
 * catalog and installs/removes skills into the pi agent skills dir. The
 * main-process handler (./skills-main.ts) owns `~/.pi/agent/skills/<id>/`,
 * copying from the app's bundled resources (extraResources / dev repo path).
 *
 * `BundledSkill` is a TYPE-ONLY import from the pure registry, so the
 * renderer/preload never bundle the node-touching handler — only the erased
 * shape crosses the boundary. Composed into ../ipc-contract.ts.
 */
import type { BundledSkill } from './skills-registry';

/** A catalog entry annotated with whether it is installed in the agent dir. */
export interface SkillListItem extends BundledSkill {
  installed: boolean;
}

export type SkillsInvokeMap = {
  /** The bundled catalog, each annotated with its installed state. */
  'skills:list': { request: undefined; response: { skills: SkillListItem[] } };
  /** Copy a bundled skill's folder into ~/.pi/agent/skills/<id> (idempotent
   * overwrite). Returns the refreshed list + an error string on failure. */
  'skills:install': {
    request: { id: string };
    response: { skills: SkillListItem[]; error?: string };
  };
  /** Remove an installed skill's folder from the agent dir. */
  'skills:remove': {
    request: { id: string };
    response: { skills: SkillListItem[]; error?: string };
  };
};

export const SKILLS_INVOKE_CHANNELS = [
  'skills:list',
  'skills:install',
  'skills:remove',
] as const satisfies readonly (keyof SkillsInvokeMap)[];
