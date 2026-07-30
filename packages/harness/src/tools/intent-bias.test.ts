import { describe, expect, it } from 'vitest';
import {
  applyBias,
  distinguishingKey,
  lastAssistantThought,
  matchIntent,
  planBias,
  terms,
} from './intent-bias.js';

/** The real browser tool set, near enough — names and blurbs as registered. */
const TOOLS = [
  { name: 'browser_navigate', description: 'Open a URL in the built-in browser.' },
  { name: 'browser_snapshot', description: 'Read the current page and list its elements.' },
  { name: 'browser_click', description: 'Click an element on the current page by its index.' },
  { name: 'browser_type', description: 'Type text into a field on the page.' },
  { name: 'browser_scroll', description: 'Scroll the page up or down.' },
  { name: 'bash', description: 'Run a shell command.' },
  { name: 'read', description: 'Read a file from disk.' },
];
const ALL = TOOLS.map((t) => t.name);

describe('terms', () => {
  it('stems and drops narration filler', () => {
    expect(terms('I need to click on the link')).toEqual(['click', 'link']);
  });

  it('keeps tool names intact as separate words', () => {
    expect(terms('use browser_click now')).toEqual(['browser', 'click']);
  });
});

describe('matchIntent', () => {
  /* jedd's screenshot, verbatim in shape: the model says the tool's own name and
   * is then handed something else. A literal mention is not a guess. */
  it('takes a named tool as decisive', () => {
    const m = matchIntent(
      'I need to click on the link to start the test. Let me use browser_click to click on element [67].',
      TOOLS,
    );
    expect(m[0]).toMatchObject({ name: 'browser_click', score: 1, reason: 'named' });
    // Decisive means decisive — no fuzzy runners-up to muddy the plan.
    expect(m).toHaveLength(1);
  });

  it('reads "browser click" written with a space', () => {
    expect(matchIntent('let me use browser click here', TOOLS)[0]?.name).toBe('browser_click');
  });

  /* The case jedd actually described: "so if it says as is common 'i need to
   * click' then it will be biased toward calling the click action". No tool name
   * anywhere in that sentence. */
  it('matches a bare intent with no tool name', () => {
    const m = matchIntent('I need to click the More information link', TOOLS);
    expect(m[0]?.name).toBe('browser_click');
    expect(m[0]?.reason).toBe('similar');
  });

  it('separates typing from clicking', () => {
    expect(matchIntent('now I should type my email into the field', TOOLS)[0]?.name).toBe(
      'browser_type',
    );
  });

  it('separates scrolling from reading', () => {
    expect(matchIntent('scroll down to see the rest', TOOLS)[0]?.name).toBe('browser_scroll');
  });

  it('returns nothing for a thought about no tool at all', () => {
    expect(matchIntent('The user seems happy with that answer.', TOOLS)).toHaveLength(0);
  });

  it('is empty on empty input', () => {
    expect(matchIntent('', TOOLS)).toHaveLength(0);
    expect(matchIntent('click', [])).toHaveLength(0);
  });
});

describe('distinguishingKey', () => {
  /* MEASURED: browser_click tokenizes as `browser` + `_click`. Biasing "click"
   * (a different token) moved nothing — the leading underscore is the point. */
  it('returns the tail from the first diverging segment, underscore kept', () => {
    expect(distinguishingKey('browser_click', ALL)).toBe('_click');
  });

  it('returns the whole name when it diverges at the first segment', () => {
    expect(distinguishingKey('bash', ALL)).toBe('bash');
  });

  it('refuses a tail shared across families', () => {
    // `browser_click` and `mac_click` both end `_click` — and both really are
    // registered in this app. Biasing that tail lifts both and settles nothing.
    expect(
      distinguishingKey('browser_click', ['browser_click', 'browser_navigate', 'mac_click']),
    ).toBeNull();
  });

  it('takes the whole name when the FIRST segment is already the fork', () => {
    // mac_snapshot vs browser_snapshot share a tail but diverge at token 1, so
    // `mac` is what decides it — biasing the full name is right here.
    expect(distinguishingKey('mac_snapshot', ['mac_snapshot', 'browser_snapshot'])).toBe(
      'mac_snapshot',
    );
  });

  it('has no key when the name stands alone', () => {
    expect(distinguishingKey('only_one', ['only_one'])).toBe('only_one');
  });
});

