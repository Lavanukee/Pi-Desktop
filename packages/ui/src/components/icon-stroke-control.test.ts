import { describe, expect, it } from 'vitest';
import { clampIconStroke, ICON_STROKE_MAX, ICON_STROKE_MIN } from './icon-stroke-control.tsx';

describe('clampIconStroke', () => {
  it('floors sub-minimum values at 1.0 (nothing renders thinner)', () => {
    expect(clampIconStroke(0.5)).toBe(ICON_STROKE_MIN);
    expect(clampIconStroke(0)).toBe(ICON_STROKE_MIN);
    expect(clampIconStroke(-3)).toBe(ICON_STROKE_MIN);
    expect(ICON_STROKE_MIN).toBe(1);
  });

  it('caps values above the maximum', () => {
    expect(clampIconStroke(9)).toBe(ICON_STROKE_MAX);
    expect(ICON_STROKE_MAX).toBe(2.5);
  });

  it('passes in-range values through untouched', () => {
    expect(clampIconStroke(1)).toBe(1);
    expect(clampIconStroke(1.25)).toBe(1.25);
    expect(clampIconStroke(2.5)).toBe(2.5);
  });

  it('treats the bounds as inclusive', () => {
    expect(clampIconStroke(ICON_STROKE_MIN)).toBe(ICON_STROKE_MIN);
    expect(clampIconStroke(ICON_STROKE_MAX)).toBe(ICON_STROKE_MAX);
  });

  it('falls back to the minimum for non-finite input', () => {
    expect(clampIconStroke(Number.NaN)).toBe(ICON_STROKE_MIN);
    expect(clampIconStroke(Number.POSITIVE_INFINITY)).toBe(ICON_STROKE_MIN);
    expect(clampIconStroke(Number.NEGATIVE_INFINITY)).toBe(ICON_STROKE_MIN);
  });

  it('honors custom bounds when provided', () => {
    expect(clampIconStroke(1, 1.5, 2)).toBe(1.5);
    expect(clampIconStroke(3, 1.5, 2)).toBe(2);
    expect(clampIconStroke(1.75, 1.5, 2)).toBe(1.75);
  });
});
