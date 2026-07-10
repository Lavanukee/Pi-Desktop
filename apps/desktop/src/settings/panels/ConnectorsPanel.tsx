/**
 * MCP mode: lite (one generic proxy tool + tool-search, schemas kept out of
 * context) vs native (every server tool registered directly). Writes the `mode`
 * field of the mcp-lite registry (~/.pi/desktop/mcp-connectors.json), preserving
 * any configured servers.
 */
import { SegmentedControl } from '@pi-desktop/ui';
import type { McpMode } from '../../../electron/settings/settings-contract';
import { useSettingsStore } from '../../state/settings-store';
import { SettingRow, SettingSection } from '../parts';

const MODE_HINT: Record<McpMode, string> = {
  lite: 'Servers are proxied through one lightweight tool; schemas load on demand.',
  native: 'Every MCP tool is registered directly (heavier context, full fidelity).',
};

export function ConnectorsPanel() {
  const mode = useSettingsStore((s) => s.settings.mcpMode);
  const update = useSettingsStore((s) => s.update);

  return (
    <SettingSection
      title="Connectors"
      description="How MCP connector tools are exposed to the agent."
    >
      <SettingRow label="MCP mode" hint={MODE_HINT[mode]}>
        <SegmentedControl
          aria-label="MCP mode"
          data-testid="settings-mcp-mode"
          value={mode}
          onValueChange={(v) => void update({ mcpMode: v as McpMode })}
          options={[
            { value: 'lite', label: 'Lite' },
            { value: 'native', label: 'Native' },
          ]}
        />
      </SettingRow>
    </SettingSection>
  );
}
