import type { Story } from '@ladle/react';
import {
  IconButton,
  IconChat,
  IconSearch,
  IconSidebar,
  MainSurface,
  TopBar,
  TopBarTitle,
} from '../index.ts';

/** Shell composition: sidebar layer + top bar + main surface (codex renders
 * the floating-card treatment; claude stays flat). */
export const Shell: Story = () => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      height: 380,
      background: 'var(--pd-bg-sidebar)',
    }}
  >
    <TopBar
      trafficLightInset
      left={
        <>
          <IconButton aria-label="Toggle sidebar">
            <IconSidebar />
          </IconButton>
          <IconButton aria-label="Search">
            <IconSearch />
          </IconButton>
        </>
      }
      center={<TopBarTitle>Fixing the event router backlog</TopBarTitle>}
      right={
        <IconButton aria-label="New chat">
          <IconChat />
        </IconButton>
      }
    />
    <div style={{ display: 'flex', flex: 1, minHeight: 0, padding: '0 8px 8px' }}>
      <MainSurface style={{ display: 'grid', placeItems: 'center' }}>
        <span style={{ color: 'var(--pd-text-muted)' }}>main surface</span>
      </MainSurface>
    </div>
  </div>
);
