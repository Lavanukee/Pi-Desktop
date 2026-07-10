/**
 * The Settings + Model Manager surface: a full-window panel (replaces the chat
 * surface; the chat store persists underneath) with a left nav and a scrollable
 * content area. Reachable from the sidebar gear (opens a settings section) and
 * from the composer model chip (opens the Models section). Opening the surface
 * slides + fades it in (`.pd-settings-enter`), consistent with the app's panel
 * motion; reduced-motion drops the animation.
 */
import {
  IconChevronLeft,
  IconConnector,
  IconPuzzle,
  IconSearch,
  IconSparkles,
  ScrollArea,
} from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import { cx } from '../onboarding/cx';
import { IconCpu, IconShield, IconSlider, IconSun } from './icons';
import { ModelManagerPanel } from './ModelManagerPanel';
import { AgentPanel } from './panels/AgentPanel';
import { AppearancePanel } from './panels/AppearancePanel';
import { CapabilitiesPanel } from './panels/CapabilitiesPanel';
import { ConnectorsPanel } from './panels/ConnectorsPanel';
import { InterfacePanel } from './panels/InterfacePanel';
import { PersonalizationPanel } from './panels/PersonalizationPanel';
import { SearchPanel } from './panels/SearchPanel';

export type SettingsSection =
  | 'models'
  | 'personalization'
  | 'appearance'
  | 'interface'
  | 'agent'
  | 'search'
  | 'connectors'
  | 'capabilities';

const NAV: Array<{ id: SettingsSection; label: string; icon: ReactNode }> = [
  { id: 'personalization', label: 'Custom instructions', icon: <IconSparkles /> },
  { id: 'models', label: 'Models', icon: <IconCpu /> },
  { id: 'appearance', label: 'Appearance', icon: <IconSun /> },
  { id: 'interface', label: 'Interface', icon: <IconSlider /> },
  { id: 'agent', label: 'Agent', icon: <IconShield /> },
  { id: 'search', label: 'Web search', icon: <IconSearch /> },
  { id: 'connectors', label: 'Connectors', icon: <IconConnector /> },
  { id: 'capabilities', label: 'Capabilities', icon: <IconPuzzle /> },
];

function SectionBody({
  section,
  onOpenGallery,
  onOpenConnectors,
  onRedoOnboarding,
}: {
  section: SettingsSection;
  onOpenGallery?: () => void;
  onOpenConnectors?: () => void;
  onRedoOnboarding?: () => void;
}) {
  switch (section) {
    case 'models':
      return <ModelManagerPanel />;
    case 'personalization':
      return <PersonalizationPanel />;
    case 'appearance':
      return <AppearancePanel />;
    case 'interface':
      return <InterfacePanel onOpenGallery={onOpenGallery} onRedoOnboarding={onRedoOnboarding} />;
    case 'agent':
      return <AgentPanel />;
    case 'search':
      return <SearchPanel />;
    case 'connectors':
      return <ConnectorsPanel onOpenConnectors={onOpenConnectors} />;
    case 'capabilities':
      return <CapabilitiesPanel />;
  }
}

export function SettingsView({
  section,
  onSection,
  onClose,
  onOpenGallery,
  onOpenConnectors,
  onRedoOnboarding,
}: {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
  /** Open the dev component gallery (round-5 #23: entry lives in Interface). */
  onOpenGallery?: () => void;
  /** Open the full Codex-style connectors gallery (its own top-level view). */
  onOpenConnectors?: () => void;
  /** Clear the first-run flag + re-open the onboarding wizard (Interface panel). */
  onRedoOnboarding?: () => void;
}) {
  return (
    <div className="pd-settings-enter flex h-full flex-col bg-bg-base" data-testid="settings-view">
      {/* Empty draggable strip clearing the macOS traffic lights (the "Back to
          chat" control moved to the bottom-left of the nav, round-6 img54). */}
      <div className="h-10 shrink-0 [-webkit-app-region:drag]" />

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-52 shrink-0 flex-col border-r border-border-default px-2 pt-3 pb-2">
          {/* Account/profile identity — mirrors the sidebar footer that opens
              this surface. */}
          <div
            className="mb-2 flex items-center gap-2.5 rounded-lg px-3 py-2"
            data-testid="settings-account"
          >
            <span className="pd-sidebar-avatar">P</span>
            <span className="min-w-0">
              <span className="block truncate text-body text-text-primary">Pi Desktop</span>
              <span className="block text-footnote text-text-muted">Local · signed out</span>
            </span>
          </div>

          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              data-testid={`settings-nav-${item.id}`}
              aria-current={item.id === section ? 'page' : undefined}
              onClick={() => onSection(item.id)}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-body',
                item.id === section
                  ? 'bg-bg-active text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover',
              )}
            >
              <span className="shrink-0 text-text-muted">{item.icon}</span>
              {item.label}
            </button>
          ))}

          {/* Back to chat: a proper button pinned to the BOTTOM-left of the nav
              (round-6 img54) — a bordered secondary action, not raw blue link. */}
          <button
            type="button"
            data-testid="settings-back"
            onClick={onClose}
            className="mt-auto flex w-full items-center gap-2 rounded-lg border border-border-default px-3 py-2 text-left text-body text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary pd-focusable"
          >
            <IconChevronLeft size={16} className="shrink-0 text-text-muted" />
            Back to chat
          </button>
        </nav>

        <ScrollArea className="min-w-0 flex-1">
          <div className="mx-auto max-w-[760px] px-8 py-8">
            <SectionBody
              section={section}
              onOpenGallery={onOpenGallery}
              onOpenConnectors={onOpenConnectors}
              onRedoOnboarding={onRedoOnboarding}
            />
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
