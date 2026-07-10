import type { Story } from '@ladle/react';
import { CodeBlock, Markdown, Prose } from '../index.ts';
import { Story as Frame } from './helpers.tsx';

const MARKDOWN_SOURCE = `## Serving Qwen3.6 with MTP

The response voice is the flavor split: **claude** renders serif 16/1.5, **codex**
system sans 14/22. Inline commands like \`python3\` and paths like
\`/home/claude/extract_check.py\` render in a subtle rounded mono box.

An inline hex color \`#0a84ff\` gets a swatch chip; so does \`#ffffff\`.

- MTP is mutually exclusive with multimodal projection.
- Use \`-np 1\` per instance; see [the launch notes](#docs).

Bring it up in three steps:

1. Download the quantized weights.
2. Verify the checksum.
3. Launch the server with \`-np 1\`.

Block math renders offline via KaTeX:

$$ \\mathrm{VRAM} \\approx P \\cdot b_\\text{q} + \\frac{2 \\cdot L \\cdot d}{10^9} $$

and inline math like $E = mc^2$ sits in the paragraph.

| Quant | Size | Fits 24GB |
| --- | --- | --- |
| Q4_K_M | 16.4 GB | Yes |
| Q8_0 | 28.9 GB | No |

\`\`\`ts
export function launch(model: ModelSpec): ServerHandle {
  return spawnLlamaServer(['--model', model.path]);
}
\`\`\`
`;

const SAMPLE_CODE = `export function launchServer(model: ModelSpec): ServerHandle {
  const args = ['--model', model.path, '--ctx-size', String(model.ctx)];
  if (model.mtp) {
    args.push('--spec-type', 'draft-mtp', '--spec-draft-n-max', '2');
  }
  return spawnLlamaServer(args);
}`;

export const ProseElements: Story = () => (
  <Frame>
    <Prose>
      <h2>Serving Qwen3.6 with MTP</h2>
      <p>
        The response voice is the core flavor split: claude renders this in a serif at 16/1.5
        (dropping to weight 360 in dark mode), codex in the system sans at 14/22. Inline code like{' '}
        <code>--spec-type draft-mtp</code> diverges too — danger-tinted with a hairline in claude, a
        neutral wash chip in codex.
      </p>
      <ul>
        <li>MTP is mutually exclusive with multimodal projection.</li>
        <li>
          Use <code>-np 1</code> per instance; see <a href="#docs">the launch notes</a>.
        </li>
        <li>Checksums verify after download.</li>
      </ul>
      <blockquote>
        Quantization is a trade: Q4_K_M keeps 97% of quality at 40% of the memory.
      </blockquote>
      <div className="pd-prose-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Quant</th>
              <th>Size</th>
              <th>Fits 24GB</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Q4_K_M</td>
              <td>16.4 GB</td>
              <td>Yes</td>
            </tr>
            <tr>
              <td>Q8_0</td>
              <td>28.9 GB</td>
              <td>No</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Prose>
  </Frame>
);

export const Code: Story = () => (
  <Frame>
    <div style={{ maxWidth: 640 }}>
      <CodeBlock language="typescript" code={SAMPLE_CODE} showLineNumbers />
    </div>
  </Frame>
);

/**
 * The reusable Markdown component (round-3 #P4): react-markdown + gfm + KaTeX,
 * with hex swatches, boxed inline code, tables, lists and fenced CodeBlocks.
 */
export const MarkdownRenderer: Story = () => (
  <Frame>
    <div style={{ maxWidth: 680 }}>
      <Markdown>{MARKDOWN_SOURCE}</Markdown>
    </div>
  </Frame>
);
