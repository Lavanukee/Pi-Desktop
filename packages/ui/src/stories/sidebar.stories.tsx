import type { Story } from '@ladle/react';
import { useState } from 'react';
import {
  Button,
  IconButton,
  IconChat,
  IconChevronRight,
  IconClock,
  IconClose,
  IconConnector,
  IconFile,
  IconInfo,
  IconPencil,
  IconPlus,
  IconPuzzle,
  IconSearch,
  IconSparkles,
  Input,
  Kbd,
  Sidebar,
  SidebarFooter,
  SidebarRow,
  SidebarScroll,
  SidebarSection,
} from '../index.ts';

export const SessionList: Story = () => (
  <div style={{ height: 480, display: 'flex' }}>
    <Sidebar>
      <SidebarScroll>
        <SidebarRow icon={<IconPencil size={16} />} label="New chat" meta={<Kbd keys="⌘N" />} />
        <SidebarRow icon={<IconSearch size={16} />} label="Search" meta={<Kbd keys="⌘G" />} />
        <SidebarRow icon={<IconFile size={16} />} label="Projects" />
        <SidebarSection
          label="Recents"
          actions={
            <IconButton aria-label="New session" size="sm" variant="ghostMuted">
              <IconPlus size={12} />
            </IconButton>
          }
        >
          <SidebarRow
            icon={<IconChat size={16} />}
            label="Fixing the event router backlog"
            selected
            controls={
              <IconButton aria-label="Close session" size="sm" variant="ghostMuted">
                <IconClose size={12} />
              </IconButton>
            }
          />
          <SidebarRow
            icon={<IconChat size={16} />}
            label="Sidebar spec extraction notes"
            meta="2h"
            controls={
              <IconButton aria-label="Close session" size="sm" variant="ghostMuted">
                <IconClose size={12} />
              </IconButton>
            }
          />
          <SidebarRow icon={<IconChat size={16} />} label="MTP launch flags" meta="1d" />
          <SidebarRow
            icon={<IconChat size={16} />}
            label="A very long session title that should truncate with an ellipsis"
            meta="3d"
          />
        </SidebarSection>
      </SidebarScroll>
      <SidebarFooter avatar="J" name="Jedd" plan="Local" />
    </Sidebar>
  </div>
);

/** Search bar + full nav anatomy — the treatment is flavor-driven (claude floats,
 * codex frosts), so the contact-sheet columns show both side by side. */
function NavContents() {
  return (
    <>
      <div style={{ padding: 8 }}>
        <Input placeholder="Search" aria-label="Search" />
      </div>
      <SidebarScroll>
        <SidebarRow icon={<IconPencil size={16} />} label="New chat" meta={<Kbd keys="⌘N" />} />
        <SidebarRow icon={<IconChat size={16} />} label="Chats & tasks" selected />
        <SidebarRow icon={<IconFile size={16} />} label="Projects" />
        <SidebarRow icon={<IconSparkles size={16} />} label="Artifacts" />
        <SidebarRow icon={<IconConnector size={16} />} label="Connectors" />
        <SidebarRow icon={<IconPuzzle size={16} />} label="Skills" />
        <SidebarRow icon={<IconClock size={16} />} label="Scheduled tasks" />
        <SidebarRow icon={<IconInfo size={16} />} label="Customize" />
        <SidebarSection label="Recents">
          <SidebarRow icon={<IconChat size={16} />} label="Fixing the event router backlog" />
          <SidebarRow
            icon={<IconChat size={16} />}
            label="Sidebar spec extraction notes"
            meta="2h"
          />
          <SidebarRow icon={<IconChat size={16} />} label="MTP launch flags" meta="1d" />
        </SidebarSection>
      </SidebarScroll>
      <SidebarFooter avatar="J" name="Jedd" plan="Local" />
    </>
  );
}

/** Decorative content behind the sidebar so the codex frosted-glass blur reads. */
function Backdrop() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        background: 'var(--pd-bg-base)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 120,
          top: 60,
          width: 260,
          height: 260,
          borderRadius: '50%',
          background: 'var(--pd-accent-primary)',
          opacity: 0.5,
          filter: 'blur(4px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 40,
          top: 220,
          width: 200,
          height: 200,
          borderRadius: '50%',
          background: 'var(--pd-text-link)',
          opacity: 0.35,
        }}
      />
    </div>
  );
}

export const Treatments: Story = () => (
  <div style={{ position: 'relative', height: 560, display: 'flex' }}>
    <Backdrop />
    <div style={{ position: 'relative', display: 'flex', height: '100%' }}>
      <Sidebar>
        <NavContents />
      </Sidebar>
    </div>
  </div>
);

/** Slide in/out (both flavors) — toggle in browse mode; the shell clips it. */
export const SlideToggle: Story = () => {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ position: 'relative', height: 560 }}>
      <Backdrop />
      <div style={{ position: 'relative', display: 'flex', height: '100%', overflow: 'hidden' }}>
        <Sidebar open={open}>
          <NavContents />
        </Sidebar>
        <div style={{ padding: 16 }}>
          <Button variant="secondary" onClick={() => setOpen((v) => !v)}>
            {open ? 'Collapse' : 'Expand'} sidebar
            <IconChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
};