describe('planBias', () => {
  /* Rule 1 from the measurements: with the tool ABSENT, no bias can summon it —
   * the grammar has masked it. Add it instead. */
  it('injects the wanted tool when it is not advertised', () => {
    const plan = planBias(
      'I need to click element [3]',
      ['browser_navigate', 'browser_snapshot'],
      TOOLS,
    );
    expect(plan.inject).toEqual(['browser_click']);
    expect(plan.bias).toEqual([]);
  });

  /* Rule 2: a positive bias toward an absent name measured WORSE than nothing —
   * 5/5 turns produced no tool call at all. So never emit one. */
  it('never biases a name it is injecting', () => {
    const plan = planBias('let me use browser_click', ['browser_navigate'], TOOLS);
    expect(plan.bias).toEqual([]);
  });

  it('biases, graded, when the tool is already advertised', () => {
    const plan = planBias('let me use browser_click', ALL, TOOLS);
    expect(plan.inject).toEqual([]);
    expect(plan.bias).toEqual([['_click', 6]]);
  });

  it('scales the bias by match strength', () => {
    const plan = planBias('I need to click the link', ALL, TOOLS);
    const [, strength] = plan.bias[0] ?? ['', 0];
    expect(strength).toBeGreaterThan(0);
    expect(strength).toBeLessThan(6); // a fuzzy match earns less than a named one
  });

  it('does nothing when the thought points nowhere', () => {
    const plan = planBias('That looks right to me.', ALL, TOOLS);
    expect(plan).toEqual({ inject: [], bias: [], match: null });
  });
});

describe('applyBias', () => {
  it('appends the injected tool with its real schema', () => {
    const tools = [{ type: 'function', function: { name: 'browser_navigate' } }];
    const body: Record<string, unknown> = { tools };
    applyBias(body, { inject: ['browser_click'], bias: [], match: null }, [
      { name: 'browser_click', description: 'Click.', parameters: { type: 'object' } },
    ]);
    const out = body.tools as Array<{ function: { name: string; parameters: unknown } }>;
    expect(out).toHaveLength(2);
    expect(out[1]?.function.name).toBe('browser_click');
    expect(out[1]?.function.parameters).toEqual({ type: 'object' });
    // Appended, so every already-cached token before it is untouched.
    expect(out[0]?.function.name).toBe('browser_navigate');
  });

  it('merges with a logit_bias an earlier handler already set', () => {
    const body: Record<string, unknown> = { logit_bias: [['_foo', -1]] };
    applyBias(body, { inject: [], bias: [['_click', 5]], match: null }, []);
    expect(body.logit_bias).toEqual([
      ['_foo', -1],
      ['_click', 5],
    ]);
  });

  it('leaves a body alone when there is nothing to do', () => {
    const body: Record<string, unknown> = { tools: [], messages: [] };
    applyBias(body, { inject: [], bias: [], match: null }, []);
    expect(body).toEqual({ tools: [], messages: [] });
  });
});

describe('lastAssistantThought', () => {
  it('prefers reasoning content, where the intent actually is', () => {
    const msgs = [
      { role: 'user', content: 'click the link' },
      { role: 'assistant', reasoning_content: 'I need to click element [3].', content: 'Sure.' },
    ];
    expect(lastAssistantThought(msgs)).toContain('I need to click element [3]');
  });

  it('reads the LAST assistant turn, not the first', () => {
    const msgs = [
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'go on' },
      { role: 'assistant', content: 'second' },
    ];
    expect(lastAssistantThought(msgs)).toBe('second');
  });

  it('keeps the tail, where a model states what it will do next', () => {
    const msgs = [{ role: 'assistant', content: `${'x'.repeat(2000)} I need to click.` }];
    const out = lastAssistantThought(msgs, 40);
    expect(out.length).toBe(40);
    expect(out).toContain('I need to click.');
  });

  it('survives junk', () => {
    expect(lastAssistantThought(undefined)).toBe('');
    expect(lastAssistantThought([{ role: 'user', content: 'hi' }])).toBe('');
  });
});
