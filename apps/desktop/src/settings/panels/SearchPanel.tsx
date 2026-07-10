/**
 * Web-search backend keys (Brave + Tavily). These are secrets: persisted to
 * settings.json (mode 0600) and mirrored onto the main-process env, which a pi
 * child reads at spawn. web-tools reads env once at activation, so a running
 * session only picks up a changed key after a restart — hence the explicit
 * "Restart agent to apply" affordance (session-preserving).
 */
import { Button, Input } from '@pi-desktop/ui';
import { useEffect, useState } from 'react';
import { restartPi } from '../../state/pi-connect';
import { usePiStore } from '../../state/pi-slice';
import { useSettingsStore } from '../../state/settings-store';
import { IconKey } from '../icons';
import { SettingRow, SettingSection } from '../parts';

export function SearchPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const [brave, setBrave] = useState(settings.search.brave);
  const [tavily, setTavily] = useState(settings.search.tavily);
  const [restarting, setRestarting] = useState(false);

  // Reseed the inputs if the underlying settings load/change out from under us.
  useEffect(() => {
    setBrave(settings.search.brave);
    setTavily(settings.search.tavily);
  }, [settings.search.brave, settings.search.tavily]);

  const dirty = brave !== settings.search.brave || tavily !== settings.search.tavily;

  const saveBrave = () => {
    if (brave !== settings.search.brave) void update({ search: { brave } });
  };
  const saveTavily = () => {
    if (tavily !== settings.search.tavily) void update({ search: { tavily } });
  };

  const restart = async () => {
    setRestarting(true);
    try {
      const sessionFile = usePiStore.getState().session?.sessionFile;
      await restartPi(sessionFile !== undefined ? { sessionPath: sessionFile } : undefined);
    } finally {
      setRestarting(false);
    }
  };

  return (
    <SettingSection
      title="Web search"
      description="Optional keys upgrade web search beyond the built-in DuckDuckGo backend. DuckDuckGo needs no key."
    >
      <SettingRow
        label="Brave Search API key"
        hint="Used when set — otherwise search falls back to DuckDuckGo."
      >
        <Input
          type="password"
          autoComplete="off"
          placeholder="PI_BRAVE_API_KEY"
          data-testid="settings-brave-key"
          value={brave}
          onChange={(e) => setBrave(e.target.value)}
          onBlur={saveBrave}
        />
      </SettingRow>

      <SettingRow label="Tavily API key" hint="Optional alternative search backend.">
        <Input
          type="password"
          autoComplete="off"
          placeholder="PI_TAVILY_API_KEY"
          data-testid="settings-tavily-key"
          value={tavily}
          onChange={(e) => setTavily(e.target.value)}
          onBlur={saveTavily}
        />
      </SettingRow>

      <div className="flex items-center gap-2 text-footnote text-text-muted">
        <IconKey size={14} />
        <span>Keys are stored locally and applied to new sessions.</span>
        <Button
          size="sm"
          variant="ghost"
          loading={restarting}
          disabled={dirty}
          onClick={() => void restart()}
        >
          Restart agent to apply now
        </Button>
      </div>
    </SettingSection>
  );
}
