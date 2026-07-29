/**
 * corp-headed-run.mjs — start a corp run the way a USER does, in the real app.
 *
 * jedd's ask, and it is the right one: every corp run so far has been driven by
 * `corp-mesh-run.mjs`, which builds the mesh directly in a bare node process. That
 * proves the harness and proves nothing about the product. It skips the app, the
 * IPC, the effort slider, the situation room — the entire surface a person
 * actually touches — so a run can be perfect while the thing the user opens does
 * not start a corp at all.
 *
 * This drives Bobble itself: launch the built app with a VISIBLE window, set the
 * effort the corporation is gated behind, point the chat at a project directory,
 * type the task into the real composer and press Enter. Then it stays out of the
 * way, screenshotting on a timer, so the situation room can be watched live —
 * agents appearing, contracts moving, the roadmap filling in — exactly as a user
 * would watch it.
 *
 *   TASK       what to ask for                  (required, or --task)
 *   PROJECT    the chat's working directory     (default: a fresh /tmp project)
 *   EFFORT     low | medium | high | max        (default: max — the corp is gated
 *              behind the top two levels; below that a single solo agent runs)
 *   MINUTES    how long to watch                (default: 45)
 *   SHOT_MS    ms between screenshots           (default: 60000)
 *   OUT        where screenshots + dumps go     (default .corp-runs/corp-headed)
 *
 * Exit code 0 means the run was DRIVEN, never that the product is good — the
 * verification is the hierarchy, and ultimately a human looking at the artifacts.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const TASK = process.env.TASK ?? arg('task', '');
/** Words that say nothing about what is being built. */
const STOPWORDS = new Set([
  'build', 'make', 'create', 'write', 'real', 'the', 'and', 'for', 'with', 'that', 'this',
  'into', 'from', 'like', 'any', 'all', 'can', 'has', 'have', 'them', 'they', 'you', 'your',
  'able', 'must', 'need', 'want', 'please', 'app', 'application',
]);
const EFFORT = process.env.EFFORT ?? arg('effort', 'max');
const MINUTES = Number(process.env.MINUTES ?? arg('minutes', '45'));
const SHOT_MS = Number(process.env.SHOT_MS ?? 60_000);
const OUT = process.env.OUT ?? path.join(repoRoot, '.corp-runs', 'corp-headed');
/*
 * A REAL, NAMED FOLDER — never a temp path with a random suffix.
 *
 * The default used to be `mkdtemp('/tmp/corp-project-')`, which produces
 * `/tmp/corp-project-Xk9fL2`. jedd, watching a run go into one: "that's just not
 * going to work." He is right, and not only aesthetically. That directory means
 * nothing to the person who has to open it afterwards, it is swept away by the
 * OS, and the TEAM is keyed to its path — so a project whose folder is a random
 * string is a team that can never be returned to, which is the one thing the
 * hierarchy exists to provide.
 */
const requested = process.env.PROJECT ?? arg('project', '');
const PROJECT = path.resolve(requested !== '' ? requested : defaultProjectDir());

function defaultProjectDir() {
  const slug =
    TASK.toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .slice(0, 3)
      .join('-') || 'corp-project';
  return path.join(process.env.HOME ?? '/tmp', 'Desktop', slug);
}

