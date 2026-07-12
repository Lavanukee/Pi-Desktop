/**
 * Main-process skills handlers. Owns `~/.pi/agent/skills/<id>/` (the dir the pi
 * engine auto-discovers skills from) and copies bundled skill folders into it —
 * the SAME cpSync mechanism the Codex importer uses (import/import-main.ts's
 * applySkills). Reads its source folders from the app's bundled resources:
 * `<resources>/skills/<id>/` when packaged (electron-builder extraResources) or
 * the repo `apps/desktop/resources/skills/<id>/` in dev.
 *
 * Every id crossing the boundary is fenced to a single safe path segment
 * (isSafeSkillId) AND must exist in the bundled registry, so the copy/remove
 * targets can never traverse out of the two known dirs. Trusted-sender gated
 * like every other app channel.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger, type IpcHandlers, registerIpcHandlers } from '@pi-desktop/shared';
import { app, type IpcMain } from 'electron';
import type { SkillListItem, SkillsInvokeMap } from './skills-contract';
import { BUNDLED_SKILLS, getBundledSkill, isSafeSkillId } from './skills-registry';

const log = createLogger('desktop:skills');

const HOME = os.homedir();
const PI_SKILLS_DIR = path.join(HOME, '.pi', 'agent', 'skills');

/**
 * The bundled skills source dir. Packaged: extraResources puts them beside the
 * asar at `<Resources>/skills` (process.resourcesPath). Dev/E2E:
 * app.getAppPath() is apps/desktop, so the repo folder is resources/skills.
 */
function bundledSkillsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'skills')
    : path.join(app.getAppPath(), 'resources', 'skills');
}

/** A bundled skill is installed when its folder exists with a SKILL.md. */
function isInstalled(id: string): boolean {
  try {
    return fs.statSync(path.join(PI_SKILLS_DIR, id, 'SKILL.md')).isFile();
  } catch {
    return false;
  }
}

function list(): SkillListItem[] {
  return BUNDLED_SKILLS.map((skill) => ({ ...skill, installed: isInstalled(skill.id) }));
}

/** Resolve + fence a skill id to its bundled source folder, or null if invalid. */
function bundledSource(id: string): string | null {
  if (!isSafeSkillId(id) || getBundledSkill(id) === undefined) return null;
  const src = path.join(bundledSkillsDir(), id);
  try {
    if (!fs.statSync(path.join(src, 'SKILL.md')).isFile()) return null;
  } catch {
    return null;
  }
  return src;
}

function install(id: string): { skills: SkillListItem[]; error?: string } {
  const src = bundledSource(id);
  if (src === null) return { skills: list(), error: `unknown or unavailable skill: ${id}` };
  try {
    const dest = path.join(PI_SKILLS_DIR, id);
    // Overwrite-idempotent: clear any stale copy first so a re-install tracks the
    // bundled source exactly (cpSync would otherwise leave removed files behind).
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(PI_SKILLS_DIR, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    log.info('skill installed', { id });
    return { skills: list() };
  } catch (error) {
    log.warn('skill install failed', { id, error: String(error) });
    return { skills: list(), error: String(error instanceof Error ? error.message : error) };
  }
}

function remove(id: string): { skills: SkillListItem[]; error?: string } {
  if (!isSafeSkillId(id)) return { skills: list(), error: `invalid skill id: ${id}` };
  try {
    fs.rmSync(path.join(PI_SKILLS_DIR, id), { recursive: true, force: true });
    log.info('skill removed', { id });
    return { skills: list() };
  } catch (error) {
    return { skills: list(), error: String(error instanceof Error ? error.message : error) };
  }
}

/** Read a bundled skill's SKILL.md body (fenced like install/remove). */
function read(id: string): { body: string; error?: string } {
  const src = bundledSource(id);
  if (src === null) return { body: '', error: `unknown or unavailable skill: ${id}` };
  try {
    return { body: fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8') };
  } catch (error) {
    return { body: '', error: String(error instanceof Error ? error.message : error) };
  }
}

const handlers: IpcHandlers<SkillsInvokeMap> = {
  'skills:list': () => ({ skills: list() }),
  'skills:install': (req) => install(req.id),
  'skills:remove': (req) => remove(req.id),
  'skills:read': (req) => read(req.id),
};

export function registerSkillsIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
): void {
  registerIpcHandlers<SkillsInvokeMap>(ipcMain, handlers, { allowSender });
}
