import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EffortSlider } from './effort-slider.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './popover.tsx';

/**
 * Popover (round-14 #2) — the non-menu floating surface hosting the effort
 * slider. The node test env has no DOM, so we assert the SSR contract with
 * static markup: the content is gated on `open` (the "opens" behavior), and it
 * carries the shared `.pd-menu` surface. `portal={false}` renders the body
 * inline so it is assertable without a DOM portal (production portals to <body>).
 */
describe('Popover', () => {
  it('closed: renders the trigger but NOT the content body', () => {
    const html = renderToStaticMarkup(
      <Popover>
        <PopoverTrigger data-testid="composer-effort">Auto · Medium</PopoverTrigger>
        <PopoverContent portal={false}>
          <div data-testid="pv-body">slider</div>
        </PopoverContent>
      </Popover>,
    );
    expect(html).toContain('Auto · Medium'); // the trigger label
    expect(html).toContain('pd-menu-trigger'); // shared trigger class
    expect(html).toContain('data-state="closed"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('pv-body'); // content is not mounted while closed
  });

  it('open: the trigger reflects open and the content body mounts on the shared surface', () => {
    const html = renderToStaticMarkup(
      <Popover open>
        <PopoverTrigger data-testid="composer-effort">Auto · Medium</PopoverTrigger>
        <PopoverContent portal={false} className="pd-menu--instant">
          <div data-testid="pv-body">slider</div>
        </PopoverContent>
      </Popover>,
    );
    expect(html).toContain('data-state="open"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('pv-body'); // the body mounted
    expect(html).toContain('pd-menu'); // shared surface class
    expect(html).toContain('pd-menu--instant'); // consumer className merged
  });

  it('hosts the real EffortSlider as its body (issue 2 wiring)', () => {
    const html = renderToStaticMarkup(
      <Popover open>
        <PopoverTrigger data-testid="composer-effort">Auto · Medium</PopoverTrigger>
        <PopoverContent portal={false} className="pd-menu--instant pd-effort-popover">
          <EffortSlider
            steps={4}
            value={1}
            fill={1 / 3}
            auto
            label="Auto · Medium"
            valueText="Auto, medium"
            onLevelChange={() => {}}
            onAuto={() => {}}
            data-testid="composer-effort-slider"
          />
        </PopoverContent>
      </Popover>,
    );
    // The slider (role="slider" + the blue fill pill) mounts inside the open popover.
    expect(html).toContain('role="slider"');
    expect(html).toContain('pd-effort');
    expect(html).toContain('Auto · Medium');
  });
});
