/**
 * One generation-category tab body in the model browser (Image / Video / Audio /
 * Music / 3D / Perception). Renders a RECOMMENDED-first grid of the vetted
 * modality models for the category, plus a per-category "Browse Hugging Face"
 * escape hatch that reveals the existing HF search — so a user can always reach
 * past the curated set. Reads the modality catalog DTOs from {@link useGenStore}
 * (loaded once when the manager mounts).
 */
import { Spinner } from '@pi-desktop/ui';
import { useState } from 'react';
import { useGenStore } from '../state/gen-store';
import { HfBrowseView } from './HfBrowseView';
import { IconGlobe } from './icons';
import { ModalityModelCard } from './ModalityModelCard';
import {
  entriesForCategory,
  MODALITY_CATEGORIES,
  type ModalityCategory,
} from './modality-catalog-logic';

export function ModalityCategoryView({
  category,
  advanced = false,
}: {
  category: ModalityCategory;
  advanced?: boolean;
}) {
  const catalog = useGenStore((s) => s.catalog);
  const loaded = useGenStore((s) => s.loaded);
  const [showHf, setShowHf] = useState(false);

  const def = MODALITY_CATEGORIES.find((c) => c.id === category);
  const entries = entriesForCategory(catalog, category);
  const recommendedCount = entries.filter((e) => e.recommended).length;

  return (
    <div className="flex flex-col gap-4" data-testid={`modality-view-${category}`}>
      {def !== undefined ? <p className="text-footnote text-text-muted">{def.blurb}</p> : null}

      {!loaded ? (
        <div className="flex items-center gap-2 py-8 text-footnote text-text-muted">
          <Spinner size={14} /> Loading catalog…
        </div>
      ) : entries.length === 0 ? (
        <div
          className="rounded-lg border border-dashed border-border-default px-3 py-6 text-footnote text-text-muted"
          data-testid={`modality-empty-${category}`}
        >
          No built-in {def?.label ?? category} models yet — browse Hugging Face below.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {recommendedCount > 0 ? (
            <h3 className="text-footnote font-medium uppercase tracking-wide text-text-muted">
              Recommended
            </h3>
          ) : null}
          <div className="grid grid-cols-1 gap-3" data-testid={`modality-grid-${category}`}>
            {entries.map((entry) => (
              <ModalityModelCard key={entry.id} entry={entry} advanced={advanced} />
            ))}
          </div>
        </div>
      )}

      {/* Escape hatch — reuse the existing HF search for anything past the
          curated set. Mounted only on demand so it never fires a search until
          the user opens it. */}
      <div className="flex flex-col gap-3 border-t border-border-default pt-4">
        <button
          type="button"
          data-testid={`mm-modality-browse-hf-${category}`}
          aria-expanded={showHf}
          onClick={() => setShowHf((v) => !v)}
          className="pd-focusable flex w-fit items-center gap-2 rounded-lg border border-border-default px-3 py-1.5 text-footnote text-text-secondary hover:bg-bg-hover"
        >
          <IconGlobe size={14} />
          {showHf ? 'Hide Hugging Face search' : 'Browse Hugging Face'}
        </button>
        {showHf ? <HfBrowseView /> : null}
      </div>
    </div>
  );
}
