import { describe, expect, it } from 'vitest';
import { deliveryConstraintLines, deriveDeliveryShape } from './delivery.js';

describe('deriveDeliveryShape (spec §5/§8, Part B — derived from the vision text)', () => {
  it('flags an openable, no-build, single-file web vision (the Snake defect)', () => {
    const shape = deriveDeliveryShape(
      'A playable Snake game — ONE index.html that opens directly in a browser without Node.js/npm/build.',
    );
    expect(shape.openableSingleFile).toBe(true);
    expect(shape.web).toBe(true);
  });

  it('flags "no build" and "single file" and "self-contained" independently', () => {
    expect(deriveDeliveryShape('A web app with no build step.').openableSingleFile).toBe(true);
    expect(deriveDeliveryShape('Ship a single HTML file.').openableSingleFile).toBe(true);
    expect(deriveDeliveryShape('A self-contained page you double-click.').openableSingleFile).toBe(
      true,
    );
    expect(deriveDeliveryShape('It runs without a server.').openableSingleFile).toBe(true);
  });

  it('a plain web vision is web but NOT openable-single-file', () => {
    const shape = deriveDeliveryShape('Build a browser game with a canvas and a HUD.');
    expect(shape.web).toBe(true);
    expect(shape.openableSingleFile).toBe(false);
  });

  it('a pure-logic / CLI vision is neither web nor openable', () => {
    const shape = deriveDeliveryShape('Build a CLI tool that sorts numbers.');
    expect(shape.web).toBe(false);
    expect(shape.openableSingleFile).toBe(false);
  });

  it('openableSingleFile implies web', () => {
    // "no build" alone (no explicit web word) still implies a web/openable artifact.
    const shape = deriveDeliveryShape('Deliver it with no bundler and no npm.');
    expect(shape.openableSingleFile).toBe(true);
    expect(shape.web).toBe(true);
  });

  it('never throws on a blank/odd vision', () => {
    expect(deriveDeliveryShape('')).toEqual({ openableSingleFile: false, web: false });
    // A non-string input degrades to the neutral shape rather than throwing.
    expect(deriveDeliveryShape(undefined as unknown as string)).toEqual({
      openableSingleFile: false,
      web: false,
    });
  });
});

describe('deliveryConstraintLines', () => {
  it('splices the self-contained-openable constraint for an openable shape', () => {
    const lines = deliveryConstraintLines({ openableSingleFile: true, web: true });
    const text = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(text).toContain('DELIVERY CONSTRAINT');
    expect(text).toContain('opens DIRECTLY');
    expect(text.toLowerCase()).toContain('no build');
    expect(text).toContain('SELF-CONTAINED');
    expect(text.toLowerCase()).toContain('bundler-dependent module graph');
  });

  it('is empty for a non-openable (plain web or pure-logic) shape', () => {
    expect(deliveryConstraintLines({ openableSingleFile: false, web: true })).toEqual([]);
    expect(deliveryConstraintLines({ openableSingleFile: false, web: false })).toEqual([]);
  });
});
