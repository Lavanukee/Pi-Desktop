/**
 * TierPickerMenu (round-14 keystone) — the ONE tier picker, extracted from the
 * footer model chip so it can be shared by both the footer chip (issue 4) and
 * the composer-bar "[Auto] · [<tier>]" control (issue 3). Renders a dropdown of
 * Auto + the three capability tiers (fast / balanced / intelligent) backed by
 * `selectAuto` / `selectTier`, plus a "More models" deep-link in power mode.
 *
 * Self-contained: it reads its own state (recommendation catalog, user mode,
 * current selection) so a consumer only supplies the trigger element (children)
 * and, optionally, an `onOpenManager` callback. Both consumers therefore stay in
 * lock-step — one fix here propagates to the bar AND the footer.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconCheck,
  IconChevronRight,
  IconGauge,
  IconSparkles,
  IconSpeed,
} from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import type { ModelTier } from '../../../../packages/harness/src/classify/tier.ts';
import { useLlmStore } from '../state/llm-store';
import { selectionTier } from '../state/model-selection';
import { useModelSelection, useUserMode } from '../state/settings-store';
import { selectAuto, selectTier } from './auto-router';
import { buildTierRows } from './footer-models';

/** Leading glyph per capability tier (fast=speed, balanced=gauge, smart=spark). */
const TIER_ICON: Record<ModelTier, ReactNode> = {
  fast: <IconSpeed size={14} />,
  balanced: <IconGauge size={14} />,
  intelligent: <IconSparkles size={14} />,
};

export interface TierPickerMenuProps {
  /** The trigger element (the footer chip, or a bar `.pd-tier-seg` button). */
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  /** Power-mode "More models" deep-link into the full manager (omit to hide). */
  onOpenManager?: (() => void) | undefined;
  /** Optional `data-testid` for the menu surface (e.g. the footer's). */
  menuTestId?: string;
}

/** The shared Auto + tiers picker. Opens instantly (no animation, round-10 #11). */
export function TierPickerMenu({
  children,
  side = 'top',
  align = 'start',
  onOpenManager,
  menuTestId,
}: TierPickerMenuProps) {
  const recommendation = useLlmStore((s) => s.recommendation);
  const refreshCatalog = useLlmStore((s) => s.refreshCatalog);
  const userMode = useUserMode();
  const selection = useModelSelection();
  const isAuto = selection.mode === 'auto';
  const activeTier = selectionTier(selection);
  const tierRows = buildTierRows(recommendation?.tierModels, userMode);
  const showManager = userMode === 'power' && onOpenManager !== undefined;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // Refresh the catalog so tierModels + downloaded flags are current.
        if (open) void refreshCatalog();
      }}
    >
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      {/* Mode-aware model picker: both modes list Auto (top, default) + the three
          capability tiers; USER mode leads each tier with its friendly label
          (real model name grey underneath), POWER mode leads with the real model
          name (tier label grey) and keeps a "More models" path to the full
          manager. Opens instantly (no animation, round-10 #11). */}
      <DropdownMenuContent
        className="pd-menu--instant"
        align={align}
        side={side}
        data-testid={menuTestId}
      >
        <DropdownMenuItem
          data-testid="footer-auto"
          description="Picks the best model for each task"
          hint={isAuto ? <IconCheck size={14} /> : undefined}
          onSelect={() => void selectAuto()}
        >
          <span className="flex items-center gap-1.5">
            <IconSparkles size={14} />
            Auto
          </span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {tierRows.map((row) => (
          <DropdownMenuItem
            key={row.tier}
            data-testid="footer-tier"
            description={
              row.secondary === null
                ? undefined
                : row.downloaded
                  ? row.secondary
                  : `${row.secondary} · download`
            }
            // Only a DOWNLOADED tier can read as the active model (jedd #4): a
            // tier whose model isn't on disk never shows a selected checkmark —
            // picking it opens the download flow (selectTier) instead of pretending
            // it's active.
            hint={activeTier === row.tier && row.downloaded ? <IconCheck size={14} /> : undefined}
            // No preventDefault: the menu MUST close on selection (jedd #3). The
            // download flow (non-downloaded pick) opens its own dialog from
            // selectTier, so keeping the menu open is unnecessary and felt broken.
            onSelect={() => void selectTier(row.tier)}
          >
            <span className="flex items-center gap-1.5">
              {TIER_ICON[row.tier]}
              {row.primary}
            </span>
          </DropdownMenuItem>
        ))}

        {showManager ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="footer-open-manager"
              hint={<IconChevronRight size={14} />}
              onSelect={() => onOpenManager?.()}
            >
              More models
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
