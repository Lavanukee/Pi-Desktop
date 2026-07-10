/**
 * The full model-management surface, reworked (round 8) into two views plus
 * power features:
 *  - "Recommended": the curated catalog + the Apple on-device entry + the
 *    hardware recommendation banner, with a Favorites filter.
 *  - "Browse Hugging Face": live HF search → quant picker → download into the
 *    local catalog (see HfBrowseView).
 * An "Advanced" switch reveals the per-card power knobs (default effort + the raw
 * provider/spec details); it is off by default (progressive disclosure).
 * Favorites and per-model effort defaults persist in settings.json.
 */
import { Button, Spinner, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@pi-desktop/ui';
import { useEffect, useState } from 'react';
import type { LlmCatalogEntry } from '../../electron/ipc-contract';
import { afmAvailable, useAfmStore } from '../state/afm-store';
import { useLlmStore } from '../state/llm-store';
import { activateLocalModel } from '../state/local-model';
import { applyModelEffortDefault, useSettingsStore } from '../state/settings-store';
import { AFM_MODEL_ID, AfmModelCard } from './AfmModelCard';
import { HfBrowseView } from './HfBrowseView';
import { IconCpu, IconStar } from './icons';
import { ModelCard } from './ModelCard';
import { ModelTag } from './model-tags';

/** True when this entry is starred (by its id or, for an HF add, its repo id). */
function isFavorite(entry: LlmCatalogEntry, favorites: string[]): boolean {
  return (
    favorites.includes(entry.id) || (entry.hfRepo !== undefined && favorites.includes(entry.hfRepo))
  );
}

export function ModelManagerPanel() {
  const catalog = useLlmStore((s) => s.catalog);
  const hardware = useLlmStore((s) => s.hardware);
  const recommendation = useLlmStore((s) => s.recommendation);
  const status = useLlmStore((s) => s.status);
  const refreshCatalog = useLlmStore((s) => s.refreshCatalog);
  const refreshStatus = useLlmStore((s) => s.refreshStatus);
  const afmAvailability = useAfmStore((s) => s.availability);
  const refreshAfm = useAfmStore((s) => s.refresh);
  const favorites = useSettingsStore((s) => s.settings.favoriteModels);

  const [recBusy, setRecBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  useEffect(() => {
    void refreshCatalog();
    void refreshStatus();
    void refreshAfm();
  }, [refreshCatalog, refreshStatus, refreshAfm]);

  const recommended = catalog.find((m) => m.id === recommendation?.modelId) ?? null;
  const recActive =
    recommended !== null && status.serverRunning && status.model?.id === recommended.id;
  // Recommended first, then the rest in catalog order.
  const ordered = [...catalog].sort(
    (a, b) => Number(b.id === recommendation?.modelId) - Number(a.id === recommendation?.modelId),
  );

  const afmVisible = afmAvailable(afmAvailability) && afmAvailability !== null;
  const afmFavorite = favorites.includes(AFM_MODEL_ID);
  const hasFavorites = favorites.length > 0;

  const shownCards = favoritesOnly ? ordered.filter((e) => isFavorite(e, favorites)) : ordered;
  const showAfm = afmVisible && (!favoritesOnly || afmFavorite);

  const onOneClick = async () => {
    if (recommendation === null) return;
    setRecBusy(true);
    try {
      await applyModelEffortDefault(recommendation.modelId);
      await activateLocalModel(recommendation.modelId, recommendation.quant);
    } finally {
      setRecBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5" data-testid="model-manager">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-heading text-text-primary">Models</h2>
          <p className="mt-1 flex items-center gap-2 text-footnote text-text-muted">
            <IconCpu size={14} />
            {hardware === null ? (
              <span>Detecting hardware…</span>
            ) : (
              <span data-testid="hardware-summary">
                {hardware.chip ?? 'This machine'}
                {hardware.totalRamGB > 0 ? ` · ${hardware.totalRamGB} GB RAM` : ''}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-footnote text-text-secondary">
          <span id="mm-advanced-label">Advanced</span>
          <Switch
            size="sm"
            checked={advanced}
            onCheckedChange={setAdvanced}
            aria-labelledby="mm-advanced-label"
            data-testid="mm-advanced-toggle"
          />
        </div>
      </div>

      <Tabs defaultValue="recommended">
        <TabsList className="w-full max-w-[380px]" data-testid="mm-tabs">
          <TabsTrigger value="recommended" data-testid="mm-tab-recommended">
            Recommended
          </TabsTrigger>
          <TabsTrigger value="browse" data-testid="mm-tab-browse">
            Browse Hugging Face
          </TabsTrigger>
        </TabsList>

        <TabsContent value="recommended" className="mt-4 flex flex-col gap-5">
          {/* Recommendation flow. */}
          {recommendation !== null && recommended !== null ? (
            <div
              className="flex flex-col gap-3 rounded-xl border border-border-default bg-accent-subtle p-4"
              data-testid="recommendation-banner"
            >
              <div className="flex flex-wrap items-center gap-2">
                <ModelTag kind="recommended" data-testid="recommendation-banner-pill">
                  Recommended
                </ModelTag>
                <span className="text-body font-medium text-text-primary">
                  {recommended.displayName}
                </span>
                <ModelTag kind="quant" icon={null}>
                  {recommendation.quant}
                </ModelTag>
              </div>
              <p className="text-footnote text-text-secondary">{recommendation.rationale}</p>
              <div>
                <Button
                  variant="accent"
                  size="sm"
                  loading={recBusy}
                  disabled={recActive}
                  data-testid="recommendation-oneclick"
                  onClick={onOneClick}
                >
                  {recActive
                    ? 'Running'
                    : recommended.downloaded
                      ? 'Start recommended model'
                      : 'Download & start recommended model'}
                </Button>
              </div>
            </div>
          ) : null}

          {/* Favorites filter (only when the user has starred something). */}
          {hasFavorites ? (
            <button
              type="button"
              data-testid="mm-favorites-toggle"
              aria-pressed={favoritesOnly}
              onClick={() => setFavoritesOnly((v) => !v)}
              className={
                favoritesOnly
                  ? 'pd-focusable flex w-fit items-center gap-2 rounded-lg border border-border-strong bg-bg-active px-3 py-1.5 text-footnote text-text-primary'
                  : 'pd-focusable flex w-fit items-center gap-2 rounded-lg border border-border-default px-3 py-1.5 text-footnote text-text-secondary hover:bg-bg-hover'
              }
            >
              <IconStar size={14} filled={favoritesOnly} />
              {favoritesOnly ? 'Showing favorites' : 'Favorites only'}
            </button>
          ) : null}

          <div className="grid grid-cols-1 gap-3">
            {/* Apple on-device model first when this machine supports it. */}
            {showAfm ? <AfmModelCard advanced={advanced} availability={afmAvailability} /> : null}
            {catalog.length === 0 ? (
              <div className="flex items-center gap-2 py-8 text-footnote text-text-muted">
                <Spinner size={14} /> Loading catalog…
              </div>
            ) : shownCards.length === 0 ? (
              <div className="py-8 text-footnote text-text-muted">
                No favorites yet — star a model to pin it here.
              </div>
            ) : (
              shownCards.map((entry) => (
                <ModelCard key={entry.id} entry={entry} advanced={advanced} />
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="browse" className="mt-4">
          <HfBrowseView />
        </TabsContent>
      </Tabs>
    </div>
  );
}
