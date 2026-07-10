/**
 * Shared per-model power controls used by every card in the Model Manager
 * (curated, AFM, and Browse-HF): a favorites star and a per-model default-effort
 * picker. Both persist through the desktop-settings store (settings.json
 * `favoriteModels` / `modelEffortDefaults`).
 */
import { Select, SelectContent, SelectItem, SelectTrigger } from '@pi-desktop/ui';
import type { EffortLevel } from '../../electron/settings/settings-contract';
import {
  setModelEffortDefault,
  toggleFavoriteModel,
  useSettingsStore,
} from '../state/settings-store';
import { IconStar } from './icons';

/** The value the "no default" option uses inside the Select (empty is reserved). */
const NO_DEFAULT = '__none__';

const EFFORT_OPTIONS: Array<{ value: EffortLevel; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

/** A star toggle that stars/unstars a model id in settings.favoriteModels. */
export function FavoriteStar({ modelId }: { modelId: string }) {
  const favorited = useSettingsStore((s) => s.settings.favoriteModels.includes(modelId));
  return (
    <button
      type="button"
      data-testid={`favorite-${modelId}`}
      data-favorited={favorited ? 'true' : 'false'}
      aria-pressed={favorited}
      aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
      title={favorited ? 'Favorited' : 'Add to favorites'}
      onClick={() => void toggleFavoriteModel(modelId)}
      className={
        favorited
          ? 'pd-focusable rounded-md p-1 text-status-warning-fg transition-colors'
          : 'pd-focusable rounded-md p-1 text-text-muted transition-colors hover:text-text-secondary'
      }
    >
      <IconStar size={16} filled={favorited} />
    </button>
  );
}

/**
 * Per-model default-effort picker. Selecting a level records it so that setting
 * this model active pushes that effort into the harness (see
 * `applyModelEffortDefault`); "No default" clears it.
 */
export function EffortDefaultSelect({ modelId }: { modelId: string }) {
  const value = useSettingsStore((s) => s.settings.modelEffortDefaults[modelId]) ?? NO_DEFAULT;
  return (
    <Select
      value={value}
      onValueChange={(next) =>
        void setModelEffortDefault(modelId, next === NO_DEFAULT ? undefined : (next as EffortLevel))
      }
    >
      <SelectTrigger
        className="h-7 min-w-[130px]"
        aria-label="Default effort"
        data-testid={`effort-default-${modelId}`}
      />
      <SelectContent>
        <SelectItem value={NO_DEFAULT}>No default</SelectItem>
        {EFFORT_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
