/**
 * INTENT BIAS — read what the model just said it wanted to do, and make that the
 * easy thing to do next.
 *
 * jedd: "it's still doing a lot of page reading repeating when it clearly intends
 * not to, can you attempt to do a quick semantic match of a thought to all the
 * tools between each tool call … and then not force but do a reasonably strong
 * bias toward the tools based on how the semantic match was? eg. so if it says as
 * is common 'i need to click' then it will be biased toward calling the click
 * action and will hopefully stop the looping behavior outright."
 *
 * WHAT THE MEASUREMENTS SAY. Four A/Bs against the real server (Qwen3.5-4B Q8,
 * production sampling, 5 seeds a cell), parked at exactly the looping moment: the
 * page is read, the model has just said "I need to click … element [3]".
 *
 *   tools advertised          bias              picks
 *   ────────────────────────────────────────────────────────────────────────
 *   navigate+snapshot         none              navigate ×4, no-tool ×1
 *   navigate+snapshot         _click +100       NO TOOL AT ALL ×5
 *   nav+snap+CLICK            none              browser_click ×5
 *   nav+snap+CLICK            _click −10        navigate ×3, click ×2
 *   nav+snap+CLICK            _click −100       navigate ×5
 *   nav+snap+CLICK            _snapshot +10     browser_click ×5
 *
 * Three things follow, and they set this whole design:
 *
 *  1. THE LOOP IS AN AVAILABILITY PROBLEM, NOT A PREFERENCE PROBLEM. Give the
 *     model `browser_click` and it picks it 5/5 with no help at all. It was never
 *     confused about what it wanted; it was being handed a list that did not
 *     contain it, and llama-server's tool-call grammar pins the emitted name to
 *     that list. So the primary action here is to ADD the tool it asked for.
 *
 *  2. A POSITIVE BIAS TOWARD AN ABSENT TOOL IS WORSE THAN NOTHING. Row 2: the
 *     grammar has already masked those tokens, so the bias cannot summon them —
 *     it just drags probability toward a dead end until the turn produces no tool
 *     call whatsoever. Hence the hard rule below: never bias a name that is not
 *     in this request's tool list.
 *
 *  3. BIAS IS REAL AND GRADED, so it is worth keeping as the second-order nudge —
 *     −10 moves a confident pick, −100 owns it. Note row 6: +10 toward the WRONG
 *     tool did not derail a confident right answer, which is the "bias, not force"
 *     property jedd asked for, confirmed rather than assumed.
 *
 * ON "A SMALL EMBEDDING MODEL". Not used, deliberately. The match runs on every
 * request, and the dominant real signal is literal: the model writes the tool's
 * NAME in its reasoning ("Let me use browser_click"), which no embedding can beat
 * and which costs a substring test. Below that it is TF-IDF cosine over the tool
 * names + descriptions — a genuine vector-space match in a sparse lexical space,
 * microseconds, no model to load, no memory taken from a 4B that is already
 * sharing a 24GB machine. `matchIntent` is a pure function over candidates, so a
 * dense backend can replace the scorer without touching the wiring if measurement
 * ever shows the lexical one missing cases.
 */

/** A tool we could bias toward or switch on. `parameters` rides along so an
 *  absent tool can be injected into the request with its real schema. */
