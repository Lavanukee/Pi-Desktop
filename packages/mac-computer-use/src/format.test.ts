/**
 * A snapshot must always come back with something the model can act on.
 *
 * jedd, on Mac computer-use: it "constantly will return something that just
 * isn't able to do anything, it also gives some useless information to the model
 * sometimes about it being AX opaque ... if there's really no other option it
 * just has to return an image of the app window and a blurb that says 'control
 * the application via coordinates'."
 */
import { describe, expect, it } from 'vitest';
import { formatMacSnapshot, isAxOpaque } from './format';
import type { MacSnapshot } from './protocol';

const snap = (over: Partial<MacSnapshot> = {}): MacSnapshot =>
  ({
    app: 'Photoshop',
    window: 'Untitled-1',
    pid: 42,
    elements: [],
    summary: { app: 'Photoshop', window: 'Untitled-1', elementCount: 0, truncated: false },
    ...over,
  }) as MacSnapshot;

describe('an app that tells Accessibility nothing', () => {
  it('is recognised, rather than treated as an error', () => {
    // Normal for a large slice of the Mac: anything drawing its own UI.
    expect(isAxOpaque(snap())).toBe(true);
    expect(
      isAxOpaque(
        snap({
          elements: [{ index: 0, role: 'AXButton', name: 'OK' }] as MacSnapshot['elements'],
        }),
      ),
    ).toBe(false);
  });

  it('says to work in COORDINATES, and points at the image', () => {
    const text = formatMacSnapshot(snap());
    expect(text).toContain('CONTROL THE APPLICATION VIA COORDINATES');
    expect(text).toContain('screenshot attached below IS your view');
    // The old dead end — telling the model to call the same tool again — is gone.
    expect(text).not.toContain('request a screenshot');
  });

  it('gives the window geometry, so a point read off the image maps to the screen', () => {
    const text = formatMacSnapshot(snap({ windowBounds: { x: 100, y: 60, w: 1200, h: 800 } }));
    expect(text).toContain('x=100');
    expect(text).toContain('y=60');
    expect(text).toContain('w=1200');
    expect(text).toContain('h=800');
  });

  it('still lists elements normally when Accessibility DOES answer', () => {
    const text = formatMacSnapshot(
      snap({
        elements: [
          { index: 0, role: 'AXButton', name: 'Save' },
          { index: 1, role: 'AXTextField', name: 'Name', editable: true },
        ] as MacSnapshot['elements'],
        summary: { app: 'Photoshop', window: 'Untitled-1', elementCount: 2, truncated: false },
      }),
    );
    expect(text).toContain('[0] AXButton "Save"');
    expect(text).toContain('(editable)');
    expect(text).not.toContain('COORDINATES');
  });
});
