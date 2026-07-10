/**
 * Skill-instructions framing (Wave B #3b) — make a SKILL / tool-instructions
 * file the model READS reach it unambiguously as INSTRUCTIONS, never as a user
 * turn.
 *
 * ROOT CAUSE. pi surfaces skills as `<available_skills>` in the system prompt
 * and tells the model to `read` a skill's `SKILL.md` when a task matches. That
 * read comes back as a `toolResult` message — correct at pi's level. But the
 * llama.cpp provider serializes a tool result as an OpenAI `role: "tool"`
 * message carrying ONLY its text (provider-llamacpp/stream.ts), and
 * llama-server's chat template then folds it into the conversation. Gemma-class
 * templates have no `tool` role (only user/model), so the skill's text — which
 * is imperative ("You are a reviewer. Do X, Y, Z.") — lands inside a USER turn,
 * indistinguishable from something the user typed. The model then follows it as
 * a user instruction, or worse, treats it as the new task.
 *
 * FIX. On pi's `context` hook (fires before each LLM call; non-destructive — the
 * persisted session + the UI preview are untouched, only the outgoing copy is
 * transformed, exactly like the image sanitizer / canvas-awareness hooks) we
 * wrap the content of any skill-read tool result in an explicit
 * `<skill_instructions name="…">…</skill_instructions>` marker. The marker is
 * plain text, so it survives the provider's role:"tool" → user-turn flattening
 * and gives the model an unambiguous signal: this is a loaded skill playbook,
 * not user input.
 *
 * Pure + structural (no pi imports beyond the event types) so it unit-tests in
 * plain Node. The skill-path detector is kept in lock-step with the desktop
 * activity-chain's (apps/desktop/src/chat/activity-mapping.ts `isSkillPath`).
 */
import type { ContextEvent, ExtensionAPI } from '@mariozechner/pi-coding-agent';

/** The message shape pi's `context` hook operates on (derived, no direct dep on
 * `@mariozechner/pi-ai`). Union of user / assistant / toolResult / custom. */
export type SkillContextMessage = ContextEvent['messages'][number];

/** Marker wrapping injected skill content. OPEN is a prefix so a prior wrap is
 * detected (idempotency) even after the name/newline. */
export const SKILL_INSTRUCTIONS_TAG = 'skill_instructions';
const OPEN_PREFIX = `<${SKILL_INSTRUCTIONS_TAG}`;
const CLOSE_MARK = `\n</${SKILL_INSTRUCTIONS_TAG}>`;

/** Read-ish tool names whose result, when it targets a skill file, is skill
 * instructions. An `edit`/`write` to a skill file is NOT reframed. */
function isReadToolName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === 'read' ||
    n === 'view' ||
    n === 'cat' ||
    n === 'open' ||
    n === 'open_file' ||
    n === 'read_file'
  );
}

/** The path argument of a tool call, tolerant of the common arg names. */
function pathOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const a = args as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'filename', 'file', 'target_file']) {
    const v = a[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * True when a path targets a pi SKILL / tool-instructions file: the canonical
 * `SKILL.md` playbook, or anything under a pi skills dir
 * (`~/.pi/agent/skills/…` user, `<cwd>/.pi/skills/…` project — where a skill's
 * supporting files also live). Mirrors the desktop `isSkillPath`.
 */
export function isSkillPath(path: string | undefined): boolean {
  if (path === undefined || path.length === 0) return false;
  const norm = path.replace(/\\/g, '/');
  const base = norm.split('/').pop() ?? '';
  if (base.toLowerCase() === 'skill.md') return true;
  return /(^|\/)\.pi\/(agent\/)?skills\//.test(norm);
}

/**
 * The skill's name for the marker, derived from its path (pi's convention:
 * skill name === the folder holding SKILL.md). Falls back to the segment after
 * `skills/`, else the basename without extension.
 */
export function skillNameFromPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const base = parts.at(-1) ?? path;
  if (base.toLowerCase() === 'skill.md') return parts.at(-2) ?? 'skill';
  const idx = parts.lastIndexOf('skills');
  if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1] as string;
  return base.replace(/\.[^.]+$/, '') || base;
}

