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
import type { LlmCatalogEntry, LlmSimplePick } from '../../electron/ipc-contract';
import { afmAvailable, useAfmStore } from '../state/afm-store';
import { useLlmStore } from '../state/llm-store';
import { activateLocalModel } from '../state/local-model';
import {
  applyModelEffortDefault,
  setEnginePreference,
  useEnginePreference,
  useSettingsStore,
} from '../state/settings-store';
import { AFM_MODEL_ID, AfmModelCard } from './AfmModelCard';
import { HfBrowseView } from './HfBrowseView';
import { IconCpu, IconStar } from './icons';
import { ModelCard } from './ModelCard';
import { categorizeByFamily, groupCatalog, type ModelGroup } from './model-manager-logic';
import { ModelTag, SpecPill } from './model-tags';

/** True when this entry is starred (by its id or, for an HF add, its repo id). */
function isFavorite(entry: LlmCatalogEntry, favorites: string[]): boolean {
  return (
    favorites.includes(entry.id) || (entry.hfRepo !== undefined && favorites.includes(entry.hfRepo))
  );
}

/** A grouped model is favorited when its (star-key) primary — or any collapsed
 * entry — is starred. */
function isGroupFavorite(group: ModelGroup, favorites: string[]): boolean {
  return (
    favorites.includes(group.primary.id) || group.entries.some((e) => isFavorite(e, favorites))
  );
}

/** Plain-language role label for a non-power-user simple pick. */
const ROLE_LABEL: Record<LlmSimplePick['role'], string> = {
  speed: 'Fastest',
  vision: 'Best for images',
  utility: 'Lightweight helper',
};

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
  const enginePref = useEnginePreference();

  const [recBusy, setRecBusy] = useState(false);
  const [pickBusy, setPickBusy] = useState<string | null>(null);
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

  // De-duplicate the catalog into ONE group per model, then categorize by family
  // (sorted by size) for the power-user Recommended view.
  const groups = groupCatalog(catalog);
  const shownGroups = favoritesOnly ? groups.filter((g) => isGroupFavorite(g, favorites)) : groups;
  const sections = categorizeByFamily(shownGroups);

  const afmVisible = afmAvailable(afmAvailability) && afmAvailability !== null;
  const afmFavorite = favorites.includes(AFM_MODEL_ID);
  const hasFavorites = favorites.length > 0;

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

  const onUsePick = async (pick: LlmSimplePick) => {
    setPickBusy(pick.modelId);
    try {
      await applyModelEffortDefault(pick.modelId);
      await activateLocalModel(pick.modelId, pick.quant);
    } finally {
      setPickBusy(null);
    }
  };

  const simpleSet = recommendation?.simpleSet ?? [];

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

          {/* Recommended for your Mac — a simple, non-power-user pick set
              (fastest / best-for-images / lightweight helper), each a one-click. */}
          {simpleSet.length > 0 ? (
            <div className="flex flex-col gap-2" data-testid="recommended-for-mac">
              <div>
                <h3 className="text-body font-medium text-text-primary">
                  Recommended for your Mac
                </h3>
                <p className="text-footnote text-text-muted">
                  Simple picks tuned for your hardware — speed-optimized by default.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-2">
                {simpleSet.map((pick) => {
                  const active = status.serverRunning && status.model?.id === pick.modelId;
                  return (
                    <div
                      key={`${pick.modelId}-${pick.role}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border-default bg-bg-raised px-3 py-2"
                      data-testid={`simple-pick-${pick.modelId}`}
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <ModelTag kind="neutral" icon={null} title="What this pick is best at">
                          {ROLE_LABEL[pick.role]}
                        </ModelTag>
                        <span className="truncate text-footnote font-medium text-text-primary">
                          {pick.displayName}
                        </span>
                        {pick.spec !== undefined ? <SpecPill method={pick.spec} /> : null}
                        {pick.vision ? <ModelTag kind="vision">Vision</ModelTag> : null}
                        <ModelTag kind="quant" icon={null}>
                          {pick.quant}
                        </ModelTag>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        loading={pickBusy === pick.modelId}
                        disabled={active}
                        data-testid={`simple-pick-use-${pick.modelId}`}
                        onClick={() => void onUsePick(pick)}
                      >
                        {active ? 'Running' : 'Use'}
                      </Button>
                    </div>
                  );
                })}
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

          {/* Advanced: the "Prefer MLX (experimental)" engine preference. The
              MLX backend itself is a later wave — this persists the preference +
              drives the per-card engine badge. */}
          {advanced ? (
            <div
              className="flex flex-col gap-2 rounded-xl border border-border-default bg-bg-raised p-4"
              data-testid="mm-advanced-panel"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <label
                    id="mm-mlx-label"
                    htmlFor="mm-mlx-toggle"
                    className="text-body font-medium text-text-primary"
                  >
                    Prefer MLX (experimental)
                  </label>
                  <p className="mt-0.5 text-footnote text-text-muted">
                    Use Apple&apos;s MLX engine on Apple Silicon where available. MLX uses different
                    (non-GGUF) model files; the backend lands in a later update — this saves your
                    preference and labels each model with its engine.
                  </p>
                </div>
                <Switch
                  id="mm-mlx-toggle"
                  size="sm"
                  checked={enginePref === 'mlx'}
                  onCheckedChange={(on) => void setEnginePreference(on ? 'mlx' : 'llamacpp')}
                  aria-labelledby="mm-mlx-label"
                  data-testid="mm-mlx-toggle"
                />
              </div>
            </div>
          ) : null}

          {/* Apple on-device model first when this machine supports it. */}
          {showAfm ? (
            <div className="grid grid-cols-1 gap-3">
              <AfmModelCard advanced={advanced} availability={afmAvailability} />
            </div>
          ) : null}

          {/* De-duplicated models, categorized by family and sorted by size. */}
          {catalog.length === 0 ? (
            <div className="flex items-center gap-2 py-8 text-footnote text-text-muted">
              <Spinner size={14} /> Loading catalog…
            </div>
          ) : sections.length === 0 ? (
            <div className="py-8 text-footnote text-text-muted">
              No favorites yet — star a model to pin it here.
            </div>
          ) : (
            <div className="flex flex-col gap-5" data-testid="mm-family-sections">
              {sections.map((section) => (
                <div key={section.family} className="flex flex-col gap-3">
                  <h3
                    className="text-footnote font-medium uppercase tracking-wide text-text-muted"
                    data-testid={`mm-family-${section.family}`}
                  >
                    {section.family}
                  </h3>
                  <div className="grid grid-cols-1 gap-3">
                    {section.groups.map((group) => (
                      <ModelCard key={group.key} group={group} advanced={advanced} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="browse" className="mt-4">
          <HfBrowseView />
        </TabsContent>
      </Tabs>
    </div>
  );
}
