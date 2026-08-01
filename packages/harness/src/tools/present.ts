/**
 * `present` — hand the finished thing to the user, and look at it one last time.
 *
 * jedd's ask: "I want the model to have a 'present' tool, this is only for the
 * top level/original model, no subagent ever has this, that presents a file to
 * the user, shows a card and the file open or running in canvas, if it's a godot
 * game or whatever, that should show up as well in the canvas as well, able to
 * work. this also will show the model an immediate preview of the file/game/
 * project via returning an image or output whatever applicable, it will
 * essentially force a review and iteration if at this last minute it sees,
 * something is wrong."
 *
 * WHY IT IS A TOOL AND NOT A PROMPT LINE. "Check your work before you finish" is
 * already in the system prompt, and it is obeyed unevenly, because checking is
 * optional and stopping is free. Making the LAST ACT a tool call that returns the
 * artefact's own preview removes the choice: the model cannot hand something over
 * without receiving a picture of it back. A wrong render, an empty file, a page
 * that does not load — all of them arrive in context while there is still a turn
 * left to fix them.
 *
 * TOP-LEVEL ONLY, deliberately. A subagent reports to the model that spawned it,
 * not to the person; letting a child "present" would put artefacts in front of a
 * user nobody had decided to show them to. Registration is gated on subagent
 * depth, the same gate `spawn_subagent` uses.
 *
 * The preview is chosen by what the thing IS — see {@link previewPlanFor}, which
 * is pure and carries the whole policy.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';

export const PRESENT_TOOL_NAME = 'present';

/** How a given artefact should be previewed back to the model. */
export type PreviewKind =
  /** Read the bytes and return them as an image the model can see. */
  | 'image'
  /** Open it in the built-in browser and screenshot what renders. */
  | 'render'
  /** Run it and return what it printed. */
  | 'run'
  /** Return the text itself (head of it). */
  | 'text'
  /** List what is inside, plus the entry point if there is an obvious one. */
  | 'project'
  /** Nothing better available: report type and size honestly. */
  | 'describe';

