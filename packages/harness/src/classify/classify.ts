/**
 * Tier-1 task classifier (heuristics-only, pure, <1ms).
 *
 * Given a user prompt + attachments + light conversation state, decide which
 * harness toolset preset to load. The result is one of two tiers
 * (`simple-QA` | `basic-tools`) or a category preset
 * (`browser-use` | `file-ops` | `coding` | `motion-graphics` |
 * `advanced-video` | `3d` | `2d-art` | `other`).
 *
 * Design (plan §F): heuristics-first with a clean, optional tier-2 escalation
 * seam. Tier 2 (a utility-model classifier) is injectable via
 * {@link classifyWithEscalation}; it is NEVER required — the default path is
 * pure heuristics so classification works with zero model headroom.
 */

/** The complexity tiers. */
export type TaskTier = 'simple-QA' | 'basic-tools';

/** The specialized category presets. `other` → tool-search-only. */
export type TaskCategory =
  | 'browser-use'
  | 'file-ops'
  | 'coding'
  | 'motion-graphics'
  | 'advanced-video'
  | '3d'
  | '2d-art'
  | 'other';

/** A classification result: a tier or a category. */
export type TaskClass = TaskTier | TaskCategory;

export const TASK_TIERS: readonly TaskTier[] = ['simple-QA', 'basic-tools'];
export const TASK_CATEGORIES: readonly TaskCategory[] = [
  'browser-use',
  'file-ops',
  'coding',
  'motion-graphics',
  'advanced-video',
  '3d',
  '2d-art',
  'other',
];
export const TASK_CLASSES: readonly TaskClass[] = [...TASK_TIERS, ...TASK_CATEGORIES];

/** A prompt attachment (image, file, skill, etc.) surfaced to the classifier. */
export interface Attachment {
  /** Original file name, if known. */
  readonly name?: string;
  /** MIME type, if known. */
  readonly mimeType?: string;
}

/** A minimal chat message used to share the live conversation prefix (below). */
export interface ClassifyMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ClassifyInput {
  /** The user prompt text (after expansion). */
  readonly prompt: string;
  /** Attachments dropped onto / referenced by the prompt. */
  readonly attachments?: readonly Attachment[];
  /** True if the prompt carries inline images. */
  readonly hasImages?: boolean;
  /** The class chosen for the previous turn, if the conversation is ongoing. */
  readonly priorClass?: TaskClass;
  /** 0-based turn index within the session. */
  readonly turnIndex?: number;
  /**
   * The live conversation so far (system + prior user/assistant turns, ending
   * with the current user prompt). Used ONLY by the tier-2 piggyback so it can
   * share the exact conversation prefix with the main model and reuse the
   * single-slot llama-server's KV cache (round-10 #8). The pure tier-1 heuristic
   * ignores this field entirely.
   */
  readonly priorMessages?: readonly ClassifyMessage[];
}

export interface ClassifyResult {
  /** The chosen class. */
  readonly class: TaskClass;
  /** Heuristic confidence in [0,1]. */
  readonly confidence: number;
  /** Human-readable signals that fired, for debugging + the tier-2 seam. */
  readonly signals: readonly string[];
  /** True when confidence is low enough that a tier-2 model should double-check. */
  readonly ambiguous: boolean;
  /**
   * A short conversation title, produced ONLY by the tier-2 `{title, class}`
   * piggyback (never by tier-1 heuristics). The harness emits it over the status
   * channel for the app to display. Absent on the pure heuristic path.
   */
  readonly title?: string;
}

interface CategoryRule {
  readonly category: TaskCategory;
  /** [regex, weight] pairs. weight 2 = decisive, 1 = generic. */
  readonly patterns: readonly (readonly [RegExp, number])[];
}

