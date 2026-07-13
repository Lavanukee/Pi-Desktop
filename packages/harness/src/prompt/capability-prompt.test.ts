import { describe, expect, it } from 'vitest';
import {
  augmentSystemPrompt,
  CAPABILITY_PROMPT,
  CAPABILITY_PROMPT_MARKER,
} from './capability-prompt.js';

describe('augmentSystemPrompt', () => {
  it('appends the capability section to a non-empty base', () => {
    const out = augmentSystemPrompt('You are a coding agent.');
    expect(out.startsWith('You are a coding agent.')).toBe(true);
    expect(out).toContain(CAPABILITY_PROMPT_MARKER);
  });

  it('returns the capability section alone for an empty/whitespace base', () => {
    expect(augmentSystemPrompt('')).toBe(CAPABILITY_PROMPT);
    expect(augmentSystemPrompt('   \n  ')).toBe(CAPABILITY_PROMPT);
    expect(augmentSystemPrompt(undefined)).toBe(CAPABILITY_PROMPT);
  });

  it('is idempotent — a base already carrying the marker is not doubled', () => {
    const once = augmentSystemPrompt('base');
    const twice = augmentSystemPrompt(once);
    expect(twice).toBe(once);
    // The marker appears exactly once.
    expect(twice.split(CAPABILITY_PROMPT_MARKER).length - 1).toBe(1);
  });

  it('affirms the capabilities the model kept refusing (calendar/mail/messages) and points at tool_search', () => {
    const p = CAPABILITY_PROMPT.toLowerCase();
    for (const cap of ['calendar', 'mail', 'messages', 'reminders', 'contacts']) {
      expect(p).toContain(cap);
    }
    expect(p).toContain('tool_search');
    // It must tell the model NOT to disclaim abilities it has.
    expect(p).toContain('never claim you "cannot access"');
  });

  it('tells the agent to BUILD/RUN/TEST its own artifacts, not punt to the user (item 4)', () => {
    const p = CAPABILITY_PROMPT.toLowerCase();
    // The artifact goes into the working dir via the agent's own tools…
    expect(p).toContain('write it to the working directory');
    // …the agent exercises it before reporting…
    expect(p).toContain('exercise it yourself');
    // …and never hands the doing-part back to the user (the exact punt language
    // the blind-test model produced: "save this as an HTML file… open it… test").
    expect(p).toContain('save this as');
    expect(p).toContain('double-click');
    expect(p).toMatch(/never end by telling the user to open/);
  });

  it('tells the agent to ACT rather than wander: write immediately, call the tool directly, act after a plan (item 8)', () => {
    const p = CAPABILITY_PROMPT.toLowerCase();
    // A write/create request must WRITE immediately, not read a pile of files.
    expect(p).toContain("act, don't wander");
    expect(p).toContain('write it immediately');
    expect(p).toMatch(/reading ten files without writing anything is wandering/);
    // A specific capability must call THAT tool, not read a file to get the date.
    expect(p).toContain('call that tool directly');
    expect(p).toContain('to find the date');
    expect(p).toContain('calendar');
    // After a plan, ACT — don't re-run tool_search / update_plan.
    expect(p).toContain('tool_search');
    expect(p).toContain('update_plan');
    expect(p).toMatch(/one search, one plan, then do the work/);
  });

  it('keeps the harness/reviewer framing private so it cannot leak into the answer (item 5)', () => {
    const p = CAPABILITY_PROMPT.toLowerCase();
    expect(p).toContain('private scaffolding');
    // It names the exact leaks seen in the blind test as things NOT to say.
    expect(p).toContain('the reviewer flagged');
    expect(p).toContain('in a harness');
  });

  it('asks the agent not to reflexively spawn a subagent / open the browser for trivial tasks (item 6)', () => {
    const p = CAPABILITY_PROMPT.toLowerCase();
    expect(p).toMatch(/don't spawn a subagent or open the browser for a simple/);
  });
});
