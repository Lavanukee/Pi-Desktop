import type { Story } from '@ladle/react';
import { type WebSearchResultData, WebSearchResults } from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

const RESULTS: WebSearchResultData[] = [
  {
    title: 'Local LLM inference on Apple Silicon — a practical guide',
    url: 'https://example.com/a',
    domain: 'developer.apple.com',
  },
  {
    title: "llama.cpp: Port of Facebook's LLaMA model in C/C++",
    url: 'https://example.com/b',
    domain: 'github.com',
  },
  {
    title: 'Quantization formats explained: Q4_K_M vs Q5_K_M vs Q8_0',
    url: 'https://example.com/c',
    domain: 'huggingface.co',
  },
  {
    title: 'Unified memory and model headroom on M-series Macs',
    url: 'https://example.com/d',
    domain: 'news.ycombinator.com',
  },
  {
    title: 'MTP decoding throughput benchmarks',
    url: 'https://example.com/e',
    domain: 'arxiv.org',
  },
  {
    title: 'Choosing a default model for a 24GB machine',
    url: 'https://example.com/f',
    domain: 'reddit.com',
  },
];

export const Results: Story = () => (
  <Frame>
    <Row label="web-search step — header (globe + query + N results) over a scrollable list">
      <div style={{ maxWidth: 520 }}>
        <WebSearchResults query="best local model for 24GB unified memory" results={RESULTS} />
      </div>
    </Row>
    <Row label="single result">
      <div style={{ maxWidth: 520 }}>
        <WebSearchResults query="llama.cpp releases" results={RESULTS.slice(0, 1)} />
      </div>
    </Row>
  </Frame>
);