export interface PreviewPlan {
  readonly kind: PreviewKind;
  /** Why this preview was chosen — shown to the model so a fallback is not silent. */
  readonly because: string;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const RENDER_EXT = new Set(['.html', '.htm']);
const RUN_EXT = new Set(['.py', '.sh', '.mjs', '.js', '.ts']);
const TEXT_EXT = new Set([
  '.md',
  '.txt',
  '.json',
  '.csv',
  '.yml',
  '.yaml',
  '.toml',
  '.css',
  '.rs',
  '.go',
  '.c',
  '.h',
  '.cpp',
  '.java',
  '.rb',
  '.gd',
  '.tscn',
  '.godot',
]);

/** Lowercased extension including the dot, or '' for none. */
export function extensionOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * Decide how to preview something.
 *
 * A DIRECTORY is a project: a Godot game, a web app, a folder of renders. Those
 * are the cases where "it exists" is most likely to be mistaken for "it works",
 * so they get listed and their entry point named rather than described.
 */
export function previewPlanFor(target: { path: string; isDirectory: boolean }): PreviewPlan {
  if (target.isDirectory) {
    return { kind: 'project', because: 'a folder — listing it and naming its entry point' };
  }
  const ext = extensionOf(target.path);
  if (IMAGE_EXT.has(ext)) return { kind: 'image', because: `an image (${ext})` };
  if (RENDER_EXT.has(ext)) {
    return { kind: 'render', because: 'a page — opening it and capturing what renders' };
  }
  if (RUN_EXT.has(ext)) return { kind: 'run', because: `a script (${ext}) — running it` };
  if (TEXT_EXT.has(ext) || ext === '') {
    return {
      kind: 'text',
      because: ext === '' ? 'no extension — reading it as text' : `text (${ext})`,
    };
  }
  return { kind: 'describe', because: `nothing can render ${ext} here` };
}

/** Entry points worth naming when presenting a folder, most telling first. */
export const PROJECT_ENTRY_POINTS = [
  'project.godot',
  'index.html',
  'package.json',
  'main.py',
  'README.md',
  'Cargo.toml',
] as const;

/** The first recognised entry point in a listing, if any. */
export function entryPointIn(names: readonly string[]): string | undefined {
  return PROJECT_ENTRY_POINTS.find((e) => names.includes(e));
}

/**
 * The line that turns a preview into a decision.
 *
 * Every branch ends here, because the point of the tool is not the card in the
 * UI — it is that the model has to LOOK before it is allowed to be finished.
 */
export function reviewInstruction(): string {
  return (
    'This is what the user will receive. Look at it now, as them: is it actually what ' +
    'they asked for? If anything is wrong, missing, empty or broken, FIX IT and present ' +
    'again — you still have the turn. Only say you are done once this preview is right.'
  );
}

export interface PresentBridge {
  /** Show the card + open the artefact in the canvas. */
  show(req: { path: string; note?: string }): Promise<{ ok: boolean; error?: string }>;
  /** Produce the preview the model sees. */
  preview(req: {
    path: string;
    kind: PreviewKind;
  }): Promise<{ imageBase64?: string; mimeType?: string; text?: string; error?: string }>;
}

export interface PresentToolDeps {
  readonly bridge: PresentBridge | null;
  readonly stat: (p: string) => Promise<{ isDirectory: boolean } | null>;
}

/**
 * Register `present`. Callers gate on subagent depth — a child never gets it.
 */
export function registerPresentTool(pi: ExtensionAPI, deps: PresentToolDeps): void {
  pi.registerTool({
    name: PRESENT_TOOL_NAME,
    label: 'Present',
    description:
      'Show the user a finished file, folder or project — it appears as a card and opens (or ' +
      'runs) in the canvas beside the chat. Use this as your LAST action when you have made ' +
      'something: a page, an image, a script, a game, a document. It hands you back a preview ' +
      'of what the user will actually see, so you can check it before you say you are done. ' +
      'Present the finished artefact, not an intermediate file.',
    promptSnippet: 'present: show the user the finished artefact and see it yourself first',
    promptGuidelines: [
      'Make this your last action whenever the task produced a file, folder or project.',
      'Read the preview it returns. If the artefact is wrong or empty, fix it and present again.',
    ],
    parameters: Type.Object({
      path: Type.String({
        description: 'Absolute path to the finished file, folder or project to show the user.',
      }),
      note: Type.Optional(
        Type.String({ description: 'One line for the card — what this is. Optional.' }),
      ),
    }),
    async execute(_id, params) {
      const p =
        typeof (params as { path?: unknown })?.path === 'string'
          ? (params as { path: string }).path.trim()
          : '';
      if (p === '') {
        return {
          content: [{ type: 'text', text: 'present needs the "path" of what to show.' }],
          isError: true,
          details: undefined,
        };
      }
      if (deps.bridge === null) {
        return {
          content: [{ type: 'text', text: 'present is unavailable outside the desktop app.' }],
          isError: true,
          details: undefined,
        };
      }
      const info = await deps.stat(p);
      if (info === null) {
        return {
          content: [
            {
              type: 'text',
              text:
                `There is nothing at ${p}. Presenting is the last step — make the artefact ` +
                'first, then present the real path.',
            },
          ],
          isError: true,
          details: undefined,
        };
      }
      const plan = previewPlanFor({ path: p, isDirectory: info.isDirectory });
      const note = (params as { note?: string }).note;
      const shown = await deps.bridge.show({ path: p, ...(note !== undefined ? { note } : {}) });
      const preview = await deps.bridge.preview({ path: p, kind: plan.kind });

      const content: Array<Record<string, unknown>> = [];
      const head = [
        `Presented ${p} to the user${shown.ok ? '' : ` (the canvas could not open it: ${shown.error ?? 'unknown'})`}.`,
        `Preview: ${plan.because}.`,
      ].join(' ');
      content.push({ type: 'text', text: head });
      if (preview.imageBase64 !== undefined) {
        content.push({
          type: 'image',
          data: preview.imageBase64,
          mimeType: preview.mimeType ?? 'image/png',
        });
      }
      if (preview.text !== undefined && preview.text.length > 0) {
        content.push({ type: 'text', text: preview.text });
      }
      if (preview.error !== undefined) {
        content.push({
          type: 'text',
          text:
            `The preview could not be produced: ${preview.error}. That is itself worth ` +
            'checking — if the artefact cannot be opened or run here, the user may hit the ' +
            'same thing.',
        });
      }
      content.push({ type: 'text', text: reviewInstruction() });
      return { content, details: undefined } as never;
    },
  });
}
