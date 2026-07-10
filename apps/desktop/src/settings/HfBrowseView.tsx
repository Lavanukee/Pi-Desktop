/**
 * The "Browse Hugging Face" view of the Model Manager: a search box + filter
 * controls (family/tag, task, gated, sort) that drive `hf:search`, a results
 * list of {@link HfResultCard}, and a place to paste an HF token for gated repos
 * (persisted to settings.json). Selecting a result opens its GGUF quant picker
 * (inside the card) and downloading adapts it into the local catalog.
 */
import {
  Button,
  IconSearch,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Spinner,
} from '@pi-desktop/ui';
import { useEffect, useState } from 'react';
import type { HfSortOption } from '../../electron/ipc-contract';
import { useHfStore } from '../state/hf-store';
import { useSettingsStore } from '../state/settings-store';
import { HfResultCard } from './HfResultCard';
import { IconGlobe, IconKey } from './icons';

type GatedFilter = 'any' | 'gated' | 'ungated';

const TASK_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'any', label: 'Any task' },
  { value: 'text-generation', label: 'Text generation' },
  { value: 'image-text-to-text', label: 'Vision (image-text)' },
];

const SORT_OPTIONS: Array<{ value: HfSortOption; label: string }> = [
  { value: 'downloads', label: 'Most downloads' },
  { value: 'likes', label: 'Most likes' },
  { value: 'recent', label: 'Recently updated' },
];

export function HfBrowseView() {
  const search = useHfStore((s) => s.search);
  const searchStatus = useHfStore((s) => s.searchStatus);
  const results = useHfStore((s) => s.results);
  const searchError = useHfStore((s) => s.searchError);
  const rateLimited = useHfStore((s) => s.rateLimited);

  const savedToken = useSettingsStore((s) => s.settings.hfToken);
  const updateSettings = useSettingsStore((s) => s.update);

  const [query, setQuery] = useState('');
  const [family, setFamily] = useState('');
  const [task, setTask] = useState('any');
  const [gated, setGated] = useState<GatedFilter>('any');
  const [sort, setSort] = useState<HfSortOption>('downloads');
  const [token, setToken] = useState(savedToken);

  useEffect(() => setToken(savedToken), [savedToken]);

  const runSearch = () => {
    void search({
      query: query.trim(),
      family: family.trim() === '' ? undefined : family.trim(),
      task: task === 'any' ? undefined : task,
      gated: gated === 'any' ? undefined : gated === 'gated',
      sort,
      limit: 24,
    });
  };

  const saveToken = () => {
    if (token !== savedToken) void updateSettings({ hfToken: token });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="hf-browse">
      <div className="flex items-center gap-2 text-footnote text-text-muted">
        <IconGlobe size={14} />
        <span>
          Search Hugging Face for GGUF models. Pick a quant to download it into your local models.
        </span>
      </div>

      {/* Search row. */}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          runSearch();
        }}
      >
        <div className="pd-search-field flex-1">
          <IconSearch className="pd-search-field-icon" size={16} />
          <Input
            type="search"
            className="pd-search-field-input"
            placeholder="Search models, e.g. qwen3 gguf"
            data-testid="hf-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button
          type="submit"
          variant="accent"
          loading={searchStatus === 'searching'}
          data-testid="hf-search-submit"
        >
          Search
        </Button>
      </form>

      {/* Filter controls. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="hf-filters">
        <Input
          className="h-8 w-40"
          placeholder="Family / tag"
          aria-label="Family or tag"
          data-testid="hf-filter-family"
          value={family}
          onChange={(e) => setFamily(e.target.value)}
        />
        <Select value={task} onValueChange={setTask}>
          <SelectTrigger
            className="h-8 min-w-[150px]"
            aria-label="Task"
            data-testid="hf-filter-task"
          />
          <SelectContent>
            {TASK_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={gated} onValueChange={(v) => setGated(v as GatedFilter)}>
          <SelectTrigger
            className="h-8 min-w-[120px]"
            aria-label="Gated"
            data-testid="hf-filter-gated"
          />
          <SelectContent>
            <SelectItem value="any">Any access</SelectItem>
            <SelectItem value="ungated">Ungated only</SelectItem>
            <SelectItem value="gated">Gated only</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as HfSortOption)}>
          <SelectTrigger
            className="h-8 min-w-[160px]"
            aria-label="Sort"
            data-testid="hf-filter-sort"
          />
          <SelectContent>
            {SORT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* HF token for gated / private repos + a higher rate limit. */}
      <div className="flex flex-col gap-2 rounded-xl border border-border-default bg-bg-raised p-3">
        <label
          className="flex items-center gap-2 text-caption text-text-secondary"
          htmlFor="hf-token"
        >
          <IconKey size={13} /> Hugging Face token (optional — for gated or private repos)
        </label>
        <Input
          id="hf-token"
          type="password"
          autoComplete="off"
          placeholder="hf_…"
          data-testid="hf-token-input"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onBlur={saveToken}
        />
      </div>

      {/* Results / status. */}
      {searchStatus === 'searching' ? (
        <div className="flex items-center gap-2 py-6 text-footnote text-text-muted">
          <Spinner size={14} /> Searching Hugging Face…
        </div>
      ) : searchStatus === 'error' ? (
        <div className="rounded-xl border border-border-default bg-bg-raised p-4 text-footnote text-status-danger-fg">
          {rateLimited
            ? 'Hugging Face rate limit reached — wait a moment and try again (adding a token raises the limit).'
            : (searchError ?? 'Search failed.')}
        </div>
      ) : searchStatus === 'done' && results.length === 0 ? (
        <div className="py-6 text-footnote text-text-muted" data-testid="hf-no-results">
          No GGUF models matched. Try a broader query or clear a filter.
        </div>
      ) : results.length > 0 ? (
        <div className="grid grid-cols-1 gap-3" data-testid="hf-results">
          {results.map((hit) => (
            <HfResultCard key={hit.id} hit={hit} />
          ))}
        </div>
      ) : (
        <div className="py-6 text-footnote text-text-muted">
          Search to discover thousands of community GGUF models beyond the recommended set.
        </div>
      )}
    </div>
  );
}