/** `role` accessor (structural — custom messages may carry other roles). */
function roleOf(msg: SkillContextMessage): string | undefined {
  const r = (msg as { role?: unknown }).role;
  return typeof r === 'string' ? r : undefined;
}

interface TextBlock {
  type: 'text';
  text: string;
}
function isTextBlock(b: unknown): b is TextBlock {
  return (
    typeof b === 'object' &&
    b !== null &&
    (b as { type?: unknown }).type === 'text' &&
    typeof (b as { text?: unknown }).text === 'string'
  );
}

/** Whether content already carries a wrap (idempotency guard). */
function alreadyWrapped(content: unknown): boolean {
  if (typeof content === 'string') return content.includes(OPEN_PREFIX);
  if (Array.isArray(content))
    return content.some((b) => isTextBlock(b) && b.text.includes(OPEN_PREFIX));
  return false;
}

/**
 * Wrap a tool-result's `content` (string OR content-block array) in the
 * `<skill_instructions name="…">…</skill_instructions>` marker. The open/close
 * ride in their own leading/trailing text blocks; the provider concatenates a
 * tool result's text blocks, so the model sees one clean wrapped block. Images
 * (if any) are preserved. Returns the SAME reference when already wrapped so the
 * caller can detect "no change".
 */
export function wrapSkillContent(content: unknown, name: string): unknown {
  if (alreadyWrapped(content)) return content;
  const open = `${OPEN_PREFIX} name="${name}">\n`;
  if (typeof content === 'string') return `${open}${content}${CLOSE_MARK}`;
  if (Array.isArray(content)) {
    return [{ type: 'text', text: open }, ...content, { type: 'text', text: CLOSE_MARK }];
  }
  // Unknown shape (no content) — nothing to wrap.
  return content;
}

/**
 * Return `messages` with every skill-read tool result's content wrapped in the
 * instructions marker. Pairs a read tool call (skill path) with its result by
 * `toolCallId`. `changed` is false (and the array is a shallow copy of the
 * input) when nothing matched, so the caller can skip returning a modification
 * and leave the model's KV cache untouched.
 */
export function withSkillInstructions(messages: readonly SkillContextMessage[]): {
  messages: SkillContextMessage[];
  changed: boolean;
} {
  // 1. Map skill-read toolCallId → skill name (from the assistant's tool calls).
  const skillCalls = new Map<string, string>();
  for (const msg of messages) {
    if (roleOf(msg) !== 'assistant') continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
      if (b.type !== 'toolCall' || typeof b.id !== 'string' || typeof b.name !== 'string') continue;
      if (!isReadToolName(b.name)) continue;
      const path = pathOf(b.arguments);
      if (path !== undefined && isSkillPath(path)) skillCalls.set(b.id, skillNameFromPath(path));
    }
  }
  if (skillCalls.size === 0) return { messages: [...messages], changed: false };

  // 2. Wrap each matching tool result's content.
  let changed = false;
  const out = messages.map((msg) => {
    if (roleOf(msg) !== 'toolResult') return msg;
    const id = (msg as { toolCallId?: unknown }).toolCallId;
    const name = typeof id === 'string' ? skillCalls.get(id) : undefined;
    if (name === undefined) return msg;
    const content = (msg as { content?: unknown }).content;
    const wrapped = wrapSkillContent(content, name);
    if (wrapped === content) return msg; // already wrapped — idempotent
    changed = true;
    return { ...(msg as object), content: wrapped } as SkillContextMessage;
  });
  return { messages: changed ? out : [...messages], changed };
}

/**
 * Register the skill-instructions framing on pi's `context` hook. Runs before
 * each LLM call; returns a modification only when a skill read is present.
 */
export function registerSkillInstructions(pi: ExtensionAPI): void {
  pi.on('context', (event) => {
    const { messages, changed } = withSkillInstructions(event.messages);
    return changed ? { messages } : undefined;
  });
}
