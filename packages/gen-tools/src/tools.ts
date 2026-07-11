/**
 * The `generate_image` tool — the model's request to synthesise an image. It
 * validates + normalises the request against the modality catalog, enqueues a
 * job over the gen bridge (the app's JobQueue runs mflux/MLX and streams
 * progress to the canvas), and returns the produced image(s): a text summary
 * carrying the model-name FOOTNOTE plus the pixels as `image` blocks so a
 * vision-capable chat model can see (and, in phase 2, critique) its own output.
 *
 * Loaded outside Pi Desktop (no bridge env) the tool still registers but reports
 * a clear "bridge unavailable" error, so the extension is always safe to load.
 */
import { readFile } from 'node:fs/promises';
import type { AgentToolResult, ExtensionAPI } from '@mariozechner/pi-coding-agent';
import {
  defaultImageModel,
  type GenOutput,
  getModel,
  modelsForModality,
} from '@pi-desktop/gen-service';
import { Type } from '@sinclair/typebox';
import type { GenBridge } from './gen-bridge-client.js';
import type { GenerateImageResult } from './gen-contract.js';

export const GENERATE_IMAGE_TOOL = 'generate_image';

/** Attach at most this many candidate images back to the model (context budget). */
const MAX_ATTACHED_IMAGES = 4;
/** Skip attaching an image larger than this (keep the context sane). */
const MAX_ATTACH_BYTES = 6 * 1024 * 1024;

interface GenerateDetails {
  ok: boolean;
  jobId?: string;
  model?: string;
  outputs?: readonly GenOutput[];
  error?: string;
  [k: string]: unknown;
}

export interface GenToolsOptions {
  /** The bridge to the app; null → tools report a clear unavailable error. */
  readonly bridge: GenBridge | null;
  /** Injectable image reader (tests). Default: fs.readFile. */
  readonly readImage?: (path: string) => Promise<Buffer>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errResult(message: string): AgentToolResult<GenerateDetails> {
  return {
    content: [{ type: 'text', text: `generate_image failed: ${message}` }],
    details: { ok: false, error: message },
  };
}

/** Parse a `<w>x<h>` size string into even, bounded dimensions. */
export function parseSize(size: string | undefined): { width: number; height: number } {
  const fallback = { width: 1024, height: 1024 };
  if (size === undefined) return fallback;
  const m = /^(\d{2,4})\s*[x×]\s*(\d{2,4})$/i.exec(size.trim());
  if (m === null) return fallback;
  const clamp = (n: number): number => Math.max(256, Math.min(1536, Math.round(n / 16) * 16));
  return { width: clamp(Number(m[1])), height: clamp(Number(m[2])) };
}

const IMAGE_MODEL_IDS = modelsForModality('image').map((m) => m.id);

/** Register the generation tool set onto `pi`. */
export function registerGenTools(pi: ExtensionAPI, options: GenToolsOptions): void {
  const bridge = options.bridge;
  const readImage = options.readImage ?? ((p: string) => readFile(p));

  pi.registerTool({
    name: GENERATE_IMAGE_TOOL,
    label: 'Generate: Image',
    description:
      'Generate an image from a text prompt, locally on-device (Apple-Silicon MLX). Returns the ' +
      'image(s) and opens them on the canvas with a live progress bar. Every result is footnoted ' +
      `with the model that made it. Available models: ${IMAGE_MODEL_IDS.join(', ')} ` +
      '(default is a fast, Apache-licensed model). Use size like "512x512" or "1024x1024"; higher ' +
      'sizes and step counts are slower.',
    promptSnippet: 'Generate an image from a text prompt (on-device)',
    parameters: Type.Object({
      prompt: Type.String({
        description: 'What to draw. Be specific about subject, style, lighting.',
      }),
      model: Type.Optional(
        Type.String({
          description: `Model id. One of: ${IMAGE_MODEL_IDS.join(', ')}. Default: fast model.`,
        }),
      ),
      size: Type.Optional(
        Type.String({ description: 'Image size "WxH" (e.g. "512x512"). Default "1024x1024".' }),
      ),
      n: Type.Optional(
        Type.Number({
          description: 'Number of candidates to generate (distinct seeds). Default 1.',
        }),
      ),
      steps: Type.Optional(
        Type.Number({ description: 'Denoising steps (model default if omitted).' }),
      ),
      seed: Type.Optional(Type.Number({ description: 'Base RNG seed for reproducibility.' })),
      negative_prompt: Type.Optional(Type.String({ description: 'What to avoid in the image.' })),
    }),
    async execute(_id, params): Promise<AgentToolResult<GenerateDetails>> {
      if (bridge === null) {
        return errResult(
          'generation bridge unavailable (the gen-tools extension must run inside Pi Desktop)',
        );
      }
      // Resolve + validate the model against the catalog.
      const modelId = params.model ?? defaultImageModel().id;
      const model = getModel(modelId);
      if (model === undefined || model.modality !== 'image') {
        return errResult(
          `unknown image model "${modelId}". Choose one of: ${IMAGE_MODEL_IDS.join(', ')}`,
        );
      }

      try {
        const result = await bridge.request<GenerateImageResult>('generate', {
          prompt: params.prompt,
          model: modelId,
          size: params.size,
          n: params.n,
          steps: params.steps,
          seed: params.seed,
          negativePrompt: params.negative_prompt,
        });

        const outputs = result.outputs;
        if (outputs.length === 0) return errResult('the generator produced no images');

        const footnote = `Model: ${model.label} (${model.id}, ${model.license})`;
        const lines = outputs.map(
          (o, i) => `  ${i + 1}. ${o.outputPath}${o.seed !== undefined ? ` (seed ${o.seed})` : ''}`,
        );
        const text =
          `Generated ${outputs.length} image${outputs.length === 1 ? '' : 's'} on the canvas:\n` +
          `${lines.join('\n')}\n${footnote}`;

        const content: AgentToolResult<GenerateDetails>['content'] = [{ type: 'text', text }];
        // Attach the pixels so a vision-capable model can see its output.
        for (const output of outputs.slice(0, MAX_ATTACHED_IMAGES)) {
          try {
            const bytes = await readImage(output.outputPath);
            if (bytes.length <= MAX_ATTACH_BYTES) {
              content.push({
                type: 'image',
                data: bytes.toString('base64'),
                mimeType: 'image/png',
              });
            }
          } catch {
            // Best-effort: the path is already in the text if the read fails.
          }
        }

        return {
          content,
          details: { ok: true, jobId: result.jobId, model: model.id, outputs },
        };
      } catch (err) {
        return errResult(messageOf(err));
      }
    },
  });
}
