import type { Story } from '@ladle/react';
import { useState } from 'react';
import { ComposerAddMenu, IconButton, IconConnector } from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

const noop = () => {};

/**
 * Connectors / extensions "+" menu (feedback #8, Claude img3). The full variant
 * lists files, screenshot, project, GitHub, skills, connectors, plugins,
 * research, and a web-search toggle-check. Forced open for the contact sheet.
 */
export const ConnectorsMenu: Story = () => {
  const [web, setWeb] = useState(true);
  return (
    <Frame>
      <Row label="composer + add-menu (full variant, forced open)">
        <div style={{ height: 380, display: 'flex', alignItems: 'flex-end' }}>
          <ComposerAddMenu
            variant="full"
            open
            onAddFiles={noop}
            onTakeScreenshot={noop}
            onAddToProject={noop}
            onAddFromGitHub={noop}
            onSkills={noop}
            onAddConnector={noop}
            onAddPlugins={noop}
            onResearch={noop}
            webSearch={web}
            onWebSearchChange={setWeb}
          />
        </div>
      </Row>
      <Row label="standalone connectors / extensions icon">
        <IconButton aria-label="Connectors">
          <IconConnector />
        </IconButton>
      </Row>
    </Frame>
  );
};