// Category ordering also breaks score ties (earlier wins).
const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: 'browser-use',
    patterns: [
      [/\bbrowser\b/, 2],
      [/\bscrape\b/, 2],
      [/\bweb ?page\b/, 2],
      [/\bnavigate to\b/, 2],
      [/\bhttps?:\/\//, 2],
      [/\blog ?in to\b/, 2],
      [/\bfill (out|in)\b.*\bform\b/, 2],
      [/\bclick (on )?the\b/, 2],
      [/\b(the |this |that )?website\b/, 1],
      [/\bweb search\b.*\bsite\b/, 1],
    ],
  },
  {
    category: '3d',
    patterns: [
      [/\bblender\b/, 2],
      [/\bmesh(es)?\b/, 2],
      [/\.glb\b/, 2],
      [/\.obj\b/, 2],
      [/\bhunyuan3d\b/, 2],
      [/\btrellis\b/, 2],
      [/\bsculpt\b/, 2],
      [/\b3-?d\b/, 1],
      [/\btexture map\b/, 1],
      [/\b(model|render) a .*(scene|character|object)\b/, 1],
    ],
  },
  {
    category: 'motion-graphics',
    patterns: [
      [/\bmotion graphics?\b/, 2],
      [/\bkeyframe\b/, 2],
      [/\bafter effects\b/, 2],
      [/\blottie\b/, 2],
      [/\banimated (logo|text|intro|title)\b/, 2],
      [/\banimate\b/, 1],
      [/\banimation\b/, 1],
      [/\btransition\b/, 1],
    ],
  },
  {
    category: 'advanced-video',
    patterns: [
      [/\bvideo editing\b/, 2],
      [/\bfootage\b/, 2],
      [/\bltx\b/, 2],
      [/\.mp4\b/, 2],
      [/\brender (a |the )?(video|film|movie)\b/, 2],
      [/\bvideo\b/, 1],
      [/\bfilm\b/, 1],
      [/\bmovie clip\b/, 1],
    ],
  },
  {
    category: '2d-art',
    patterns: [
      [/\billustration\b/, 2],
      [/\bpainting\b/, 2],
      [/\bsketch\b/, 2],
      [/\bwallpaper\b/, 2],
      [/\bposter\b/, 2],
      [/\b(generate|create|make|draw) (me )?(an? )?(image|picture|logo|icon|artwork)\b/, 2],
      [/\bdesign (me )?(an? )?(logo|icon|poster|banner|image|artwork)\b/, 2],
      [/\bpicture of\b/, 2],
      [/\bdraw\b/, 1],
      [/\bpaint\b/, 1],
      [/\blogo\b/, 1],
      [/\bicon\b/, 1],
    ],
  },
  {
    category: 'coding',
    patterns: [
      [/\brefactor\b/, 2],
      [/\bdebug\b/, 2],
      [/\bstack trace\b/, 2],
      [/\bcompile\b/, 2],
      [/\bnpm\b/, 2],
      [/\bgit\b/, 2],
      [/\brepository\b/, 2],
      [/\brepo\b/, 2],
      [/\bunit test\b/, 2],
      [/\btest suite\b/, 2],
      [/\bbug\b/, 2],
      [/\bcodebase\b/, 2],
      [/\b(typescript|javascript|python|rust|golang|c\+\+)\b/, 1],
      [/\bfunction\b/, 1],
      [/\bimplement\b/, 1],
      [/\bscript\b/, 1],
      [/\bcode\b/, 1],
      [/\bprogram\b/, 1],
      [/\bapi endpoint\b/, 1],
    ],
  },
  {
    category: 'file-ops',
    patterns: [
      [/\bbatch rename\b/, 2],
      [
        /\b(rename|organize|sort|move|copy|delete) .*\b(files|folders?|photos|images|documents)\b/,
        2,
      ],
      [/\bfile system\b/, 2],
      [/\bdirectory of\b/, 2],
      [/\bfolder of\b/, 2],
      [/\b\.csv files\b/, 2],
      [/\brename\b/, 1],
      [/\borganize\b/, 1],
      [/\bfolder\b/, 1],
    ],
  },
  {
    category: 'other',
    patterns: [
      [/\bconnector\b/, 2],
      [/\bmcp server\b/, 2],
      [/\bintegration\b/, 2],
      [/\bnotion\b/, 2],
      [/\bslack\b/, 2],
      [/\bjira\b/, 2],
      [/\b(google )?calendar\b/, 2],
      [/\bspreadsheet\b/, 2],
      [/\bexcel\b/, 2],
      [/\bplugin\b/, 1],
    ],
  },
];

const CATEGORY_THRESHOLD = 2;

// Tier-2 (basic-tools): needs python / web-search / fetch, but no dominant category.
const BASIC_TOOL_PATTERNS: readonly RegExp[] = [
  /\bsearch (the web|online|for)\b/,
  /\blook up\b/,
  /\bgoogle\b/,
  /\blatest\b/,
  /\bcurrent\b/,
  /\btoday'?s?\b/,
  /\bweather\b/,
  /\bnews\b/,
  /\bstock price\b/,
  /\bexchange rate\b/,
  /\bfetch\b/,
  /\bcalculate\b/,
  /\bcompute\b/,
  /\bconvert\b/,
  /\bfind out\b/,
  /\bhow much is\b/,
];

