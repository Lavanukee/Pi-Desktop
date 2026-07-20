import { describe, expect, it } from 'vitest';
import { parsePromoteSignal, PROMOTE_STATUS_KEY } from './harness-status';

describe('parsePromoteSignal (corp-promote intent from normal chat)', () => {
  it('parses a valid promote signal', () => {
    const raw = JSON.stringify({
      id: 'promote-1',
      reason: 'a large multi-part build',
      divisions: [{ name: 'Frontend', purpose: 'the UI' }],
    });
    const s = parsePromoteSignal(raw);
    expect(s?.id).toBe('promote-1');
    expect(s?.reason).toBe('a large multi-part build');
    expect(s?.divisions).toHaveLength(1);
  });

  it('returns null for absent / empty / garbage / id-less payloads', () => {
    expect(parsePromoteSignal(undefined)).toBeNull();
    expect(parsePromoteSignal('')).toBeNull();
    expect(parsePromoteSignal('{ not json')).toBeNull();
    // Missing the required id → not a real signal (guards against a stray publish).
    expect(parsePromoteSignal(JSON.stringify({ reason: 'x', divisions: [] }))).toBeNull();
  });

  it('mirrors the harness status key exactly', () => {
    expect(PROMOTE_STATUS_KEY).toBe('harness-promote');
  });
});
