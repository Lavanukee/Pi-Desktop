/**
 * Assistant text runs render through the design-system `Markdown` (round-3 #A13):
 * react-markdown + remark-gfm + remark-math + rehype-katex, with hex swatches,
 * boxed inline code/paths, and fenced code delegated to the shared CodeBlock.
 *
 * `segmentGroup`/`segmentMessageText` peel out the artifact fences (```svg /
 * ```html) BEFORE this renders, so each call receives one plain markdown string
 * (regular code fences still land here and box correctly). The UI `Markdown`
 * renders its OWN `.pd-prose` container — it is NOT wrapped in `<Prose>`.
 */
import { Markdown as UiMarkdown } from '@pi-desktop/ui';

export function Markdown({ text }: { text: string }) {
  return <UiMarkdown>{text}</UiMarkdown>;
}