// Tier-1 (simple-QA): knowledge questions with no tool need.
const QUESTION_START =
  /^(what|who|whom|whose|when|where|why|which|how|is|are|am|do|does|did|can|could|would|should|explain|define|describe|tell me|summarize|summarise|difference between)\b/;

// Imperative verbs implying multi-step agentic work.
const AGENTIC_PATTERNS: readonly RegExp[] = [
  /\bbuild\b/,
  /\bcreate\b/,
  /\bset up\b/,
  /\bmake (me )?an? (app|project|tool|website|game)\b/,
  /\bdeploy\b/,
  /\bautomate\b/,
  /\bscaffold\b/,
  /\bimplement\b/,
  /\bdo (all|each) of the following\b/,
  /\bthen\b.*\band\b/,
];

const SIMPLE_QA_MAX_LEN = 240;

function scoreCategories(
  text: string,
): { category: TaskCategory; score: number; hits: string[] }[] {
  const results: { category: TaskCategory; score: number; hits: string[] }[] = [];
  for (const rule of CATEGORY_RULES) {
    let score = 0;
    const hits: string[] = [];
    for (const [pattern, weight] of rule.patterns) {
      if (pattern.test(text)) {
        score += weight;
        hits.push(`${rule.category}:${pattern.source}`);
      }
    }
    if (score > 0) results.push({ category: rule.category, score, hits });
  }
  // Stable sort: higher score first; CATEGORY_RULES order breaks ties.
  return results
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
    .map(({ r }) => r);
}

function countMatches(text: string, patterns: readonly RegExp[]): string[] {
  const hits: string[] = [];
  for (const p of patterns) {
    if (p.test(text)) hits.push(p.source);
  }
  return hits;
}

/**
 * Tier-1 heuristic classification. Pure, deterministic, allocation-light.
 */
export function classify(input: ClassifyInput): ClassifyResult {
  const trimmed = input.prompt.trim();
  const text = ` ${trimmed.toLowerCase()} `;
  const signals: string[] = [];

  // 0. Conversation continuity: a terse follow-up inherits the prior class.
  if (
    input.priorClass !== undefined &&
    (input.turnIndex ?? 0) > 0 &&
    trimmed.length < 20 &&
    /^(continue|go on|keep going|yes|do it|proceed|next|carry on|and\b)/i.test(trimmed)
  ) {
    return {
      class: input.priorClass,
      confidence: 0.85,
      signals: ['continuation'],
      ambiguous: false,
    };
  }

  // 1. Attachments are a strong steer toward a modality.
  const attachmentCategory = classifyAttachments(input);
  if (attachmentCategory) {
    signals.push(`attachment:${attachmentCategory}`);
  }

  // 2. Category scoring over the prompt text.
  const scored = scoreCategories(text);
  const top = scored[0];

  // An attachment category reinforces (or supplies) the category decision.
  if (attachmentCategory) {
    const matching = scored.find((s) => s.category === attachmentCategory);
    const boosted = (matching?.score ?? 0) + 2;
    if (boosted >= CATEGORY_THRESHOLD) {
      const conf = clamp01(0.55 + boosted * 0.1);
      return {
        class: attachmentCategory,
        confidence: conf,
        signals: [...signals, ...(matching?.hits ?? [])],
        ambiguous: conf < 0.6,
      };
    }
  }

  if (top && top.score >= CATEGORY_THRESHOLD) {
    signals.push(...top.hits);
    const runnerUp = scored[1];
    // Ambiguous when a second category is within one point of the winner.
    const close = runnerUp !== undefined && top.score - runnerUp.score <= 1;
    const confidence = clamp01(0.5 + top.score * 0.12 - (close ? 0.15 : 0));
    return { class: top.category, confidence, signals, ambiguous: close || confidence < 0.6 };
  }

  // 3. No dominant category → tier logic.
  const basicHits = countMatches(text, BASIC_TOOL_PATTERNS);
  const agenticHits = countMatches(text, AGENTIC_PATTERNS);
  const isQuestion = QUESTION_START.test(input.prompt.toLowerCase().trim());
  const short = input.prompt.trim().length <= SIMPLE_QA_MAX_LEN;

  // basic-tools: an explicit lookup/compute/fetch need with no big agentic build.
  if (basicHits.length > 0 && agenticHits.length === 0) {
    signals.push(...basicHits.map((h) => `basic:${h}`));
    const confidence = clamp01(0.5 + basicHits.length * 0.12);
    return { class: 'basic-tools', confidence, signals, ambiguous: confidence < 0.6 };
  }

  // simple-QA: a short knowledge question, no tools, no attachments.
  if (
    isQuestion &&
    short &&
    agenticHits.length === 0 &&
    !input.hasImages &&
    (input.attachments === undefined || input.attachments.length === 0)
  ) {
    signals.push('question-form');
    // Weak category hints (score 1) make it a touch ambiguous.
    const weakCategory = top !== undefined && top.score > 0;
    const confidence = clamp01(weakCategory ? 0.6 : 0.72);
    return { class: 'simple-QA', confidence, signals, ambiguous: confidence < 0.6 };
  }

  // Fallback: complex / multi-step agentic work with no dominant modality. The
  // `full-shebang` everything-tier was removed (round-10 #7); fall back among the
  // kept classes. Light tool signals (agentic build verbs, or a lookup/compute
  // need) → `basic-tools` (python + web); the always-active tool_search pulls in
  // read/write/edit/bash on demand. No signal at all → tool-search-only `other`.
  signals.push(...agenticHits.map((h) => `agentic:${h}`));
  const hasToolSignal = agenticHits.length > 0 || basicHits.length > 0;
  if (!hasToolSignal) signals.push('fallback');
  const cls: TaskClass = hasToolSignal ? 'basic-tools' : 'other';
  const confidence = clamp01(0.45 + agenticHits.length * 0.12);
  return { class: cls, confidence, signals, ambiguous: confidence < 0.6 };
}

