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
  env: { ...process.env, PI_E2E: '1', PI_DESKTOP_CORP: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30_000 });
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
  const effortNow = await page.evaluate(async (level) => {
    const s = await window.piDesktop.invoke('settings:set', {
      patch: { effort: level, effortMode: 'level' },
    });
    return s?.effort ?? null;
  }, EFFORT);
  if (effortNow !== EFFORT) {
    console.error(`corp-headed-run: effort is "${effortNow}", wanted "${EFFORT}" — refusing to`);
    console.error('start, because below the top levels there is no corporation to observe.');
    await app.close().catch(() => {});
    process.exit(3);
  }
  log('effort:', effortNow);

  // The project the chat works in — and therefore the project the TEAM belongs to.
  const project = await page.evaluate(async (dir) => {
    try {
      // `project:set` with a path is what the folder picker calls.
      const r = await window.piDesktop.invoke('project:set', { path: dir });
      return r?.activePath ?? r?.path ?? dir;
    } catch {
      return null;
    }
  }, PROJECT);
  log('project:', project ?? `(not set — the run will use the app default)`);
  await page.waitForTimeout(2000);

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

  await page.screenshot({ path: path.join(OUT, 'final.png') });
  log('done watching · screenshots:', OUT);
  console.log(`\nProject (go and look): ${PROJECT}`);
  console.log(`Screenshots:           ${OUT}`);
} finally {
  await app.close().catch(() => {});
}