export interface BiasCandidate {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

export interface IntentMatch {
  readonly name: string;
  /** 0..1. 1 = the thought named the tool outright. */
  readonly score: number;
  /** Why it matched — surfaced in diagnostics, and it keeps the tests honest. */
  readonly reason: 'named' | 'similar';
}

/** Words that carry no intent. Kept short: TF-IDF already discounts anything
 *  common across the tool set, so this only needs to cover the prose filler a
 *  model uses when narrating ("I need to …", "let me …"). */
const STOP = new Set([
  'a',
  'an',
  'and',
  'the',
  'to',
  'of',
  'in',
  'on',
  'for',
  'is',
  'it',
  'its',
  'this',
  'that',
  'with',
  'as',
  'at',
  'be',
  'by',
  'or',
  'from',
  'i',
  'we',
  'you',
  'me',
  'my',
  'let',
  'need',
  'want',
  'should',
  'will',
  'can',
  'now',
  'then',
  'next',
  'use',
  'using',
  'used',
  'call',
  'calling',
  'do',
  'does',
  'done',
  'so',
  'if',
  'not',
  'no',
  'have',
  'has',
  'had',
  'was',
  'were',
  'are',
  'am',
  'been',
  'get',
  'gets',
  'got',
  'make',
  'makes',
  'made',
  'tool',
  'tools',
  'result',
  'results',
  'first',
  'also',
  'after',
  'before',
  'here',
  'there',
  'what',
  'which',
]);

/** Lowercase word stems. Light stemming only — enough that "clicking" and
 *  "clicks" reach "click", without dragging in a stemmer dependency. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    // Stop BEFORE stemming, not after: "need" ends in "ed", and stripping it
    // first yielded "ne" — a nonsense term that no longer matched the stop list
    // and then competed with real ones. Caught by the test on this function.
    if (raw.length < 2 || STOP.has(raw)) continue;
    let w = raw;
    if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(w);
  }
  return out;
}

/**
 * The text a tool is "about". Its NAME counts triple: `browser_click` is mostly
 * called because someone said "click", and a long description would otherwise
 * drown that one decisive word.
 */
function toolTerms(t: BiasCandidate): string[] {
  const name = terms(t.name);
  return [...name, ...name, ...name, ...terms(t.description ?? '')];
}

function counts(list: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of list) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

/**
 * Score the thought against every candidate.
 *
 * A literal mention of the tool's name short-circuits to 1.0 — that is not a
 * similarity judgement, it is the model telling us outright. Everything else is
 * TF-IDF cosine, with IDF computed over the candidate set so a term shared by
 * every browser tool ("browser", "page") counts for little and the distinguishing
 * one ("click", "scroll") counts for a lot.
 *
 * Returns matches sorted best-first, above `floor`.
 */
export function matchIntent(
  thought: string,
  candidates: readonly BiasCandidate[],
  floor = 0.18,
): IntentMatch[] {
  if (thought.trim() === '' || candidates.length === 0) return [];
  const hay = thought.toLowerCase();
  const named: IntentMatch[] = [];
  for (const c of candidates) {
    // Both spellings — models write `browser_click` and "browser click" equally.
    if (
      hay.includes(c.name.toLowerCase()) ||
      hay.includes(c.name.toLowerCase().replace(/_/g, ' '))
    ) {
      named.push({ name: c.name, score: 1, reason: 'named' });
    }
  }
  // A name in the text is decisive; do not dilute it with fuzzy runners-up.
  if (named.length > 0) return named;

  const docs = candidates.map((c) => counts(toolTerms(c)));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string): number => Math.log(1 + candidates.length / (1 + (df.get(w) ?? 0)));

  const q = counts(terms(thought));
  let qNorm = 0;
  for (const [w, n] of q) qNorm += (n * idf(w)) ** 2;
  qNorm = Math.sqrt(qNorm);
  if (qNorm === 0) return [];

  const out: IntentMatch[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const d = docs[i];
    if (d === undefined) continue;
    let dot = 0;
    let dNorm = 0;
    for (const [w, n] of d) {
      const wi = n * idf(w);
      dNorm += wi * wi;
      const qi = q.get(w);
      if (qi !== undefined) dot += wi * qi * idf(w);
    }
    dNorm = Math.sqrt(dNorm);
    if (dNorm === 0) continue;
    const score = dot / (qNorm * dNorm);
    const cand = candidates[i];
    if (score >= floor && cand !== undefined) {
      out.push({ name: cand.name, score, reason: 'similar' });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * The substring to bias, for a name inside a set of names.
 *
 * MEASURED, and the reason this is not just the tool name: `browser_click`
 * tokenizes as `browser`(21769) + `_click`(18070). An earlier A/B biased the
 * string "click" — token 3552, which is never generated — and moved nothing,
 * which read as "logit_bias does not work here" when in fact it had tested
 * nothing at all. Biasing the whole name would move `browser` too, which is
 * shared with every other browser tool and so pushes them up in lockstep.
 *
 * So: split on `_`, find the first segment where this name differs from all the
 * others, and bias from there — `_click`, not `click`, and not `browser_click`.
 * llama.cpp tokenizes a string-form bias key itself (verified: the string
 * "_click" and the id 18070 produce identical outcomes), so no tokenizer
 * round-trip is needed.
 */
export function distinguishingKey(name: string, others: readonly string[]): string | null {
  const segs = name.split('_');
  const rivals = others.filter((o) => o !== name).map((o) => o.split('_'));
  for (let i = 0; i < segs.length; i++) {
    // Only rivals still on the same path matter — once a name has diverged it is
    // no longer competing for the next token.
    const stillWith = rivals.filter((r) => segs.slice(0, i).every((s, j) => r[j] === s));
    if (stillWith.some((r) => r[i] === segs[i])) continue; // not yet distinguishing
    const key = i === 0 ? segs.join('_') : `_${segs.slice(i).join('_')}`;
    /*
     * A tail can be ambiguous ACROSS families: `mac_snapshot` and
     * `browser_snapshot` both end `_snapshot`, so biasing that tail lifts both
     * and settles nothing — the real fork was the first token. Rather than nudge
     * the wrong tool by the same amount, say there is no safe key and let the
     * caller skip the bias. Injection, the primary mechanism, is unaffected.
     */
    if (i > 0 && others.some((o) => o !== name && o.endsWith(key))) return null;
    return key;
  }
  return null;
}

/** An OpenAI-shaped tool entry, as llama-server expects it. */
function asToolEntry(c: BiasCandidate): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: c.name,
      ...(c.description !== undefined ? { description: c.description } : {}),
      parameters: c.parameters ?? { type: 'object', properties: {} },
    },
  };
}

