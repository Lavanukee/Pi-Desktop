/**
 * Bundled-skills registry. Mirrors the house style of
 * packages/mcp-lite's KNOWN_CONNECTORS: a typed `readonly` array of const
 * literals + a BY_ID map + small lookup helpers, kept PURE (no node/electron
 * imports) so it is unit-testable and safe to type-import from the renderer.
 *
 * A pi "skill" is a folder holding a `SKILL.md` playbook the pi engine
 * auto-discovers under `~/.pi/agent/skills/<id>/`. Each entry here points at a
 * bundled source folder shipped in the app resources (see
 * apps/desktop/resources/skills/<id>/ + electron-builder.yml extraResources).
 * Installing a skill copies that folder into the agent dir (skills-main.ts),
 * the exact cpSync mechanism the Codex importer already uses (import-main.ts).
 *
 * Provenance is explicit and permissive:
 *   - Apache-2.0 skills are vendored verbatim from github.com/anthropics/skills
 *     (each keeps its upstream LICENSE.txt); see resources/skills/ATTRIBUTION.md.
 *   - MIT skills are authored in-house for Pi Desktop (same license as the app).
 * No bundled skill carries secrets or makes network calls just to load.
 */

/** Redistributable licenses a bundled skill may carry. */
export type SkillLicense = 'Apache-2.0' | 'MIT';

/** Where a bundled skill came from. */
export type SkillSource = 'anthropics/skills' | 'pi-desktop';

/** Loose grouping for the Skills tab (kept free-form, not a UI contract). */
export type SkillCategory =
  | 'authoring'
  | 'dev'
  | 'data'
  | 'research'
  | 'documents'
  | 'productivity';

/** One skill Pi Desktop ships and can install into the agent skills dir. */
export interface BundledSkill {
  /** Stable id === the bundled folder name === the installed folder name. */
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  license: SkillLicense;
  /** Upstream project (attribution). */
  source: SkillSource;
  /** Human-facing source URL (empty for in-house). */
  homepage?: string;
  /** Preselect in first-run / recommended flows (none by default — opt-in). */
  recommended?: boolean;
}

/**
 * The bundled catalog. IDs MUST match a folder under
 * apps/desktop/resources/skills/<id>/ containing a SKILL.md
 * (skills-registry.test.ts enforces this).
 */
export const BUNDLED_SKILLS: readonly BundledSkill[] = [
  // ── Apache-2.0, vendored from anthropics/skills (with LICENSE.txt) ──────────
  {
    id: 'doc-coauthoring',
    name: 'Doc co-authoring',
    description:
      'A structured workflow for co-authoring docs, proposals, specs, and decision docs.',
    category: 'documents',
    license: 'Apache-2.0',
    source: 'anthropics/skills',
    homepage: 'https://github.com/anthropics/skills/tree/main/skills/doc-coauthoring',
    recommended: true,
  },
  {
    id: 'mcp-builder',
    name: 'MCP builder',
    description:
      'Guide + scaffolding for building high-quality MCP servers (Python FastMCP or Node TS SDK).',
    category: 'dev',
    license: 'Apache-2.0',
    source: 'anthropics/skills',
    homepage: 'https://github.com/anthropics/skills/tree/main/skills/mcp-builder',
  },
  {
    id: 'webapp-testing',
    name: 'Web app testing',
    description:
      'Drive and test local web apps with Playwright: verify UI, capture screenshots, read logs.',
    category: 'dev',
    license: 'Apache-2.0',
    source: 'anthropics/skills',
    homepage: 'https://github.com/anthropics/skills/tree/main/skills/webapp-testing',
  },
  {
    id: 'internal-comms',
    name: 'Internal comms',
    description: 'Write internal communications — status reports, updates, FAQs, incident reports.',
    category: 'productivity',
    license: 'Apache-2.0',
    source: 'anthropics/skills',
    homepage: 'https://github.com/anthropics/skills/tree/main/skills/internal-comms',
  },

  // ── MIT, authored in-house for Pi Desktop ───────────────────────────────────
  {
    id: 'code-review',
    name: 'Code review',
    description:
      'Review a diff for correctness bugs and reuse / simplification cleanups; effort-tiered.',
    category: 'dev',
    license: 'MIT',
    source: 'pi-desktop',
    recommended: true,
  },
  {
    id: 'git-workflow',
    name: 'Git workflow',
    description:
      'Safe, conventional git: branch, commit, PR, rebase vs merge, and recover from mistakes.',
    category: 'dev',
    license: 'MIT',
    source: 'pi-desktop',
    recommended: true,
  },
  {
    id: 'debugging',
    name: 'Debugging',
    description: 'Reproduce → isolate → hypothesis-test → fix the root cause → verify.',
    category: 'dev',
    license: 'MIT',
    source: 'pi-desktop',
  },
  {
    id: 'data-analysis',
    name: 'Data analysis',
    description: 'Explore, clean, aggregate, and summarize tabular data with pandas.',
    category: 'data',
    license: 'MIT',
    source: 'pi-desktop',
  },
  {
    id: 'spreadsheet-toolkit',
    name: 'Spreadsheet toolkit',
    description: 'Read, edit, format, and analyze .xlsx / .csv with openpyxl and pandas.',
    category: 'data',
    license: 'MIT',
    source: 'pi-desktop',
  },
  {
    id: 'pdf-toolkit',
    name: 'PDF toolkit',
    description: 'Extract, split, merge, fill, and OCR PDFs with pypdf / pdfplumber.',
    category: 'documents',
    license: 'MIT',
    source: 'pi-desktop',
  },
  {
    id: 'web-research',
    name: 'Web research',
    description:
      'Fan-out search, vet primary sources, cross-check claims, and synthesize a cited answer.',
    category: 'research',
    license: 'MIT',
    source: 'pi-desktop',
    recommended: true,
  },
  {
    id: 'writing-docs',
    name: 'Writing docs',
    description: 'Write clear READMEs, how-tos, API references, and tutorials (Diátaxis).',
    category: 'documents',
    license: 'MIT',
    source: 'pi-desktop',
  },
] as const;

/** Lookup a bundled skill by id. */
export const BUNDLED_SKILLS_BY_ID: Record<string, BundledSkill> = Object.fromEntries(
  BUNDLED_SKILLS.map((s) => [s.id, s]),
);

/** Resolve a bundled skill by id (undefined when unknown). */
export function getBundledSkill(id: string): BundledSkill | undefined {
  return BUNDLED_SKILLS_BY_ID[id];
}

/** True when `id` is a single safe path segment (no traversal / hidden dir).
 * Skill ids are also folder names, so this fences the copy/remove targets. */
export function isSafeSkillId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id) && !id.includes('..');
}
