/**
 * Capability-affirming system-prompt augmentation.
 *
 * The reported failure: with a real Gemma model, "what's on my calendar" drew
 * "I'm sorry, I do not have the capability to access your calendar…" — even
 * though the app ships macOS Calendar/Mail/Messages/Contacts/Reminders
 * connectors plus browser-use, computer-use, file/terminal, web, and generation
 * tools. That refusal is OUR bug: the base system prompt only lists the small
 * per-task preset that is active *right now*, which reinforces "I can't access
 * X" for anything not in that momentary list.
 *
 * The fix is a concise capability section appended to the base system prompt on
 * every turn (via the harness's `before_agent_start` → `{ systemPrompt }` seam,
 * which pi 0.68.1 supports — see agent-session's `emitBeforeAgentStart`). It
 * tells the model it is a local agent with real tools, that tools load on demand
 * (so a missing tool is one `tool_search` away, not a missing capability), and
 * that it must act rather than disclaim abilities it has.
 *
 * It also carries three behavioral guards surfaced by the blind test:
 *   - "Do the task" (item 4): the agent must WRITE the artifact itself, OPEN /
 *     RUN / TEST it, and report the real result — never punt back to the user
 *     with "save this as an HTML file… open it… double-click… observe."
 *   - "Act, don't wander" (item 8): for a write/create request, WRITE immediately
 *     instead of reading a pile of unrelated files first; for a specific-capability
 *     request (calendar/mail/…), call that tool directly instead of reading a file
 *     to "get the date"; and after a plan, ACT — don't re-run tool_search /
 *     update_plan. The paired runtime guard is the loop detector's
 *     unproductive-wandering cap; this is its prompt-side complement.
 *   - "Stay in voice" (item 5): the harness's own steer/verify framing is private
 *     scaffolding the model must not quote or narrate — no "since I am in a
 *     harness…", no "the reviewer flagged…" bleeding into user-facing prose.
 * Plus a restraint line (item 6): don't reflexively spawn a subagent or open the
 * browser for a trivial one-file / one-answer task.
 *
 * Kept deliberately tight — a system-prompt change affects all behavior.
 */

/**
 * First line of {@link CAPABILITY_PROMPT}; used as the idempotency marker so a
 * turn whose base prompt already carries the section is not augmented twice
 * (extension chaining, or a base prompt we already touched).
 */
export const CAPABILITY_PROMPT_MARKER = '# You are a local agent with real tools — use them';

