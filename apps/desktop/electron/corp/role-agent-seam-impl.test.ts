import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSubmitReviewGate,
  newSubmitReviewCapture,
  seedIsolatedWorkspace,
  toToolDefinition,
} from './role-agent-seam-impl';

describe('createSubmitReviewGate — the §164 submission interceptor', () => {
  const REVIEW = 'Re-read your contract and improve the file, then submit again.';

  it('BOUNCES on the first call (returns the self-review prompt, does not finalize)', () => {
    const capture = newSubmitReviewCapture();
    const gate = createSubmitReviewGate({
      slot: 'src/game/physics.ts',
      reviewPrompt: REVIEW,
      readSlot: () => 'draft-contents',
      capture,
    });
    expect(gate()).toBe(REVIEW);
    expect(capture.bounced).toBe(true);
    expect(capture.finalized).toBe(false);
    expect(capture.draftBytes).toBe('draft-contents'.length);
  });

  it('FINALIZES on the second call and records whether the file CHANGED', () => {
    const capture = newSubmitReviewCapture();
    let content = 'draft';
    const gate = createSubmitReviewGate({
      slot: 'src/game/physics.ts',
      reviewPrompt: REVIEW,
      readSlot: () => content,
      capture,
    });
    gate(); // bounce (draft snapshot)
    content = 'improved and longer'; // the engineer improved it after the bounce
    const ack = gate();
    expect(ack.toLowerCase()).toContain('submitted');
    expect(capture.finalized).toBe(true);
    expect(capture.changed).toBe(true);
    expect(capture.finalBytes).toBe('improved and longer'.length);
  });

  it('records no change when the second submit finds the same draft', () => {
    const capture = newSubmitReviewCapture();
    const gate = createSubmitReviewGate({
      slot: 's.ts',
      reviewPrompt: REVIEW,
      readSlot: () => 'same',
      capture,
    });
    gate();
    gate();
    expect(capture.changed).toBe(false);
  });

  it('THROWS the actionable error on finalize when the slot file is missing', () => {
    const gate = createSubmitReviewGate({
      slot: 'src/missing.ts',
      reviewPrompt: REVIEW,
      readSlot: () => undefined, // never written
    });
    gate(); // first call bounces regardless
    expect(() => gate()).toThrow(
      'Your slot file src/missing.ts does not exist yet — write it before submitting.',
    );
  });
});

describe('seedIsolatedWorkspace — isolated engineer workspace (spec §91)', () => {
  let ws: ReturnType<typeof seedIsolatedWorkspace> | undefined;
  let shared: string;

  beforeEach(() => {
    shared = mkdtempSync(path.join(os.tmpdir(), 'corp-shared-'));
  });
  afterEach(() => {
    ws?.dispose();
    rmSync(shared, { recursive: true, force: true });
  });

  it('seeds the deps read-only and HARVESTS only the engineer-written files', () => {
    ws = seedIsolatedWorkspace([
      { path: 'src/engine/vec2.ts', content: 'export interface Vec2 { x: number; y: number }' },
    ]);
    // The dep is present in the isolated dir for the engineer to read.
    expect(readFileSync(path.join(ws.dir, 'src/engine/vec2.ts'), 'utf8')).toContain('Vec2');

    // The engineer writes its OWN slot file (+ a supporting file) into the dir.
    writeFileSync(path.join(ws.dir, 'src/engine/physics.ts'), 'import { Vec2 } from "./vec2";');
    writeFileSync(path.join(ws.dir, 'src/engine/helpers.ts'), 'export const eps = 1e-6;');

    const harvested = ws.harvest(shared);
    const paths = harvested.map((f) => f.path).sort();
    // Slot + supporting file harvested; the read-only dep is NOT harvested back.
    expect(paths).toEqual(['src/engine/helpers.ts', 'src/engine/physics.ts']);
    expect(readFileSync(path.join(shared, 'src/engine/physics.ts'), 'utf8')).toContain('Vec2');
    // The dep was never copied into the shared tree by the harvest.
    expect(harvested.some((f) => f.path === 'src/engine/vec2.ts')).toBe(false);
  });

  it('does NOT harvest an edit the engineer made to a read-only dep (deps are read-only)', () => {
    ws = seedIsolatedWorkspace([{ path: 'dep.ts', content: 'original' }]);
    writeFileSync(path.join(ws.dir, 'dep.ts'), 'MUTATED'); // engineer overwrote a dep
    const harvested = ws.harvest(shared);
    expect(harvested).toHaveLength(0); // nothing new produced → nothing harvested
  });
});

describe('toToolDefinition — submit tool wires the §164 gate against a real cwd', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'corp-tool-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('bounces, then finalizes once the slot file exists in cwd', async () => {
    const capture = newSubmitReviewCapture();
    const def = toToolDefinition(
      {
        name: 'submit_contract',
        description: 'submit',
        parameters: { type: 'object', properties: {}, required: [] },
        submitReview: { slot: 'out.ts', reviewPrompt: 'review-me' },
      },
      dir,
      capture,
    );
    const call = (id: string): Promise<{ content: { text?: string }[] }> =>
      def.execute(id, {} as never, undefined, undefined, {} as never) as Promise<{
        content: { text?: string }[];
      }>;

    const first = await call('c1');
    expect(first.content[0]).toMatchObject({ text: 'review-me' });
    expect(capture.bounced).toBe(true);

    // Missing slot → finalize throws (the model is pushed to write first).
    await expect(call('c2')).rejects.toThrow('does not exist yet');

    // Now the engineer writes the slot → finalize acks.
    writeFileSync(path.join(dir, 'out.ts'), 'export const x = 1;');
    const done = await call('c3');
    expect(done.content[0]?.text?.toLowerCase()).toContain('submitted');
    expect(capture.finalized).toBe(true);
  });

  it('a tool with no submitReview is a plain no-op ack (the promotion tool)', async () => {
    const def = toToolDefinition(
      {
        name: 'create_production_hierarchy',
        description: 'promote',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      dir,
    );
    const res = (await def.execute('c1', {} as never, undefined, undefined, {} as never)) as {
      content: { text?: string }[];
    };
    expect(res.content[0]?.text).toContain('recorded');
  });
});