function classifyAttachments(input: ClassifyInput): TaskCategory | undefined {
  const atts = input.attachments ?? [];
  for (const a of atts) {
    const name = (a.name ?? '').toLowerCase();
    const mime = (a.mimeType ?? '').toLowerCase();
    if (mime.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/.test(name)) return 'advanced-video';
    if (/\.(glb|gltf|obj|fbx|stl|blend)$/.test(name)) return '3d';
    if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/.test(name)) return '2d-art';
    if (/\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|rb|json|toml|yaml|yml)$/.test(name)) return 'coding';
    if (/\.(csv|xlsx?|tsv)$/.test(name)) return 'file-ops';
  }
  // Inline images without a specialized file → treat as 2d-art context.
  if (input.hasImages && atts.length === 0) return '2d-art';
  return undefined;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// --- Tier-2 escalation seam ------------------------------------------------

/**
 * Optional tier-2 classifier. Receives the tier-1 result so a utility model can
 * confirm or correct it. Returns a refined result, or `undefined` to keep tier 1.
 *
 * This is a clean injectable seam — the harness NEVER requires a live model.
 */
export type AsyncClassifier = (
  input: ClassifyInput,
  tier1: ClassifyResult,
) => Promise<ClassifyResult | undefined>;

export interface ClassifyOptions {
  /** Injected tier-2 classifier (e.g. Gemma4 E2B). Omitted → heuristics only. */
  readonly asyncClassifier?: AsyncClassifier;
  /** Only escalate to tier 2 when tier 1 is ambiguous. Default true. */
  readonly escalateOnlyWhenAmbiguous?: boolean;
  /**
   * Force the tier-2 piggyback even when tier-1 is confident — e.g. the FIRST
   * turn needs a conversation `title` regardless of how clear the class is. When
   * forced on a turn tier-1 was already confident about, the fast heuristic's
   * CLASS is kept (the model isn't second-guessing a clear class) but the
   * model's `title` is carried through. Default false.
   */
  readonly forceEscalate?: boolean;
}

/**
 * Run tier-1 heuristics, then optionally escalate to an injected tier-2 model.
 * Falls back to the tier-1 result on any tier-2 error or absence.
 */
export async function classifyWithEscalation(
  input: ClassifyInput,
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const tier1 = classify(input);
  const { asyncClassifier, escalateOnlyWhenAmbiguous = true, forceEscalate = false } = opts;
  if (asyncClassifier === undefined) return tier1;
  const shouldEscalate = tier1.ambiguous || forceEscalate;
  if (escalateOnlyWhenAmbiguous && !shouldEscalate) return tier1;
  try {
    const tier2 = await asyncClassifier(input, tier1);
    if (tier2 === undefined) return tier1;
    // Forced only for the title on an already-confident turn → keep the fast
    // heuristic class, but surface the model's title.
    if (!tier1.ambiguous && forceEscalate) {
      return tier2.title !== undefined ? { ...tier1, title: tier2.title } : tier1;
    }
    return tier2;
  } catch {
    return tier1;
  }
}
