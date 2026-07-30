import { describe, expect, it } from 'vitest';
import {
  augmentSystemPrompt,
  CAPABILITY_PROMPT,
  CAPABILITY_PROMPT_MARKER,
  stripToolCatalog,
} from './capability-prompt.js';

// pi's default base prompt shape (abbreviated): a full-registry tool catalog
// bounded by "Available tools:" … "In addition to the tools above…", then the
// rest of the base. The live prompt lists ~40 tools regardless of the active set.
const PI_BASE = `You are an expert coding assistant operating inside pi.

Available tools:
- read: Read file contents
- calendar_list_events: List the user's Calendar events in a date range
- messages_send: Send an iMessage
- mac_launch: Launch or focus a Mac app

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Be concise in your responses`;

describe('stripToolCatalog', () => {
  it('removes the full "Available tools:" catalog block but keeps the rest', () => {
    const out = stripToolCatalog(PI_BASE);
    expect(out).not.toContain('Available tools:');
    expect(out).not.toContain('calendar_list_events');
    expect(out).not.toContain('messages_send');
    expect(out).not.toContain('In addition to the tools above');
    // The surrounding prose survives.
    expect(out).toContain('You are an expert coding assistant');
    expect(out).toContain('Guidelines:');
    expect(out).toContain('Be concise');
  });

  it('no-ops (returns the base) when there is no catalog to strip', () => {
    const plain = 'You are a coding agent.\n\nGuidelines:\n- Be concise';
    expect(stripToolCatalog(plain)).toBe(plain);
  });
});

describe('augmentSystemPrompt', () => {
  it('appends the capability section to a non-empty base', () => {
    const out = augmentSystemPrompt('You are a coding agent.');
    expect(out.startsWith('You are a coding agent.')).toBe(true);
    expect(out).toContain(CAPABILITY_PROMPT_MARKER);
  });

  it('strips pi’s full-registry tool catalog before appending (the bloat fix)', () => {
    const out = augmentSystemPrompt(PI_BASE);
    expect(out).not.toContain('calendar_list_events'); // catalog gone
    expect(out).not.toContain('Available tools:');
    expect(out).toContain('You are an expert coding assistant'); // base prose kept
    expect(out).toContain(CAPABILITY_PROMPT_MARKER); // capability section added
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

describe('each capability carries its own guidance (jedd)', () => {
  // "add tidbits to each capability in the system prompt, eg. utilize these tools
  // as the primary browser controls whenever you do something requiring a web
  // browser, utilize mac computer use if it is requested you do something in the
  // user's other browsers on their system ... bundle the calendar, email and
  // reminders stuff also."
  it('names the built-in browser as the PRIMARY web control', () => {
    expect(CAPABILITY_PROMPT).toContain('These are your PRIMARY browser controls');
  });

  it('sends computer use at the user’s OWN browsers, and only those', () => {
    expect(CAPABILITY_PROMPT).toContain('THEIR OWN browsers');
    expect(CAPABILITY_PROMPT).toContain('Safari, Chrome, Arc');
  });

  it('tells it to act on an already-open tab rather than opening another', () => {
    // The bug jedd hit: a blank second tab, snapshotted instead of his page.
    expect(CAPABILITY_PROMPT).toContain('act on');
    expect(CAPABILITY_PROMPT).toContain('rather than opening a new one');
  });

  it('bundles calendar, mail, reminders, contacts and messages as ONE capability', () => {
    expect(CAPABILITY_PROMPT).toContain('CALENDAR, MAIL, REMINDERS, CONTACTS & MESSAGES');
    // …with the rule that matters: read/write via the connector, not the UI.
    expect(CAPABILITY_PROMPT).toContain('never drive the Calendar or Mail UI with computer use');
  });

  it('warns that opening from the shell lands in a real Mac app', () => {
    // The common case jedd flagged: `open -a Safari` is computer-use territory.
    expect(CAPABILITY_PROMPT).toContain('hands it to a');
    expect(CAPABILITY_PROMPT).toContain('not the built-in browser');
  });

  it('still says an AX-opaque app gives a screenshot to act on by coordinates', () => {
    expect(CAPABILITY_PROMPT).toContain('act by x,y coordinates');
  });
});
