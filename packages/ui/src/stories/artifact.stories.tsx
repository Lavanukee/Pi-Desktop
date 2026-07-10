import type { Story } from '@ladle/react';
import { ArtifactPanel, IconButton, IconClose, IconCopy, IconFile } from '../index.ts';
import { Story as Frame } from './helpers.tsx';

const CONTROLS = (
  <>
    <IconButton aria-label="Copy" size="sm" variant="ghostMuted">
      <IconCopy size={14} />
    </IconButton>
    <IconButton aria-label="Close panel" size="sm" variant="ghostMuted">
      <IconClose size={14} />
    </IconButton>
  </>
);

export const States: Story = () => (
  <Frame>
    <div style={{ display: 'grid', gap: 20 }}>
      <div style={{ height: 220 }}>
        <ArtifactPanel
          title="Retro dashboard"
          byline="Content is user-generated and may contain errors."
          logo={<IconFile size={14} />}
          controls={CONTROLS}
        >
          <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
            <span style={{ color: 'var(--pd-text-muted)' }}>hosted content</span>
          </div>
        </ArtifactPanel>
      </div>
      <div style={{ height: 200 }}>
        <ArtifactPanel state="loading" controls={CONTROLS} />
      </div>
      <div style={{ height: 200 }}>
        <ArtifactPanel state="error" errorMessage="This artifact failed to render." />
      </div>
    </div>
  </Frame>
);
