/**
 * MP5 bridge — deterministic verification of the app-side spawn_subagent bridge,
 * independent of whether a given model chooses the tool. We connect to the bridge
 * socket AS THE HARNESS WOULD (same JSON-RPC), send a spawn request, and assert:
 *   - the app spawns the subagent as its own pi (mock-pi here, deterministic),
 *   - it streams into the childAgentStore (the nested dropdown),
 *   - and the socket reply carries the child's answer back as the summary.
 * `npm run build` first.
 */

import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');

const assert = (c, m) => {
  if (!c) throw new Error(`subagent-bridge-probe failed: ${m}`);
};

// Pre-set the bridge socket + token so we can connect as the harness client would.
const sockPath = path.join(mkdtempSync(path.join(tmpdir(), 'pi-sub-')), 's.sock');
const TOKEN = 'probe-token';

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: {
    ...process.env,
    HOME: mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-')),
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: fixture,
    PI_E2E: '1',
    PI_DESKTOP_SUBAGENT_SOCK: sockPath,
    PI_DESKTOP_SUBAGENT_TOKEN: TOKEN,
  },
});

/** Send one spawn request to the bridge socket and resolve its reply. */
function spawnViaBridge(goal, name) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    let buf = '';
    const t = setTimeout(() => {
      socket.destroy();
      reject(new Error('bridge reply timed out'));
    }, 30000);
    socket.on('connect', () => {
      socket.setEncoding('utf8');
      socket.write(
        `${JSON.stringify({ id: 1, token: TOKEN, method: 'spawn', params: { goal, name, timeoutMs: 20000 } })}\n`,
      );
    });
    socket.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(t);
      socket.destroy();
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch (e) {
        reject(e);
      }
    });
    socket.on('error', reject);
  });
}

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.__child_store !== undefined, { timeout: 10000 });

  // Wait for the bridge socket to be listening (registerSubagentBridge on app setup).
  for (let i = 0; i < 40 && !existsSync(sockPath); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(existsSync(sockPath), 'bridge socket should be listening');

  // Drive a subagent through the bridge, exactly as the harness's runChild does.
  const reply = await spawnViaBridge('introduce yourself in one line', 'Researcher');
  assert(reply.ok === true, `bridge spawn should succeed: ${JSON.stringify(reply)}`);
  assert(
    typeof reply.summary === 'string' && reply.summary.length > 0,
    `summary should carry the child's answer: ${JSON.stringify(reply)}`,
  );

  // The subagent must have streamed into the store (the nested dropdown) as its own
  // instance, with a real folded transcript.
  const child = await page.evaluate(() => {
    const kids = Object.values(window.__child_store.getState().children);
    const c = kids[0];
    return c
      ? {
          title: c.title,
          text: c.messages
            .filter((m) => m.kind === 'assistant')
            .flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text))
            .join(''),
        }
      : null;
  });
  assert(child !== null, 'the subagent should appear in the childAgentStore (dropdown)');
  assert(child.title === 'Researcher', `child keeps its bridge title: ${child?.title}`);
  assert(child.text.length > 0, 'child transcript folded from its event stream');

  console.log(
    `subagent-bridge-probe OK — bridge spawned a subagent pi, streamed it to the dropdown ("${child.title}": "${child.text.slice(0, 40)}…"), and returned its answer as the summary ("${reply.summary.slice(0, 40)}…")`,
  );
} finally {
  await app.close();
}
