/**
 * THE FINAL CHECK — what "verify your work" has to mean to be worth anything.
 *
 * jedd, after a corp run shipped work it described in the same breath as broken:
 *
 *   "is it really actually going and prompting the model directly whenever anyone
 *   submits to 'visually verify work if applicable'… better yet determine at the
 *   very start of the task via a classifier if visual verification is going to be
 *   applicable and then per contract do the same, and then seed the prompt
 *   accordingly… asking for general things, list out every claim that was just
 *   made about the final product state and verify it completely, anything visual,
 *   look at it, anything functional, test it right now, any UI, drive it and make
 *   new tests right now and make sure they're green, utilize specialists if
 *   applicable at all, this is a final check."
 *
 * What was there before was a fixed six-line reminder, identical for every task
 * and every contract, whose second call was accepted unconditionally ("no further
 * checks, no refusals"). It had the engineer's own `summary` and `verification`
 * in hand and ignored both.
 *
 * THE PART THAT IS NOT PROMPT TEXT. {@link finalCheck} takes the claims the agent
 * JUST MADE and hands them back one per line, numbered, to be discharged. That is
 * mechanical — the harness quoting the model to itself — which matters because
 * prompt text has demonstrably stopped moving these behaviours. Run 6 listed four
 * `.svg` files that were not on disk and said the project "opens in Godot"
 * without ever running Godot, which was installed and named in its own briefing.
 * Both are claims, and a claim you must answer one by one is harder to leave
 * standing than an instruction you must remember to follow.
 */

/** What verifying actually MEANS for this piece of work. */
export interface VerificationProfile {
  /** There is something to LOOK at — it can be wrong while being valid. */
  readonly visual: boolean;
  /** There is something to RUN — output, exit code, behaviour. */
  readonly functional: boolean;
  /** There is something to DRIVE — a user moves through it. */
  readonly ui: boolean;
  /** A program the work needs in order to open or run at all, if one is named. */
  readonly runtime: string | null;
}

/** Words that mean somebody has to LOOK. A thing can build and still be wrong. */
const VISUAL_WORDS = [
  'game',
  'image',
  'picture',
  'photo',
  'icon',
  'sprite',
  'render',
  'animation',
  'video',
  'chart',
  'graph',
  'plot',
  'diagram',
  'design',
  'layout',
  'css',
  'style',
  'theme',
  'colour',
  'color',
  'screenshot',
  'visual',
  'slide',
  'poster',
  'logo',
  'ui',
  'screen',
  'page',
  'website',
  'web page',
  'pdf',
  '3d',
  'model',
  'scene',
];

/** Words that mean somebody has to RUN it and read what came back. */
const FUNCTIONAL_WORDS = [
  'script',
  'program',
  'tool',
  'cli',
  'command',
  'api',
  'endpoint',
  'server',
  'function',
  'algorithm',
  'parser',
  'converter',
  'calculate',
  'compute',
  'sort',
  'search',
  'test',
  'benchmark',
  'pipeline',
  'build',
  'compile',
  'game',
  'app',
  'application',
  'bot',
  'scraper',
];

/** Words that mean somebody has to DRIVE it — click, type, move, play. */
const UI_WORDS = [
  'ui',
  'interface',
  'button',
  'form',
  'menu',
  'dashboard',
  'app',
  'application',
  'website',
  'web page',
  'page',
  'game',
  'screen',
  'window',
  'click',
  'input',
  'keyboard',
  'controls',
  'player',
  'navigation',
  'editor',
];

/**
 * Programs a piece of work can be written FOR, and therefore cannot be verified
 * without. Ordered so the most specific match wins.
 */
const RUNTIMES: ReadonlyArray<{ readonly words: readonly string[]; readonly cmd: string }> = [
  { words: ['godot'], cmd: 'godot' },
  { words: ['unity'], cmd: 'unity' },
  { words: ['blender'], cmd: 'blender' },
  { words: ['rust', 'cargo'], cmd: 'cargo' },
  { words: ['python'], cmd: 'python3' },
  { words: ['node', 'npm', 'typescript', 'javascript'], cmd: 'node' },
  { words: ['ffmpeg'], cmd: 'ffmpeg' },
];

