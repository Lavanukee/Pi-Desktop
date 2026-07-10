/**
 * The full model-management surface: a hardware-detected recommendation banner
 * (with rationale + one-click download+start), a machine summary, and a card
 * per catalog model (recommended first). All lifecycle actions live on the
 * cards; this panel owns data loading + the recommendation flow.
 */
import { Badge, Button, Spinner } from '@pi-desktop/ui';
import { useEffect, useState } from 'react';
import { afmAvailable, useAfmStore } from '../state/afm-store';
import { useLlmStore } from '../state/llm-store';
import { activateLocalModel } from '../state/local-model';
import { AfmModelCard } from './AfmModelCard';
import { IconCpu } from './icons';
import { ModelCard } from './ModelCard';

export function ModelManagerPanel() {
  const catalog = useLlmStore((s) => s.catalog);
  const hardware = useLlmStore((s) => s.hardware);
  const recommendation = useLlmStore((s) => s.recommendation);
  const status = useLlmStore((s) => s.status);
  const refreshCatalog = useLlmStore((s) => s.refreshCatalog);
  const refreshStatus = useLlmStore((s) => s.refreshStatus);
  const afmAvailability = useAfmStore((s) => s.availability);
  const refreshAfm = useAfmStore((s) => s.refresh);
  const [recBusy, setRecBusy] = useState(false);

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

  const onOneClick = async () => {
    if (recommendation === null) return;
    setRecBusy(true);
    try {
      await activateLocalModel(recommendation.modelId, recommendation.quant);
    } finally {
      setRecBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5" data-testid="model-manager">
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

      {/* Recommendation flow. */}
      {recommendation !== null && recommended !== null ? (
        <div
          className="flex flex-col gap-3 rounded-xl border border-border-default bg-accent-subtle p-4"
          data-testid="recommendation-banner"
        >
          <div className="flex items-center gap-2">
            <Badge tone="accent" size="sm">
              Recommended
            </Badge>
            <span className="text-body font-medium text-text-primary">
              {recommended.displayName}
            </span>
            <span className="text-caption text-text-muted">{recommendation.quant}</span>
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

      <div className="grid grid-cols-1 gap-3">
        {/* Apple on-device model first when this machine supports it. */}
        {afmAvailable(afmAvailability) && afmAvailability !== null ? (
          <AfmModelCard availability={afmAvailability} />
        ) : null}
        {catalog.length === 0 ? (
          <div className="flex items-center gap-2 py-8 text-footnote text-text-muted">
            <Spinner size={14} /> Loading catalog…
          </div>
        ) : (
          ordered.map((entry) => <ModelCard key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  );
}
