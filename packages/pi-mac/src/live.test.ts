/**
 * Live end-to-end test against the REAL compiled `pi-mac` binary. Gated behind
 * PI_MAC_E2E=1 (and a prior `pnpm --filter @pi-desktop/pi-mac build:swift`) so
 * the default test run needs neither the binary nor the Accessibility grant.
 *
 * It proves the Node↔helper NDJSON chain: checkTcc, then a snapshot of TextEdit
 * (launched via `open -a`), then — only when Accessibility is granted — a type +
 * a re-snapshot to confirm the keystrokes landed. Without the grant it still
 * asserts the snapshot round-trips (an empty element list is a valid result).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { checkTcc } from './check.js';
import { MacHelperClient } from './serve-client.js';

const execFileAsync = promisify(execFile);
const LIVE = process.env.PI_MAC_E2E === '1';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface SnapEl {
  index: number;
  role: string;
  name: string;
  editable?: boolean;
}
interface Snap {
  app: string;
  elements: SnapEl[];
  summary: { elementCount: number };
}

describe.skipIf(!LIVE)('pi-mac live (real binary)', () => {
  it('checkTcc returns a clean boolean status', async () => {
    const status = await checkTcc();
    expect(typeof status.accessibility).toBe('boolean');
    expect(typeof status.screenRecording).toBe('boolean');
    console.log('[live] TCC status:', JSON.stringify(status));
  });

  it('snapshots + drives TextEdit through the serve client', async () => {
    await execFileAsync('open', ['-a', 'TextEdit']).catch(() => undefined);
    await execFileAsync('osascript', [
      '-e',
      'tell application "TextEdit" to make new document',
    ]).catch(() => undefined);
    await sleep(1000);

    const client = new MacHelperClient({ requestTimeoutMs: 15_000 });
    try {
      const status = await checkTcc();
      const snap = await client.request<Snap>('snapshot', { app: 'TextEdit', cap: 5 });
      expect(snap.app).toContain('TextEdit');
      expect(Array.isArray(snap.elements)).toBe(true);
      console.log('[live] TextEdit elements:', snap.summary.elementCount);

      if (!status.accessibility) {
        console.log('[live] Accessibility not granted → skipping type; snapshot round-trip OK');
        return;
      }
      const field = snap.elements.find((e) => e.editable) ?? snap.elements[0];
      expect(field).toBeDefined();
      const typed = await client.request<{ found: boolean }>('type', {
        index: field?.index ?? 1,
        text: 'hello from Pi via MacHelperClient',
      });
      expect(typed.found).toBe(true);
      await sleep(300);
      const { stdout } = await execFileAsync('osascript', [
        '-e',
        'tell application "TextEdit" to get text of front document',
      ]);
      console.log('[live] document text:', stdout.trim());
      expect(stdout).toContain('Pi');
    } finally {
      client.dispose();
    }
  }, 30_000);
});