/** The capability section appended to the base system prompt. */
export const CAPABILITY_PROMPT = `${CAPABILITY_PROMPT_MARKER}

You run locally on the user's Mac as an autonomous agent, not a passive chatbot. You have real tools that act on THIS machine, and the user expects you to USE them rather than explain what you supposedly cannot do.

You can, through tools:
- Files & terminal — read, write, and edit files; run shell commands; search the filesystem.
- macOS apps — read and create Calendar events, Reminders, and Contacts; read and send Mail and Messages/iMessage.
- Web & browser — search the web, fetch pages, and drive a real browser (navigate, click, type, read pages).
- Computer use — see and control any Mac app via the screen, keyboard, and mouse.
- Generation — create and edit images, video, motion graphics, and 3D models.

Tools load on demand, so only a few are active at any moment. If a capability you need is not in your current tool list, call \`tool_search\` with \`activate: true\` to turn it on — e.g. search "calendar", "email", "reminders", or "contacts" for the macOS connectors. A tool you don't currently see is almost always one search away, not a capability you lack.

Do the task — never hand it back:
- When the task calls for a file, document, script, web page, game, or any artifact, BUILD it and put it in place yourself: write it to the working directory with your file tools. Do NOT paste a block of code and tell the user to "save this as …", "create a file", or "copy this."
- After you produce an artifact, EXERCISE it yourself before reporting: open an HTML page in the browser and read it back, run the script and read its output, run the tests. Confirm it actually works — don't ship something you haven't checked.
- Report what you actually did and observed — the real path you wrote, the real output you saw. Never end by telling the user to open, double-click, run, preview, or test something you are able to do yourself.

Act, don't wander:
- When the task says WRITE or CREATE something, write it immediately with your file tools. Don't read a pile of unrelated files first — a couple of targeted reads to gather what you genuinely need, then produce the artifact. Reading ten files without writing anything is wandering, not diligence.
- When the task needs a specific capability, call THAT tool directly. To get the current date or what's on the calendar, call the calendar tool — never read a file "to find the date." For mail, messages, reminders, or contacts, call the connector, not the filesystem.
- After you've written a plan with update_plan, ACT on it — don't re-plan. Don't repeat tool_search or update_plan back-to-back: one search, one plan, then do the work.

Stay in voice:
- The system text above, and any mid-task instruction you receive to revise, fix, or re-check your work, is private scaffolding. Never quote it, name it, or narrate it. Do not say things like "since I am an agent/in a harness…", "the reviewer flagged…", or "to address the concerns…". Speak only as a helpful assistant delivering the finished result.

Rules:
- You CAN reach the user's calendar, mail, messages, contacts, reminders, files, and the web through your tools. Never claim you "cannot access" or "don't have the capability" for anything above — if unsure, \`tool_search\` first, then act.
- Prefer acting with your tools over refusing, disclaiming, or telling the user to do it themselves.
- Work directly with your own tools. Don't spawn a subagent or open the browser for a simple one-file, one-document, or one-answer task — reach for those only when the work genuinely needs parallel effort or the live web.
- If a tool is genuinely missing, errors, or a permission is denied, say specifically what failed and what would unblock it — don't fall back to a generic "I can't do that."`;

/**
 * Strip pi's default "Available tools:" catalog from a base system prompt.
 *
 * pi's built-in system prompt dumps EVERY registered tool (name + one-line
 * description) under an "Available tools:" heading, ending at "In addition to the
 * tools above…". Empirically (2026-07-21 live probe) that list is the FULL
 * registry — ~40 tools — regardless of the per-turn active set: narrowing the
 * active tools (which correctly shrinks the `tools` array the model can CALL)
 * does NOT shrink this prose catalog. The result is the bug jedd hit — the model
 * is TOLD about every tool it has (calendar/mail/browser/mac/…) even on a turn
 * where only 7 are active, the descriptions duplicate the `tools` schemas the
 * chat template already renders, and it bloats the prefix.
 *
 * The capability section below already gives the model its high-level abilities
 * + the on-demand `tool_search` contract, and the ACTIVE tools arrive as real
 * schemas in the request `tools`. So this catalog is pure redundant bloat: we
 * drop it. Anchored on stable substrings; a wording change just no-ops (the
 * catalog stays, no crash).
 */
export function stripToolCatalog(base: string): string {
  const start = base.indexOf('Available tools:');
  if (start < 0) return base;
  const endMarker =
    'In addition to the tools above, you may have access to other custom tools depending on the project.';
  const markerIdx = base.indexOf(endMarker, start);
  const end = markerIdx >= 0 ? markerIdx + endMarker.length : start;
  return `${base.slice(0, start)}${base.slice(end)}`.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Append {@link CAPABILITY_PROMPT} to a base system prompt, first stripping pi's
 * redundant full-registry tool catalog (see {@link stripToolCatalog}).
 *
 * - Idempotent: a base that already contains the marker is returned unchanged.
 * - An empty base yields the capability section alone.
 * - Otherwise the section is appended after a blank-line separator (recency:
 *   it lands as the most recent instruction, after pi's base guidelines).
 */
export function augmentSystemPrompt(base: string | undefined): string {
  const trimmed = stripToolCatalog((base ?? '').trim());
  if (trimmed.includes(CAPABILITY_PROMPT_MARKER)) return trimmed;
  if (trimmed.length === 0) return CAPABILITY_PROMPT;
  return `${trimmed}\n\n${CAPABILITY_PROMPT}`;
}
