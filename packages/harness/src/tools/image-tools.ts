/**
 * `generate_image` + `edit_image` — image generation and editing as ORDINARY
 * CHAT TOOLS, so the text agent can make and revise pictures inline instead of
 * the user having to open the 3D studio's Image panel.
 *
 * Both run on-device through Pi Desktop's gen3d engine (Mage-Flow-Turbo for
 * generation, Mage-Flow-Edit-Turbo for edits, MLX on Metal) via the app bridge —
 * see image-bridge-client.ts for why a socket and not a direct call.
 *
 * ## How the picture reaches the chat
 * The result's first text line is a `pd-file://` URL for the PNG. That is the
 * app's own media scheme (canvas-main.ts): the renderer streams the bytes off
 * disk, and the chat's activity mapping turns that URL into the inline
 * `ThreadImage` under the tool row. Deliberately NOT a base64 data URI: a 1024px
 * PNG is ~1.4 MB, which base64s to ~1.9 MB of tool-result text that would land
 * in BOTH the session JSONL and the model's context on every subsequent turn —
 * hundreds of thousands of tokens to say "here is a picture". A URL is ~90 bytes
 * and renders identically.
 *
 * The second line is the plain absolute path, so the model can feed it straight
 * back to `edit_image` (or to the 3D studio) without parsing a URL.
 */
import type { AgentToolResult, ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { ImageBridge, ImageBridgeResult } from './image-bridge-client.js';
import { imageBridgeFromEnv } from './image-bridge-client.js';

export const GENERATE_IMAGE_TOOL = 'generate_image';
export const EDIT_IMAGE_TOOL = 'edit_image';

interface ImageToolDetails {
  ok: boolean;
  path?: string;
  error?: string;
  [k: string]: unknown;
}

/**
 * An absolute path → the app's `pd-file://` media URL. Mirrors
 * apps/desktop/src/chat/canvas/file-preview.ts (`fileUrl`) and the studio's
 * `pdUrl`; the scheme's host is `f` and each path segment is URL-encoded.
 */
export function pdFileUrl(absPath: string): string {
  return `pd-file://f${absPath.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * A failure the MODEL reads and can relay ("the edit model isn't downloaded
 * yet"), rather than a thrown exception. Matches the repo's other generation
 * tools: the reasons here are all actionable by the user, so they belong in the
 * conversation instead of in a stack trace.
 */
function errorResult(tool: string, message: string): AgentToolResult<ImageToolDetails> {
  return {
    content: [{ type: 'text', text: `${tool} failed: ${message}` }],
    details: { ok: false, error: message },
  };
}

/** Shape the bridge's answer into the tool result the chat renders. */
export function imageToolResult(
  tool: string,
  verb: string,
  result: ImageBridgeResult,
): AgentToolResult<ImageToolDetails> {
  if (!result.ok) return errorResult(tool, result.error);
  return {
    content: [
      {
        type: 'text',
        // Line 1 is the renderable URL (the chat picks the first media URL out
        // of the result text); line 2 is the path for a follow-up edit.
        text: `${pdFileUrl(result.path)}\n${verb} ${result.path}`,
      },
    ],
    details: { ok: true, path: result.path },
  };
}

const GenerateParams = Type.Object({
  prompt: Type.String({
    description:
      'What to draw. Be specific about subject, composition, style and lighting — this is a ' +
      'text-to-image model, not a chat model.',
  }),
});

const EditParams = Type.Object({
  image_path: Type.String({
    description:
      'Absolute path of the image to edit — e.g. the path a previous generate_image returned.',
  }),
  instruction: Type.String({
    description:
      'The change to make, in plain language: "make the jacket red", "put it on a beach at ' +
      'sunset", "remove the hat". This is an instruction-following edit — it keeps the rest of ' +
      'the picture, so do NOT re-describe the whole image and do NOT describe a mask or region.',
  }),
});

/**
 * Register the image tools onto `pi`.
 *
 * GRACEFUL DEGRADATION: with no bridge (a plain CLI pi outside Pi Desktop) the
 * tools are NOT registered — the model never sees a capability the machine
 * can't honour, so there is nothing to fail and nothing to hang. Pass an
 * explicit bridge in tests.
 */
export function registerImageTools(
  pi: ExtensionAPI,
  bridge: ImageBridge | null = imageBridgeFromEnv(),
): void {
  if (bridge === null) return;

  pi.registerTool({
    name: GENERATE_IMAGE_TOOL,
    label: 'Generate Image',
    description:
      'Generate an image from a text prompt, on-device (Mage-Flow-Turbo on Apple-Silicon MLX). ' +
      'The image is shown INLINE in the chat and the result gives you its path on disk, which ' +
      'you can pass to edit_image to revise it. Takes roughly 10-20 seconds warm; the first ' +
      'call of a session also loads the model, which takes longer. Only one generation runs at ' +
      'a time on this machine.',
    promptSnippet:
      'generate_image: make an image from a text prompt (on-device); it renders inline in the chat.',
    parameters: GenerateParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<ImageToolDetails>> {
      const prompt = params.prompt.trim();
      if (prompt === '') return errorResult(GENERATE_IMAGE_TOOL, 'prompt is empty');
      return imageToolResult(
        GENERATE_IMAGE_TOOL,
        'Generated image saved at',
        await bridge.generateImage(prompt, signal),
      );
    },
  });

  pi.registerTool({
    name: EDIT_IMAGE_TOOL,
    label: 'Edit Image',
    description:
      'Edit an existing image with a plain-language instruction ("make the jacket red"), ' +
      'on-device (Mage-Flow-Edit-Turbo on Apple-Silicon MLX). It follows the instruction and ' +
      'leaves the rest of the picture alone — no mask, no region, no full re-description. The ' +
      'edited image is shown INLINE in the chat and saved BESIDE the original, which is left ' +
      'untouched, so you can keep iterating. Use the path a previous generate_image or ' +
      'edit_image returned.',
    promptSnippet:
      'edit_image: change an existing image from a plain-language instruction; renders inline in the chat.',
    parameters: EditParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<ImageToolDetails>> {
      const imagePath = params.image_path.trim();
      const instruction = params.instruction.trim();
      if (imagePath === '') return errorResult(EDIT_IMAGE_TOOL, 'image_path is empty');
      if (instruction === '') return errorResult(EDIT_IMAGE_TOOL, 'instruction is empty');
      return imageToolResult(
        EDIT_IMAGE_TOOL,
        'Edited image saved at',
        await bridge.editImage(imagePath, instruction, signal),
      );
    },
  });
}
