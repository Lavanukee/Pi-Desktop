import type { ReactNode } from 'react';
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
 */

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
  open,
  defaultOpen,
}: ComposerAddMenuProps) {
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
