/**
 * Step 1 — where are you coming from? Auto-detects installed apps and
 * preselects one; the flavor auto-applies live as the choice changes.
 */
import { IconChat, IconSparkles, IconTerminal } from '@pi-desktop/ui';
import { SelectCard } from '../SelectCard';
import { useOnboardingStore } from '../useOnboarding';

export function SourceStep() {
  const source = useOnboardingStore((s) => s.source);
  const setSource = useOnboardingStore((s) => s.setSource);
  const claudeInstalled = useOnboardingStore((s) => s.claudeInstalled);
  const codexInstalled = useOnboardingStore((s) => s.codexInstalled);

  return (
    <div className="flex flex-col gap-3" role="radiogroup" aria-label="Source app">
      <SelectCard
        data-testid="source-claude"
        selected={source === 'claude'}
        onSelect={() => setSource('claude')}
        icon={<IconSparkles />}
        title="Coming from Claude"
        badge={claudeInstalled ? 'Detected' : undefined}
        description="Bring over your MCP servers and appearance, and use the Claude-style theme."
      />
      <SelectCard
        data-testid="source-codex"
        selected={source === 'codex'}
        onSelect={() => setSource('codex')}
        icon={<IconTerminal />}
        title="Coming from Codex"
        badge={codexInstalled ? 'Detected' : undefined}
        description="Import MCP servers, past sessions and skills, and use the Codex-style theme."
      />
      <SelectCard
        data-testid="source-neither"
        selected={source === 'neither'}
        onSelect={() => setSource('neither')}
        icon={<IconChat />}
        title="Neither — start fresh"
        description="Skip importing. You can bring things over later from Settings."
      />
    </div>
  );
}
