/**
 * Build the message body pi actually receives from the typed text + attached
 * text files. The send path is otherwise images-only, so text-file contents are
 * folded in as fenced blocks; the visible bubble echoes only the typed text.
 *
 * Shared by the composer's `submit()` and predictive prefill so the prefilled
 * draft is BYTE-IDENTICAL to the sent message — that exact match is what lets the
 * real turn reuse the prefill's KV instead of re-prefilling.
 */
export interface TextFileAttachment {
  readonly name: string;
  readonly text?: string;
}

export function buildAgentMessage(raw: string, textFiles: readonly TextFileAttachment[]): string {
  const fileBlocks = textFiles
    .map((a) => `Attached file \`${a.name}\`:\n\`\`\`\n${a.text ?? ''}\n\`\`\``)
    .join('\n\n');
  if (fileBlocks.length === 0) return raw;
  return raw.length > 0 ? `${fileBlocks}\n\n${raw}` : fileBlocks;
}
