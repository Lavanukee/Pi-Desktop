/**
 * Artifact detection for the canvas: scans the streamed assistant messages for
 * fenced ```svg / ```html blocks and turns them into canvas Artifacts that the
 * W7 <Canvas> renders live ("draw as code streams"). Only renderable kinds
 * (svg, html) become artifacts — ordinary code fences stay inline in the
 * markdown. The full accumulated body is always emitted (canvas surfaces diff
 * internally; streaming is replace-with-snapshot, not deltas).
 */
import type { Artifact } from '@pi-desktop/canvas';
import type { ChatMsg } from '@pi-desktop/engine';
import type { CanvasArtifactPayload } from '../../../electron/ipc-contract';

export interface DetectedArtifact {
  /** Stable across tokens (message id + block index) so the active selection
   * and auto-open logic survive streaming. */
  id: string;
  messageId: string;
  kind: 'svg' | 'html';
  /** Full accumulated source so far. */
  text: string;
  /** The fence is still open AND the message is streaming. */
  streaming: boolean;
  title: string;
  filename: string;
}

/** Fence language → renderable artifact kind. */
const ARTIFACT_LANGS: Record<string, 'svg' | 'html'> = {
  svg: 'svg',
  html: 'html',
  htm: 'html',
};

function assistantText(msg: Extract<ChatMsg, { kind: 'assistant' }>): string {
  return msg.blocks
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * An ordered piece of one assistant text block: either a run of markdown (which
 * the thread renders through `<Markdown>`) or a renderable artifact fence
 * (```svg / ```html) that becomes an inline widget / canvas tab at THIS spot.
 * This is what powers A1 — interleaving widgets at their source position rather
 * than piling them at the thread foot.
 */
export type AssistantTextSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'artifact'; artifact: DetectedArtifact };

/**
 * Split one assistant text block into ordered markdown runs + renderable
 * artifacts. Non-renderable fences (plain ```js code) stay verbatim inside the
 * markdown runs. `startIndex` continues the per-MESSAGE fence counter so ids
 * stay `${messageId}-a${n}` even when a message has several text blocks — this
 * keeps them identical to `detectArtifacts` (which scans the joined message
 * text), so inline↔canvas dedup by id still holds.
 */
export function segmentMessageText(
  text: string,
  messageId: string,
  streamingMessage: boolean,
  startIndex = 0,
): { segments: AssistantTextSegment[]; nextIndex: number } {
  const segments: AssistantTextSegment[] = [];
  const lines = text.split('\n');
  let i = 0;
  let index = startIndex;
  let md: string[] = [];
  const flushMd = (): void => {
    if (md.length === 0) return;
    // Drop the blank lines that hugged the extracted fence so a run reads as a
    // clean paragraph (leading indentation on real content is preserved).
    const run = md.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    if (run.trim().length > 0) segments.push({ kind: 'markdown', text: run });
    md = [];
  };
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = /^```([\w-]+)?\s*$/.exec(line);
    if (fence === null) {
      md.push(line);
      i++;
      continue;
    }
    const lang = (fence[1] ?? '').toLowerCase();
    const kind = ARTIFACT_LANGS[lang];
    const raw: string[] = [line];
    const body: string[] = [];
    i++;
    let closed = false;
    while (i < lines.length) {
      const cur = lines[i] ?? '';
      raw.push(cur);
      if (/^```\s*$/.test(cur)) {
        closed = true;
        i++;
        break;
      }
      body.push(cur);
      i++;
    }
    if (kind !== undefined && body.join('').trim().length > 0) {
      flushMd();
      segments.push({
        kind: 'artifact',
        artifact: {
          id: `${messageId}-a${index}`,
          messageId,
          kind,
          text: body.join('\n'),
          streaming: !closed && streamingMessage,
          title: kind === 'svg' ? 'SVG' : 'HTML',
          filename: kind === 'svg' ? 'artifact.svg' : 'artifact.html',
        },
      });
      index++;
    } else {
      // Not a renderable artifact — keep the raw fence in the markdown flow.
      md.push(...raw);
    }
  }
  flushMd();
  return { segments, nextIndex: index };
}

/** Scan one message's text for artifact fences. */
function detectInText(
  text: string,
  messageId: string,
  streamingMessage: boolean,
): DetectedArtifact[] {
  return segmentMessageText(text, messageId, streamingMessage)
    .segments.filter(
      (s): s is Extract<AssistantTextSegment, { kind: 'artifact' }> => s.kind === 'artifact',
    )
    .map((s) => s.artifact);
}

/** All artifacts across the thread, oldest→newest. */
export function detectArtifacts(messages: ChatMsg[]): DetectedArtifact[] {
  const out: DetectedArtifact[] = [];
  for (const m of messages) {
    if (m.kind !== 'assistant') continue;
    out.push(...detectInText(assistantText(m), m.id, m.isStreaming === true));
  }
  return out;
}

/** DetectedArtifact → the canvas package's Artifact model. */
export function toCanvasArtifact(d: DetectedArtifact): Artifact {
  return {
    id: d.id,
    title: d.title,
    filename: d.filename,
    content: {
      kind: d.kind,
      text: d.text,
      mimeType: d.kind === 'svg' ? 'image/svg+xml' : 'text/html',
    },
  };
}

/** Artifact → the JSON-serializable pop-out payload (main-process boundary). */
export function artifactToPayload(a: Artifact): CanvasArtifactPayload {
  return {
    id: a.id,
    title: a.title,
    filename: a.filename,
    content: {
      kind: String(a.content.kind),
      text: a.content.text,
      language: a.content.language,
      mimeType: a.content.mimeType,
    },
  };
}

/** Pop-out payload → Artifact (the standalone canvas window). */
export function payloadToArtifact(p: CanvasArtifactPayload): Artifact {
  return {
    id: p.id,
    title: p.title,
    filename: p.filename,
    content: {
      kind: p.content.kind,
      text: p.content.text,
      language: p.content.language,
      mimeType: p.content.mimeType,
    },
  };
}
