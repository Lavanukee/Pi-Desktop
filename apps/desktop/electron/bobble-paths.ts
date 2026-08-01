/**
 * Where Bobble puts things, in paths a person can read and type.
 *
 * jedd: "I need absolutely everything that the model generates and the folders,
 * sandboxes it uses to all have simple names and paths, no complicated
 * var/askldfjh;lkh/asdjkgbm,3241/1324iu1b types of things."
 *
 * He is describing what the app actually produced. A rendered animation landed at
 *
 *   /var/folders/4h/nq1c73q107v594j4g0lq6bw00000gn/T/pi-generated/
 *     gen_1785566138272_fc7490/frame_000.png
 *
 * and a browser capture at `bobble-screenshot-m9x2k1.png` in the same temp tree.
 * Nobody can find either of those, the model cannot say a useful path back to the
 * user, and the OS deletes them when it feels like it.
 *
 * Everything now lives under ONE visible folder — `~/Bobble` — with a plain
 * name per artefact:
 *
 *   ~/Bobble/generated/animation-1/frame_000.png
 *   ~/Bobble/screenshots/example-com.png
 *   ~/Bobble/chats/untitled-chat-2
 *
 * Names are derived from what the thing IS, deduplicated with a small counter
 * rather than a timestamp or a hash, so the second animation is `animation-2`.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** The one visible root. Everything the app writes for the user goes under here. */
export function bobbleHome(home: string = homedir()): string {
  return path.join(home, 'Bobble');
}

export const GENERATED_DIR = 'generated';
export const SCREENSHOTS_DIR = 'screenshots';
export const CHATS_DIR = 'chats';

/**
 * A filesystem-safe, readable slug: lowercase words joined by single hyphens.
 *
 * Deliberately plain — no timestamps, no hashes, no unicode. `Example Domain`
 * becomes `example-domain`, `https://example.com/` becomes `example-com`.
 */
export function slug(input: string, fallback = 'untitled'): string {
  const s = input
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return s.length > 0 ? s : fallback;
}

/**
 * `<dir>/<name>` if free, else `<dir>/<name>-2`, `-3`, …
 *
 * A counter rather than a timestamp because the point is that a person can read
 * it back and type it: "animation-2" is a name, "gen_1785566138272_fc7490" is an
 * identifier that happens to be in a path.
 */
export function uniqueName(
  dir: string,
  name: string,
  exists: (p: string) => boolean = existsSync,
): string {
  if (!exists(path.join(dir, name))) return name;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${name}-${n}`;
    if (!exists(path.join(dir, candidate))) return candidate;
  }
  return `${name}-${Date.now().toString(36)}`;
}

/** Ensure a subfolder of ~/Bobble exists and return it. */
export function bobbleDir(kind: string, home: string = homedir()): string {
  const dir = path.join(bobbleHome(home), kind);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A directory for one generation job, named after what was asked for.
 * `generatedDir('a logo sliding in', 'animation')` → `~/Bobble/generated/a-logo-sliding-in`.
 */
export function generatedDir(
  description: string,
  fallback: string,
  home: string = homedir(),
): string {
  const root = bobbleDir(GENERATED_DIR, home);
  const dir = path.join(root, uniqueName(root, slug(description, fallback)));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A path for one browser capture, named after the page.
 * `screenshotPath('https://example.com/')` → `~/Bobble/screenshots/example-com.png`.
 */
export function screenshotPath(pageUrlOrTitle: string, home: string = homedir()): string {
  const root = bobbleDir(SCREENSHOTS_DIR, home);
  return path.join(root, `${uniqueName(root, slug(pageUrlOrTitle, 'page'))}.png`);
}
