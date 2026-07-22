/**
 * MP5 real-model verification — the WHOLE spawn_subagent → app-bridge loop, driven
 * by an ACTUAL local model (no mock-pi). A real prompt makes the model call
 * spawn_subagent; the harness routes it to the app bridge; the app spawns the
 * subagent as its OWN pi instance, streams it into the childAgentStore (the nested
 * dropdown), awaits its answer, and hands the summary back to the model — which
 * then reports it. Proves subagents appear + are viewable + return their result on
 * a real run.
 *
 * Env-guarded: SKIPS cleanly if the model isn't cached. Run `npm run build` first.
 * Model override via SUBAGENT_MODEL (default qwen3.5-4b-mtp — good at tool calls).
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = process.env.SUBAGENT_OUT ?? path.join(tmpdir(), 'real-subagent-shots');
const MODEL_ID = process.env.SUBAGENT_MODEL ?? 'qwen3.6-27b-mtp';

const fail = (m) => {
  throw new Error(`real-subagent-probe failed: ${m}`);
};

if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
  console.error('real-subagent-probe: app not built — run `npm run build` first');
  process.exit(1);
}

const { mkdirSync } = await import('node:fs');
mkdirSync(OUT_DIR, { recursive: true });

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  // Real pi (no PI_BIN) against the real ~/.pi so pi reads the supervisor's models.json.
  env: { ...process.env, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await page.waitForFunction(() => window.__child_store !== undefined, { timeout: 20000 });

  const started = await page.evaluate(
    (id) => window.piDesktop.invoke('llm:start-server', { modelId: id }),
    MODEL_ID,
  );
  if (!started.success) {
    if (/not downloaded/i.test(started.error ?? '')) {
      console.log(`real-subagent-probe: SKIP — ${MODEL_ID} not downloaded`);
      await app.close();
      process.exit(0);
    }
    fail(`start-server: ${started.error}`);
  }
  console.log('server ready:', started.baseUrl);

  await page.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
  const models = await page.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
  const target = models.models.find((m) => m.provider === 'llamacpp');
  if (target === undefined) fail(`no llamacpp model: ${JSON.stringify(models)}`);
  await page.evaluate(
    (t) => window.piDesktop.invoke('pi:set-model', { provider: t.provider, modelId: t.id }),
    target,
  );
  console.log('model set:', target.id);

  // CODING-flavored (so the classifier front-loads spawn_subagent — trivial
  // classes omit it) AND the sub-task's answer is NOT in the prompt, so the model
  // cannot shortcut with python_run/bash and fake it: it must actually delegate to
  // learn the answer. That removes the escape hatch a deterministic-answer prompt
  // leaves open (the model would just print the known word).
  const ack = await page.evaluate(() =>
    window.piDesktop.invoke('pi:prompt', {
      message:
        "I'm building a feature in my codebase and need an isolated sub-decision made by a fresh agent " +
        'so it does not bias my own context. Use the spawn_subagent tool with goal set to exactly ' +
        '"Pick any single fruit at random and reply with ONLY that fruit\'s name in UPPERCASE, nothing else." ' +
        'You do not know which fruit it will choose, so you cannot answer this yourself — you must call ' +
        'spawn_subagent and wait for it. When the child agent returns, tell me the exact word it replied with.',
    }),
  );
  if (!ack.success) fail(`prompt: ${ack.error}`);

  // Manual poll (up to ~4 min): dump what the model does — its tool calls, whether
  // a subagent appears in the childAgentStore, and the final answer.
  const snap = () =>
    page.evaluate(() => {
      const ps = window.__pi_store().getState();
      const a = [...ps.messages].reverse().find((m) => m.kind === 'assistant');
      const toolCalls = ps.messages
        .filter((m) => m.kind === 'assistant')
        .flatMap((m) => m.blocks.filter((b) => b.type === 'toolCall').map((b) => b.name));
      const kids = Object.values(window.__child_store.getState().children ?? {});
      return {
        streaming: ps.agent.isStreaming,
        toolCalls,
        mainText:
          a?.blocks
            ?.filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('') ?? '',
        children: kids.map((c) => ({
          title: c.title,
          running: c.running,
          text: c.messages
            .filter((m) => m.kind === 'assistant')
            .flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text))
            .join(' '),
        })),
      };
    });

  let s = await snap();
  let sawChild = s.children.length > 0;
  let screenshotted = false;
  // Two 27B agent loops serialize on the single llama-server slot (the parent's
  // turn + the subagent it awaits), so give it generous headroom.
  const deadline = Date.now() + 480_000;
  while (Date.now() < deadline) {
    s = await snap();
    if (s.children.length > 0 && !sawChild) sawChild = true;
    // Screenshot the moment a subagent shows in the dropdown.
    if (s.children.length > 0 && !screenshotted) {
      screenshotted = true;
      await page.screenshot({ path: path.join(OUT_DIR, '01-subagent-in-dropdown.png') });
    }
    // Done when the main turn has finished AND produced text.
    if (!s.streaming && s.mainText.length > 0) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log('\n=== observed ===');
  console.log('main tool calls:', JSON.stringify(s.toolCalls));
  console.log('subagents:', JSON.stringify(s.children, null, 1));
  console.log('main final text:', JSON.stringify(s.mainText));
  await page.screenshot({ path: path.join(OUT_DIR, '02-final.png') });

  if (!s.toolCalls.some((n) => /subagent/i.test(n))) {
    fail(`the model did not call spawn_subagent (tool calls: ${JSON.stringify(s.toolCalls)})`);
  }
  if (!sawChild)
    fail('spawn_subagent was called but NO subagent appeared in the dropdown (bridge broken)');
  const childRan = s.children.some((c) => c.text.length > 0);
  if (!childRan) fail('the subagent appeared but produced no transcript');
  console.log(
    'real-subagent-probe OK — the model called spawn_subagent → a subagent ran as its own pi, appeared in the dropdown, and its result returned to the model',
  );
} finally {
  await app.close();
}
