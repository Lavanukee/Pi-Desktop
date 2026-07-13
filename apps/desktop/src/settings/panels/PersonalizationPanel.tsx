/**
 * Custom instructions: a user-authored system-prompt suffix. Persisted to
 * settings.json (`customInstructions`) and folded into the FIRST prompt of each
 * new session by pi-connect's session-instructions seam (the frozen harness/pi
 * exposes no dedicated system-prompt channel). Saved on blur, like the search
 * keys, so a half-typed instruction never persists mid-keystroke.
 */
import { TextArea } from '@pi-desktop/ui';
import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../state/settings-store';
import { SettingRow, SettingSection } from '../parts';

export function PersonalizationPanel() {
  const saved = useSettingsStore((s) => s.settings.customInstructions);
  const update = useSettingsStore((s) => s.update);
  const [text, setText] = useState(saved);

  // Reseed if the underlying settings load/change out from under us.
  useEffect(() => setText(saved), [saved]);

  const dirty = text !== saved;
  const save = () => {
    if (dirty) void update({ customInstructions: text });
  };

  return (
    <SettingSection
      title="Custom instructions"
      description="Standing guidance the agent applies to every new chat — tone, formatting, defaults, things to remember."
    >
      <SettingRow
        label="System instructions"
        hint="Applied at the start of each new chat. Existing chats keep the instructions they began with."
      >
        <TextArea
          data-testid="settings-custom-instructions"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          rows={8}
          placeholder="e.g. Respond concisely. Prefer TypeScript. Explain your reasoning before showing code."
        />
        <div className="flex items-center justify-end text-footnote text-text-muted">
          {/* "Saved" only reflects an ACTUAL persisted instruction — an untouched,
              empty field shows nothing (a non-breaking space holds the row height)
              rather than a misleading "Saved". */}
          {dirty ? 'Unsaved — click away to save' : saved.length > 0 ? 'Saved' : ' '}
        </div>
      </SettingRow>
    </SettingSection>
  );
}