const hasAny = (text: string, words: readonly string[]): boolean =>
  words.some((w) => text.includes(w));

/**
 * Decide what verification this text implies — run on the TASK at the start of a
 * run, and again on each CONTRACT, because a contract to write a sprite sheet and
 * a contract to write a save-file parser need different proof even inside one
 * project.
 *
 * Deliberately deterministic rather than a model call: it runs on every contract,
 * a wrong answer here silently weakens every downstream check, and "does the word
 * 'game' appear" is not a judgement worth a turn on the one slot.
 */
export function classifyVerification(text: string): VerificationProfile {
  const t = text.toLowerCase();
  const runtime = RUNTIMES.find((r) => hasAny(t, r.words))?.cmd ?? null;
  return {
    visual: hasAny(t, VISUAL_WORDS),
    functional: hasAny(t, FUNCTIONAL_WORDS),
    ui: hasAny(t, UI_WORDS),
    runtime,
  };
}

/**
 * The line seeded into a role's brief AT THE START, so "verify it" already has a
 * meaning by the time the work is done rather than arriving as a surprise at
 * submission. Empty when the text implies nothing in particular — a briefing that
 * says nothing is worse than no briefing, because it teaches the role to skim.
 */
export function verificationBriefing(profile: VerificationProfile): string {
  const parts: string[] = [];
  if (profile.visual) parts.push('something to LOOK at');
  if (profile.functional) parts.push('something to RUN');
  if (profile.ui) parts.push('something to DRIVE');
  if (parts.length === 0) return '';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  const runtime =
    profile.runtime !== null
      ? ` It is written for \`${profile.runtime}\` — verifying it means running it THERE, so make sure that exists before you build.`
      : '';
  return `HOW THIS WORK GETS VERIFIED: there is ${list} here. That is what "check it works" has to mean on this job — not that it compiled, not that the file exists.${runtime}`;
}

/**
 * Split what an agent said into the individual CLAIMS it made.
 *
 * Bullets and numbered lines first (a small model reports in lists), then
 * sentences. Kept crude on purpose: the goal is not perfect claim extraction, it
 * is that the agent sees its own assertions enumerated and has to answer them one
 * at a time instead of re-reading a paragraph it already believes.
 */
