/**
 * Rule-based contextual suggestion chips (v1). Empty composer → starter
 * prompts; typing certain trigger words surfaces an action chip that rewrites
 * the draft. The utility-model-driven version is a later workstream; these are
 * pure heuristics with a fallback the way the plan's classifier degrades.
 */
export interface Suggestion {
  id: string;
  label: string;
  /** Replacement draft applied when the chip is accepted. */
  text: string;
}

export function suggestionsFor(text: string): Suggestion[] {
  const trimmed = text.trim();
  if (trimmed === '') {
    return [
      {
        id: 'explain',
        label: 'Explain this codebase',
        text: 'Explain the architecture of this codebase.',
      },
      { id: 'script', label: 'Write a script', text: 'Write a script that ' },
      { id: 'debug', label: 'Debug an error', text: 'Help me debug this error:\n' },
    ];
  }
  const t = trimmed.toLowerCase();
  const out: Suggestion[] = [];
  if (/\b(research|investigate|compare|sources?)\b/.test(t)) {
    out.push({
      id: 'research',
      label: 'Deep research',
      text: `${trimmed}\n\nDo thorough, multi-source research and cite sources before answering.`,
    });
  }
  if (/\b(presentation|slides|deck)\b/.test(t)) {
    out.push({
      id: 'deck',
      label: 'Make a presentation',
      text: `${trimmed}\n\nProduce a slide-by-slide outline.`,
    });
  }
  if (/\b(test|bug|error|fix|failing|broken)\b/.test(t)) {
    out.push({
      id: 'debug',
      label: 'Debug & add tests',
      text: `${trimmed}\n\nReproduce it, fix the root cause, and add a regression test.`,
    });
  }
  return out;
}
