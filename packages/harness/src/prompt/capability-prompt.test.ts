import { describe, expect, it } from 'vitest';
import {
  augmentSystemPrompt,
  CAPABILITY_PROMPT,
  CAPABILITY_PROMPT_MARKER,
  stripToolCatalog,
  TEAM_PROMPT,
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

  it('affirms the capabilities the model kept refusing (calendar/mail/messages) and points at capability', () => {
    const p = CAPABILITY_PROMPT.toLowerCase();
    for (const cap of ['calendar', 'mail', 'messages', 'reminders', 'contacts']) {
      expect(p).toContain(cap);
    }
    expect(p).toContain('capability');
    // It must tell the model NOT to disclaim abilities it has.
    expect(p).toContain('never claim you "cannot access"');
  });

  it('tells the agent to BUILD/RUN/TEST its own artifacts, not punt to the user (item 4)', () => {
    const p = CAPABILITY_PROMPT.toLowerCase();
    // The artifact goes into the working dir via the agent's own tools…
    expect(p).toContain('written to the working directory with real content');
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
    // After a plan, ACT — don't re-run `capability` / update_plan.
    expect(p).toContain('update_plan');
    expect(p).toContain('update_plan');
    expect(p).toMatch(/one activation, one plan, then do the work/);
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
  it('makes browser_navigate the DEFAULT way to visit a page', () => {
    // jedd: "load browser navigate by default … bias it to use the built in
    // browser instead of bash to open safari when no specific is requested."
    expect(CAPABILITY_PROMPT).toContain('the DEFAULT way to visit any web');
    expect(CAPABILITY_PROMPT).toContain('never `open -a Safari`');
  });

  it('forbids re-navigating to a page it is already on', () => {
    // The loop jedd hit: "constantly reopen the same link over and over".
    expect(CAPABILITY_PROMPT).toContain('NAVIGATING RETURNS THE PAGE');
    expect(CAPABILITY_PROMPT).toContain('NEVER navigate to a URL you are already on');
    // And it must name the tool that lets it look WITHOUT navigating — a browser
    // with no way to look is what forced the loop in the first place.
    expect(CAPABILITY_PROMPT).toContain('`browser_snapshot` is also always available');
  });

  it('says the rest of the browser suite is one capability call away', () => {
    expect(CAPABILITY_PROMPT).toContain('the whole suite arrives in your list');
  });

  it('sends computer use at the user’s OWN browsers, and only those', () => {
    expect(CAPABILITY_PROMPT).toContain('THEIR OWN browsers');
    expect(CAPABILITY_PROMPT).toContain('Safari, Chrome, Arc');
  });

  it('tells it to act on an already-open tab rather than opening another', () => {
    // The bug jedd hit: a blank second tab, snapshotted instead of his page.
    expect(CAPABILITY_PROMPT).toContain('act on THAT tab');
  });

  it('bundles calendar, mail, reminders, contacts and messages as ONE capability', () => {
    expect(CAPABILITY_PROMPT).toContain('CALENDAR, MAIL, REMINDERS, CONTACTS & MESSAGES');
    // …with the rule that matters: read/write via the connector, not the UI.
    expect(CAPABILITY_PROMPT).toContain('never drive the Calendar or Mail UI with computer use');
  });

  it('routes the user’s own Chrome through its DOM, not through pixels', () => {
    expect(CAPABILITY_PROMPT).toContain('GOOGLE CHROME');
    expect(CAPABILITY_PROMPT).toContain('chrome_snapshot');
    expect(CAPABILITY_PROMPT).toContain('Always prefer it over computer use for Chrome');
  });

  it('warns that opening from the shell lands in a real Mac app', () => {
    // The common case jedd flagged: `open -a Safari` is computer-use territory.
    expect(CAPABILITY_PROMPT).toContain('hand the page to');
    expect(CAPABILITY_PROMPT).toContain('control it with computer use');
  });

  it('still says an AX-opaque app gives a screenshot to act on by coordinates', () => {
    expect(CAPABILITY_PROMPT).toContain('act by x,y coordinates');
  });
});

/*
 * THE PROMPT MUST NOT NAME TOOLS THAT DO NOT EXIST.
 *
 * `tool_search` was removed and replaced by `capability`, but the prompt still
 * told the model to "tool_search first, then act". This is the same failure that
 * produced the browser_read confusion: prose naming an unadvertised tool. The
 * grammar pins the emitted name to the ADVERTISED list, so a bid for a tool the
 * prose invented lands on whichever real name is nearest — a plausible wrong
 * call rather than a clean failure.
 */
describe('no phantom tools in the prompt', () => {
  it('never mentions the removed tool_search', () => {
    expect(CAPABILITY_PROMPT).not.toMatch(/tool_search/);
  });

  it('points at capability instead', () => {
    expect(CAPABILITY_PROMPT).toMatch(/call `capability` first, then act/);
  });
});

describe('verification is required of any artifact', () => {
  it('does not limit the check to pages, scripts and tests', () => {
    // A Godot project was written (14 files) and never opened, because the old
    // wording only named HTML/script/test cases and nothing else mapped.
    expect(CAPABILITY_PROMPT).toMatch(/the cheapest thing that would REVEAL IT IS BROKEN/);
    expect(CAPABILITY_PROMPT).toMatch(/load the file with the tool that owns it/);
  });

  it('names the failure mode explicitly', () => {
    expect(CAPABILITY_PROMPT).toMatch(
      /Writing several files and reporting success without opening any of them/,
    );
  });
});

describe('capability activation is a first move, not a fallback', () => {
  it('tells the model to activate before concluding it cannot', () => {
    expect(CAPABILITY_PROMPT).toMatch(/TURN THE CAPABILITY ON BEFORE YOU DECIDE YOU CANNOT/);
    expect(CAPABILITY_PROMPT).toMatch(/your FIRST action, not a fallback/);
  });
});

describe('multi-step and destructive work leave a trail', () => {
  /* A chained task re-derived its position from the transcript every turn, and
   * `update_plan` was never called — the prompt said what to do AFTER writing a
   * plan but never when to write one. */
  it('asks for a plan when the work is a chain', () => {
    expect(CAPABILITY_PROMPT).toMatch(/WHEN THE WORK IS A CHAIN/);
    expect(CAPABILITY_PROMPT).toMatch(/mark each one off as it completes/);
  });

  it('does not demand a plan for a single action', () => {
    expect(CAPABILITY_PROMPT).toMatch(/a plan for a single action is noise/);
  });

  /* Nothing made a bulk filesystem change checkable after the fact, which is the
   * one class of mistake the user cannot undo by asking again. */
  it('requires a bulk or irreversible change to be stated and then checked', () => {
    expect(CAPABILITY_PROMPT).toMatch(/BEFORE ANYTHING BULK OR IRREVERSIBLE/);
    expect(CAPABILITY_PROMPT).toMatch(/"Done" is not an observation/);
  });
});

/*
 * THE TEAM SECTION.
 *
 * The delegation tool was in the model's `tools` array while the system prompt
 * never mentioned a manager, a team, or delegation at all — and stripToolCatalog
 * removes pi's prose catalog, where a tool's promptSnippet/promptGuidelines
 * would otherwise appear. So the only framing that reached the model was one
 * JSON description among sixteen. Measured: a max-effort platformer request with
 * the tool advertised produced 8 and then 78 solo turns and zero delegation.
 */
describe('the team section', () => {
  it('is absent when the delegation tool is not advertised', () => {
    const out = augmentSystemPrompt('Base.', {});
    expect(out).not.toMatch(/talk_to_manager/);
    // Naming an unadvertised tool is the phantom-tool failure this file exists to
    // prevent — the grammar would land a bid for it on the nearest real name.
    expect(out).not.toMatch(/You lead a TEAM/);
  });

  it('appears when it is', () => {
    const out = augmentSystemPrompt('Base.', { team: true });
    expect(out).toMatch(/You lead a TEAM/);
    expect(out).toMatch(/talk_to_manager/);
  });

  it('says the CEO does not design the team', () => {
    expect(TEAM_PROMPT).toMatch(/You do not design the team or the divisions/);
  });

  it('names both mistakes, not just the over-delegation one', () => {
    expect(TEAM_PROMPT).toMatch(/Do NOT reach for it for a question, a single file/);
    expect(TEAM_PROMPT).toMatch(/Building a large project alone is the more expensive mistake/);
  });

  it('keeps the capability section either way', () => {
    expect(augmentSystemPrompt('Base.', { team: true })).toContain(CAPABILITY_PROMPT_MARKER);
    expect(augmentSystemPrompt('Base.', {})).toContain(CAPABILITY_PROMPT_MARKER);
  });
});

/*
 * THE PROMPT MUST NOT ARGUE WITH ITSELF.
 *
 * "Do the task — never hand it back" + "BUILD it and put it in place yourself"
 * (with `game` named among the artifacts) reads as a ban on delegating, and it
 * sits ABOVE the team section and is far more emphatic. Measured: three
 * consecutive max-effort runs where the CEO built a whole game alone with
 * talk_to_manager advertised — the last of them with the team section verifiably
 * in the prompt (12677 chars vs 11675). The two sections were telling it opposite
 * things and the older, louder one won.
 *
 * The clause was always about not handing work back to the USER. It now says so.
 */
describe('delegation is not forbidden by the do-the-task clause', () => {
  it('scopes "never hand it back" to the user', () => {
    expect(CAPABILITY_PROMPT).toContain('never hand it back TO THE USER');
  });

  it('says using the team still counts as doing it', () => {
    expect(CAPABILITY_PROMPT).toMatch(/Getting it built by your own team counts as doing it/);
  });

  it('no longer tells the model to build every artifact itself', () => {
    expect(CAPABILITY_PROMPT).not.toMatch(/BUILD it and put it in place yourself/);
  });
});