export function extractClaims(...texts: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    if (text === undefined || text.trim() === '') continue;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim().replace(/^([-*•]|\d+[.)])\s*/, '');
      if (line === '') continue;
      // A heading ("## Status") asserts nothing; a sentence does.
      if (/^#{1,6}\s/.test(rawLine.trim())) continue;
      const pieces = line.split(/(?<=[.!?])\s+(?=[A-Z"'`])/);
      for (const piece of pieces) {
        const claim = piece.trim().replace(/\s+/g, ' ');
        // Too short to be an assertion ("Done", "✓") and not worth a line.
        if (claim.length < 12) continue;
        if (!out.includes(claim)) out.push(claim);
      }
    }
  }
  return out.slice(0, MAX_CLAIMS);
}

/** Enough to be thorough, few enough that the list still reads as a checklist. */
const MAX_CLAIMS = 12;

/** Whose eyes the check is done through. */
export type VerificationPerspective = 'engineer' | 'manager' | 'ceo';

/**
 * Who the reviewer is standing in for, and what question that makes them ask.
 *
 * jedd: "the manager and CEO should be given the whole shebang about how they are
 * looking from the point of view of the ceo (who gave the manager the vision) and
 * the ceo from the point of view of the user (who asked them for this) and are
 * going to really look and tell: did this work out in the end as requested."
 */
const PERSPECTIVE: Record<VerificationPerspective, { readonly who: string; readonly ask: string }> =
  {
    engineer: {
      who: 'Read this back as YOUR MANAGER will, who has to trust it without rebuilding it.',
      ask: 'Would this survive somebody else opening it?',
    },
    manager: {
      who: 'Read this back as THE CEO will — the person who gave you the vision and who has to answer to the user for it.',
      ask: 'Is this the thing the CEO described to you, or is it the thing that was easy to finish?',
    },
    ceo: {
      who: 'Read this back as THE USER will — the person who asked you for this, who has not seen any of the work, and who will judge it in ten seconds by whether it does what they wanted.',
      ask: 'Did this work out, in the end, as they asked? Not "is there a deliverable" — did it work out.',
    },
  };

/**
 * The final check itself: the agent's own claims, back at it, one per line, plus
 * exactly the kinds of proof this job admits.
 *
 * Never a bare "verify your work" — that is the instruction that has been in
 * place all along while runs shipped empty placeholders and files that did not
 * exist.
 */
export function finalCheck(opts: {
  readonly claims: readonly string[];
  readonly profile: VerificationProfile;
  readonly perspective: VerificationPerspective;
  /** The CEO's anchor: what the user actually asked for. */
  readonly vision?: string;
}): string {
  const { claims, profile, perspective } = opts;
  const p = PERSPECTIVE[perspective];
  const lines: string[] = ['THIS IS THE FINAL CHECK. Do it now, in this turn.', ''];

  if (claims.length > 0) {
    lines.push(
      'EVERY CLAIM YOU JUST MADE ABOUT THE FINISHED PRODUCT, listed back to you.',
      'Take them ONE AT A TIME and establish each is true — by doing the thing that',
      'would show it false, not by re-reading what you wrote:',
      '',
    );
    claims.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
    lines.push(
      '',
      'A claim you cannot demonstrate right now is not a finding to mention later —',
      'it comes OUT of your report, or you go and make it true.',
      '',
    );
  }

  const musts: string[] = [];
  if (profile.visual) {
    musts.push(
      'ANYTHING VISUAL — LOOK AT IT. Open it, render it, screenshot it and view the image. A file that exists and a picture that is right are different facts.',
    );
  }
  if (profile.functional) {
    musts.push(
      'ANYTHING FUNCTIONAL — RUN IT RIGHT NOW and read what came back. Not "it should print", what it printed.',
    );
  }
  if (profile.ui) {
    musts.push(
      'ANY UI — DRIVE IT. Move through it as the user would, and WRITE NEW TESTS for it now and make them green. Tests that already passed prove nothing about what you just changed.',
    );
  }
  if (profile.runtime !== null) {
    musts.push(
      `THE RUNTIME — this is written for \`${profile.runtime}\`. Confirm it is installed and LOAD THE WORK IN IT. Saying it "will open" in a program you never launched is the single failure this check exists to catch. RUN IT IN A WAY THAT EXITS: a validate/headless/\`--quit\` mode, and wrap it in \`timeout 60 …\` so it cannot outlive its usefulness. Launching the editor or a normal GUI window NEVER RETURNS — the command hangs, your turn hangs with it, and the whole run stops. (Godot: \`timeout 60 godot --headless --quit --path .\` loads and exits; \`-e\` and a bare \`--path\` open the editor and hang forever.)`,
    );
  }
  musts.push(
    'USE THE SPECIALISTS if any of this is beyond what you can check yourself — a tester, the visual specialist, the auditor. A second pair of eyes that did not build it is the point of having them.',
  );

  lines.push('WHAT CHECKING MEANS HERE:', '');
  for (const m of musts) lines.push(`  - ${m}`);
  lines.push('', p.who, p.ask, '');

  if (opts.vision !== undefined && opts.vision.trim() !== '') {
    lines.push(`WHAT THEY ASKED FOR, verbatim: ${opts.vision.trim()}`, '');
  }

  lines.push(
    'Fix whatever this turns up — now, not in a note about what remains. Then say',
    'what you actually did to check, and what you actually saw.',
  );
  return lines.join('\n');
}
