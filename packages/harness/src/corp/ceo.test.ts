import { describe, expect, it } from 'vitest';
import type { ProductManifest } from './assemble.js';
import {
  buildCeoReviewPrompt,
  CEO_REVIEW_PROMPT,
  type CeoReviewInput,
  parseCeoDecision,
} from './ceo.js';
import { tierForRole } from './prompts.js';
import type { VerifyResult } from './verify.js';

function manifest(overrides: Partial<ProductManifest> = {}): ProductManifest {
  return {
    divisions: [
      { id: 'division-fe', name: 'Frontend' },
      { id: 'division-story', name: 'Storyline' },
    ],
    files: [
      { slot: 'src/app.tsx', path: '/ws/src/app.tsx', bytes: 512 },
      { slot: 'src/game/state.ts', path: '/ws/src/game/state.ts', bytes: 256 },
    ],
    interfaces: [
      {
        name: 'GameState',
        exposedBy: 'Frontend',
        path: 'src/game/state.ts',
        summary: 'the shared store',
        consumedBy: ['Storyline'],
      },
    ],
    contractStatusSummary: { done: 8, failed: 1, skipped: 0 },
    totalBytes: 768,
    ...overrides,
  };
}

function verify(overrides: Partial<VerifyResult> = {}): VerifyResult {
  return { ok: true, filesChecked: 2, errors: [], ...overrides };
}

describe('CEO_REVIEW_PROMPT (clean-context, false-completion cure)', () => {
  it('frames the vision-only second opinion and asks for an unambiguous verdict', () => {
    expect(CEO_REVIEW_PROMPT).toContain('never saw the build');
    expect(CEO_REVIEW_PROMPT.toLowerCase()).toContain('false completion');
    expect(CEO_REVIEW_PROMPT).toContain('APPROVE');
    expect(CEO_REVIEW_PROMPT).toContain('REVISE');
    // Objective evidence is ground truth.
    expect(CEO_REVIEW_PROMPT.toLowerCase()).toContain('verification');
  });

  it('the CEO runs the intelligent tier (spec §8)', () => {
    expect(tierForRole('ceo')).toBe('intelligent');
  });
});

describe('buildCeoReviewPrompt (seeded with ONLY task + manifest + verify)', () => {
  const input: CeoReviewInput = {
    originalTask: 'Build a 3D browser game with a storyline and UI',
    manifest: manifest(),
    verifyResult: verify(),
  };

  it('carries the original task as the standard', () => {
    const prompt = buildCeoReviewPrompt(input);
    expect(prompt).toContain('ORIGINAL TASK');
    expect(prompt).toContain('Build a 3D browser game with a storyline and UI');
  });

  it('carries the product manifest (divisions, files, interfaces, outcomes)', () => {
    const prompt = buildCeoReviewPrompt(input);
    expect(prompt).toContain('Frontend, Storyline');
    expect(prompt).toContain('src/app.tsx (512 bytes)');
    expect(prompt).toContain('GameState — exposed by Frontend at src/game/state.ts');
    expect(prompt).toContain('8 done, 1 failed, 0 not completed');
  });

  it('carries the objective verify evidence (pass and fail render distinctly)', () => {
    expect(buildCeoReviewPrompt(input)).toContain('Result: PASS (2 file(s) checked)');
    const failing = buildCeoReviewPrompt({
      ...input,
      verifyResult: verify({
        ok: false,
        errors: [{ file: '/ws/src/app.tsx', message: 'unbalanced brace' }],
      }),
    });
    expect(failing).toContain('Result: FAIL');
    expect(failing).toContain('/ws/src/app.tsx: unbalanced brace');
  });

  it('clean-context isolation: the input type carries no build transcript, so none can leak', () => {
    // The whole prompt is a pure function of (originalTask, manifest, verifyResult).
    // A build-transcript string is impossible to seed — there is no field for it.
    const prompt = buildCeoReviewPrompt(input);
    expect(prompt).not.toContain('engineer');
    expect(prompt).not.toContain('draft');
    expect(prompt).not.toContain('self-review');
  });
});

describe('parseCeoDecision', () => {
  it('parses a plain approval (no notes)', () => {
    expect(parseCeoDecision('APPROVE')).toEqual({ decision: 'approve' });
    expect(parseCeoDecision('approve\n')).toEqual({ decision: 'approve' });
  });

  it('parses a revise with the notes following the verdict', () => {
    const reply = 'REVISE\nThe Storyline division produced no files — the narrative is missing.';
    expect(parseCeoDecision(reply)).toEqual({
      decision: 'revise',
      notes: 'The Storyline division produced no files — the narrative is missing.',
    });
  });

  it('is tolerant of prose around the verdict', () => {
    const approved = 'Having reviewed the product against the vision, I APPROVE. Great work.';
    expect(parseCeoDecision(approved).decision).toBe('approve');

    const revised =
      "I'm going to revise this: the UI lacks the empty and error states we agreed on.";
    const d = parseCeoDecision(revised);
    expect(d.decision).toBe('revise');
    expect(d.notes).toContain('empty and error states');
  });

  it('parses a structured JSON verdict', () => {
    expect(parseCeoDecision('{"decision":"approve"}')).toEqual({ decision: 'approve' });
    expect(parseCeoDecision('{"decision":"revise","notes":"tighten the copy"}')).toEqual({
      decision: 'revise',
      notes: 'tighten the copy',
    });
  });

  it('does NOT rubber-stamp: an unparseable / empty reply defaults to revise', () => {
    expect(parseCeoDecision('').decision).toBe('revise');
    expect(parseCeoDecision('hmm, interesting').decision).toBe('revise');
    // The whole reply is carried back as notes so the manager has something to act on.
    expect(parseCeoDecision('hmm, interesting').notes).toBe('hmm, interesting');
  });

  it('the earliest decisive keyword wins when both appear (the prompt asks it to lead)', () => {
    expect(parseCeoDecision('REVISE — do not approve until the UI is fixed.').decision).toBe(
      'revise',
    );
    expect(parseCeoDecision('APPROVE; no need to revise anything.').decision).toBe('approve');
  });
});
