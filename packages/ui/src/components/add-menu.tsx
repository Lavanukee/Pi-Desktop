import type { ReactElement, ReactNode } from 'react';
import { IconButton } from './button.tsx';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu.tsx';
import {
  IconConnector,
  IconFilm,
  IconFolderPlus,
  IconGithub,
  IconGlobe,
  IconImage,
  IconPaperclip,
  IconPlus,
  IconPuzzle,
  IconSearch,
  IconSparkles,
} from './icons.tsx';

/*
 * Composer "+" add / connectors menu (jedd round-1 feedback #7 & #8, Claude
 * img3). `variant="attach"` shows just the file entries; `variant="full"` adds
 * the connectors/extensions/research/web-search block. Presentational — each
 * row calls its handler; the web-search row is a controlled toggle-check.
 *
 * Modality force-actions (spec §3.2): the `variant="full"` menu also carries a
 * generation block (Generate image / Generate video / Motion graphics / Find /
 * segment). These are "force actions" — selecting one pins the harness task
 * class for the next send (via the composer's `forcedClass` seam) instead of
 * merely toggling a tool, so "+ → Generate video" deterministically loads the
 * advanced-video preset regardless of what the prompt text reads like.
 */

/** The four modality force-actions, keyed for a stable dispatch + test list. */
export type GenActionKey = 'image' | 'video' | 'motion' | 'perception';

export interface GenActionDescriptor {
  readonly key: GenActionKey;
  readonly label: string;
  /** Stable `data-testid` on the rendered row. */
  readonly testid: string;
}

/**
 * The gen block's rows, in menu order. This is the single source of truth the
 * menu maps over (and the render test asserts against — the Radix menu content
 * lives in a portal, so the node/SSR test verifies the driving descriptor list
 * rather than the portalled DOM).
 */
export const COMPOSER_GEN_ACTIONS: readonly GenActionDescriptor[] = [
  { key: 'image', label: 'Generate image', testid: 'add-generate-image' },
  { key: 'video', label: 'Generate video', testid: 'add-generate-video' },
  { key: 'motion', label: 'Motion graphics', testid: 'add-generate-motion' },
  { key: 'perception', label: 'Find / segment in image or video', testid: 'add-perception' },
];

/** The subset of {@link ComposerAddMenuProps} the gen block dispatches to. */
export interface GenActionHandlers {
  onGenerateImage?: () => void;
  onGenerateVideo?: () => void;
  onGenerateMotion?: () => void;
  onPerception?: () => void;
}

/**
 * Pure dispatch: invoke the handler a gen-action key maps to (a no-op when that
 * handler is absent). The menu's `onSelect` and its unit test both call this, so
 * the "selecting a row invokes the right callback" wiring is covered without a
 * DOM (the descriptor→handler mapping is the whole behavior).
 */
export function selectGenAction(key: GenActionKey, handlers: GenActionHandlers): void {
  switch (key) {
    case 'image':
      handlers.onGenerateImage?.();
      break;
    case 'video':
      handlers.onGenerateVideo?.();
      break;
    case 'motion':
      handlers.onGenerateMotion?.();
      break;
    case 'perception':
      handlers.onPerception?.();
      break;
  }
}

/** Row icon per gen-action (video/motion share the film glyph family). */
const GEN_ACTION_ICON: Record<GenActionKey, ReactElement> = {
  image: <IconImage size={16} />,
  video: <IconFilm size={16} />,
  motion: <IconSparkles size={16} />,
  perception: <IconSearch size={16} />,
};

export interface ComposerAddMenuProps {
  /** Trigger element; defaults to a "+" IconButton. */
  trigger?: ReactNode;
  variant?: 'attach' | 'full';
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  onAddFiles?: () => void;
  onTakeScreenshot?: () => void;
  onAddToProject?: () => void;
  onAddFromGitHub?: () => void;
  onSkills?: () => void;
  onAddConnector?: () => void;
  onAddPlugins?: () => void;
  onResearch?: () => void;
  webSearch?: boolean;
  onWebSearchChange?: (value: boolean) => void;
  /** Modality force-actions (spec §3.2) — `variant="full"` only. */
  onGenerateImage?: () => void;
  onGenerateVideo?: () => void;
  onGenerateMotion?: () => void;
  onPerception?: () => void;
  /** Force-open for galleries/screenshots. */
  open?: boolean;
  defaultOpen?: boolean;
}

export function ComposerAddMenu({
  trigger,
  variant = 'full',
  side = 'top',
  align = 'start',
  onAddFiles,
  onTakeScreenshot,
  onAddToProject,
  onAddFromGitHub,
  onSkills,
  onAddConnector,
  onAddPlugins,
  onResearch,
  webSearch = false,
  onWebSearchChange,
  onGenerateImage,
  onGenerateVideo,
  onGenerateMotion,
  onPerception,
  open,
  defaultOpen,
}: ComposerAddMenuProps) {
  const genHandlers: GenActionHandlers = {
    onGenerateImage,
    onGenerateVideo,
    onGenerateMotion,
    onPerception,
  };
  return (
    <DropdownMenu open={open} defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <IconButton aria-label="Add to message">
            <IconPlus />
          </IconButton>
        )}
      </DropdownMenuTrigger>
      {/* Round-10 (#11): the composer "+" menu opens/closes instantly. */}
      <DropdownMenuContent className="pd-menu--instant" side={side} align={align}>
        <DropdownMenuItem
          icon={<IconPaperclip size={16} />}
          hint="⌘U"
          onSelect={() => onAddFiles?.()}
        >
          Add files or photos
        </DropdownMenuItem>
        <DropdownMenuItem icon={<IconImage size={16} />} onSelect={() => onTakeScreenshot?.()}>
          Take a screenshot
        </DropdownMenuItem>
        {variant === 'full' ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={<IconFolderPlus size={16} />}
              onSelect={() => onAddToProject?.()}
            >
              Add to project
            </DropdownMenuItem>
            <DropdownMenuItem icon={<IconGithub size={16} />} onSelect={() => onAddFromGitHub?.()}>
              Add from GitHub
            </DropdownMenuItem>
            <DropdownMenuItem icon={<IconSparkles size={16} />} onSelect={() => onSkills?.()}>
              Skills
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<IconConnector size={16} />}
              onSelect={() => onAddConnector?.()}
            >
              Add connector
            </DropdownMenuItem>
            <DropdownMenuItem icon={<IconPuzzle size={16} />} onSelect={() => onAddPlugins?.()}>
              Add plugins…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {COMPOSER_GEN_ACTIONS.map((action) => (
              <DropdownMenuItem
                key={action.key}
                data-testid={action.testid}
                icon={GEN_ACTION_ICON[action.key]}
                onSelect={() => selectGenAction(action.key, genHandlers)}
              >
                {action.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<IconSearch size={16} />} onSelect={() => onResearch?.()}>
              Research
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem
              checked={webSearch}
              onCheckedChange={(next) => onWebSearchChange?.(next === true)}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="pd-menu-icon">
                <IconGlobe size={16} />
              </span>
              Web search
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