if (TASK.trim() === '') {
  console.error('corp-headed-run: set TASK="..." (or --task "...")');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
mkdirSync(PROJECT, { recursive: true });

if (
  !existsSync(path.join(appRoot, 'dist/index.html')) ||
  !existsSync(path.join(appRoot, 'dist-electron/main.js'))
) {
  console.error('corp-headed-run: app is not built — run `npm run build` in apps/desktop first');
  process.exit(2);
}

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const log = (...a) => console.error(`[${since()}] ${a.join(' ')}`);

// A dedicated profile, so this never disturbs the real app's state — but NOT a
// throwaway one: the hierarchy lives in userData, and the whole point of a team
// is that it is still there next time.
const userDataDir = path.join(repoRoot, '.corp-runs', 'corp-headed-profile');
mkdirSync(userDataDir, { recursive: true });

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  // PI_E2E exposes the store for observation. There is no mock here: this is the
  // real local model, because a corp run against a fixture proves nothing.
  env: {
    ...process.env,
    PI_E2E: '1',
    PI_DESKTOP_CORP: '1',
    /*
     * FORCE IS OPT-IN NOW. It used to default ON, and the app this probe leaves
     * open is one jedd then types into — so every message he sent, "hi" included,
     * was forced into a corporation and answered with "Reading the request and
     * deciding how to approach it." He reported it as a product bug. It was this
     * flag: a testing-only switch that made the app I handed him behave unlike
     * the app he ships.
     *
     * Set FORCE=1 when a probe genuinely needs a corp on the first message.
     * Otherwise the model decides, exactly as it does for a real user.
     */
    ...(process.env.FORCE === '1' ? { PI_DESKTOP_CORP_FORCE: '1' } : {}),
  },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(
    () => typeof window.__pi_store === 'function' && typeof window.__pi_project === 'function',
    { timeout: 30_000 },
  );
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 });
  log('app up · project:', PROJECT);

  /*
   * EFFORT FIRST, AND VERIFIED. The corporation is gated behind the top levels;
   * below them the same prompt runs as ONE solo agent with no hierarchy at all.
   * The first version of this set it through a store call wrapped in a try/catch,
   * which silently did nothing — and the run that followed was a lone agent
   * flailing in a directory that did not exist, with `Effort · Low` sitting in the
   * corner of the screenshot. Set it through the real IPC, then READ IT BACK.
   */
  /*
   * THROUGH THE RENDERER'S STORE, AND CONFIRMED ON SCREEN.
   *
   * The previous version called the `settings:set` IPC and believed the value
   * main handed back. Main is not who decides: the RENDERER stamps `effort` on
   * the corp request, and `settings:set` does not push into its store. So the
   * probe reported "effort: max", the request went out at whatever the renderer
   * still held, and two runs I told jedd were the corporation were a single solo
   * agent — with `Effort · Low` sitting in the corner of the screenshot the whole
   * time. This is the SAME mistake the project chip had, in the same file, fixed
   * the same way: drive the store a user drives, then read the screen.
   */
  const effortNow = await page.evaluate(async (level) => {
    const store = window.__settings_store?.();
    if (store === undefined) return 'no-store';
    await store.getState().update({ effort: level, effortMode: 'level' });
    return store.getState().settings.effort;
  }, EFFORT);
  await page.waitForTimeout(1500);
  const effortChip = (await page.textContent('[data-testid="composer-effort"]').catch(() => null))
    ?? (await page.evaluate(() => {
      const el = [...document.querySelectorAll('button, span')].find((n) =>
        /Effort\s*·/.test(n.textContent ?? ''),
      );
      return el?.textContent ?? '';
    }));
  const wantLabel = { low: 'Low', medium: 'Balanced', high: 'High', max: 'Max' }[EFFORT] ?? EFFORT;
  if (effortNow !== EFFORT || !new RegExp(wantLabel, 'i').test(effortChip ?? '')) {
    console.error(`corp-headed-run: effort is "${effortNow}" and the chip reads`);
    console.error(`"${(effortChip ?? '').trim()}" — wanted "${EFFORT}" / "${wantLabel}".`);
    console.error('Refusing to start: below the top levels there is no corporation to observe,');
    console.error('and a run reported as the corp that was a solo agent is worse than no run.');
    await app.close().catch(() => {});
    process.exit(3);
  }
  log('effort:', effortNow, '· chip:', (effortChip ?? '').trim());

  /*
   * THE PROJECT — set it, then CONFIRM IT ON SCREEN.
   *
   * The previous attempt called `project:set` and believed the value it got
   * back. The app kept the project from the last session, the run went to that
   * old folder, and I reported it as landing in the new one. The composer's
   * folder chip is the same thing a user reads, so read that: if it does not say
   * this project, nothing downstream is trustworthy.
   */
  await page.evaluate(async (dir) => {
    // Through the STORE, not the IPC. Calling `project:set` directly switches the
    // project in the main process and leaves the renderer none the wiser — and the
    // renderer's store is what corp-connect reads when it starts a run, so the
    // work went to the previous session's folder while the log said otherwise.
    await window.__pi_project?.().getState().selectPath(dir);
  }, PROJECT);
  await page.waitForTimeout(2500);
  const chip = (await page.textContent('.pd-project-chip').catch(() => null)) ?? '';
  const want = path.basename(PROJECT);
  if (!chip.includes(want)) {
    console.error(`corp-headed-run: the folder chip reads "${chip.trim()}", not "${want}".`);
    console.error('Refusing to start — the run would go somewhere other than the project you');
    console.error('asked for, and the team is keyed to that path.');
    await app.close().catch(() => {});
    process.exit(4);
  }
  log('project confirmed on screen:', chip.trim());

  await page.click('[data-testid="composer-input"]');
  await page.keyboard.insertText(TASK);
  await page.keyboard.press('Enter');
  log('task sent — watch the situation room');

  const deadline = Date.now() + MINUTES * 60_000;
  let n = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(SHOT_MS);
    n += 1;
    const shot = path.join(OUT, `t${String(n).padStart(3, '0')}.png`);
    try {
      await page.screenshot({ path: shot });
    } catch {
      log('window went away — stopping');
      break;
    }
    const state = await page.evaluate(() => {
      const st = window.__pi_store?.().getState?.() ?? {};
      const msgs = st.messages ?? [];
      const last = msgs[msgs.length - 1];
      return {
        messages: msgs.length,
        streaming: msgs.some((m) => m.isStreaming === true),
        tail:
          last?.kind === 'assistant'
            ? (last.blocks ?? [])
                .map((b) => b.text ?? b.thinking ?? '')
                .join('')
                .slice(-160)
            : (last?.text ?? '').slice(-160),
      };
    });
    log(`t+${n} · ${state.messages} msgs · ${state.streaming ? 'working' : 'idle'} · ${state.tail}`);
    writeFileSync(path.join(OUT, 'last-state.json'), JSON.stringify(state, null, 2));
  }

  /*
   * A SUBAGENT'S OWN CHAT. The point of the display unification is that opening a
   * subagent gives you a chat like any other, so the run has to be observed that
   * way and not only as a room full of rows.
   */
  await page.evaluate(() => {
    const corp = window.__corpStore;
    const nodes = corp?.getState().situation?.chart.nodes ?? [];
    const worker = nodes.find((n) => n.parentId !== undefined);
    if (worker !== undefined) corp.getState().selectNode(worker);
  }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, 'subagent-chat.png') });

  await page.screenshot({ path: path.join(OUT, 'final.png') });
  log('done watching · screenshots:', OUT);
  console.log(`\nProject (go and look): ${PROJECT}`);
  console.log(`Screenshots:           ${OUT}`);
} finally {
  await app.close().catch(() => {});
}