export interface BiasPlan {
  /** Tools to add to this request because the model asked for them by intent. */
  readonly inject: string[];
  /** name → bias, for tools already advertised. */
  readonly bias: Array<[string, number]>;
  /** The match that drove it, for logging. */
  readonly match: IntentMatch | null;
}

/** Bias applied to the top match, graded by score. Ceiling deliberately well
 *  below the −100 that owned the choice outright: jedd asked for a bias, not a
 *  force, and +10 was already measured not to override a confident pick. */
const MAX_BIAS = 6;

/**
 * Decide what to do about the model's stated intent.
 *
 * `advertised` is what THIS request already carries; `all` is everything
 * registered in the build. A match that is already advertised gets a graded
 * nudge; one that is not gets injected, because rule 2 above says biasing it
 * would actively hurt.
 */
export function planBias(
  thought: string,
  advertised: readonly string[],
  all: readonly BiasCandidate[],
): BiasPlan {
  const matches = matchIntent(thought, all);
  const best = matches[0];
  if (best === undefined) return { inject: [], bias: [], match: null };

  const inject: string[] = [];
  const bias: Array<[string, number]> = [];
  const isAdvertised = advertised.includes(best.name);

  if (isAdvertised) {
    const key = distinguishingKey(best.name, advertised);
    if (key !== null) bias.push([key, Math.round(best.score * MAX_BIAS * 10) / 10]);
  } else {
    inject.push(best.name);
  }
  return { inject, bias, match: best };
}

/**
 * Apply a plan to an OpenAI-shaped request body, in place.
 *
 * Injected tools are appended rather than spliced in, so the prefix that is
 * already cached stays byte-identical up to the insertion point. Any logit_bias
 * an earlier handler set is preserved — ours is merged on top.
 */
export function applyBias(
  body: Record<string, unknown>,
  plan: BiasPlan,
  all: readonly BiasCandidate[],
): Record<string, unknown> {
  if (plan.inject.length > 0) {
    const tools = Array.isArray(body.tools) ? [...body.tools] : [];
    for (const name of plan.inject) {
      const cand = all.find((c) => c.name === name);
      if (cand !== undefined) tools.push(asToolEntry(cand));
    }
    body.tools = tools;
  }
  if (plan.bias.length > 0) {
    const existing = Array.isArray(body.logit_bias) ? [...body.logit_bias] : [];
    body.logit_bias = [...existing, ...plan.bias];
  }
  return body;
}

/**
 * The last thing the assistant said, which is where the intent lives.
 *
 * Only the tail is read: a model states what it is about to do at the END of its
 * reasoning, and scoring the whole essay buries that under everything it already
 * did. Reasoning content is preferred over visible content — that is where "I
 * need to click on element [3]" actually appears.
 */
export function lastAssistantThought(messages: unknown, tailChars = 600): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (m === undefined || m.role !== 'assistant') continue;
    const reasoning = typeof m.reasoning_content === 'string' ? m.reasoning_content : '';
    const content = typeof m.content === 'string' ? m.content : '';
    const text = `${reasoning}\n${content}`.trim();
    return text.length > tailChars ? text.slice(-tailChars) : text;
  }
  return '';
}
