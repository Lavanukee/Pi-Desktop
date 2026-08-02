import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPreview, describeProject } from './present-bridge.js';

const dir = () => mkdtempSync(path.join(tmpdir(), 'present-'));

describe('describeProject', () => {
  /* The Godot run wrote 14 files and opened none. A folder is exactly where
   * "it exists" gets mistaken for "it works", so the entry point is named. */
  it('names the entry point that decides whether it opens', async () => {
    const d = dir();
    writeFileSync(path.join(d, 'project.godot'), 'x');
    writeFileSync(path.join(d, 'player.gd'), 'y');
    const out = await describeProject(d);
    expect(out).toContain('Entry point: project.godot');
    expect(out).toContain('2 entries');
  });

  /* jedd, on a presented Godot project: "I can't as the user go and see the run
   * even primitively... pressing f5, won't do anything. it hasn't installed
   * godot or looked for an installation." A project whose runtime is absent is
   * unopenable, and the model has no way to know that unless we say so. */
  it('says the runtime is missing when it is not on this machine', async () => {
    const d = dir();
    writeFileSync(path.join(d, 'project.godot'), 'x');
    const out = await describeProject(d, async () => false);
    expect(out).toContain('IS NOT INSTALLED');
    expect(out).toContain('godot');
    expect(out).toContain('do NOT describe it as finished');
  });

  it('stays quiet about the runtime when it IS installed', async () => {
    const d = dir();
    writeFileSync(path.join(d, 'project.godot'), 'x');
    const out = await describeProject(d, async () => true);
    expect(out).toContain('opened with Godot');
    expect(out).not.toContain('NOT INSTALLED');
  });

  /* An HTML file needs nothing installed, so probing would be a lie waiting to
   * happen — a machine without `open` on PATH is not a machine without a browser. */
  it('never claims a missing runtime for something a browser opens', async () => {
    const d = dir();
    writeFileSync(path.join(d, 'index.html'), '<p>x</p>');
    const out = await describeProject(d, async () => false);
    expect(out).toContain('opened with a browser');
    expect(out).not.toContain('NOT INSTALLED');
  });

  it('says plainly when a folder is not yet a project', async () => {
    const d = dir();
    writeFileSync(path.join(d, 'a.txt'), 'x');
    const out = await describeProject(d);
    expect(out).toContain('No recognisable entry point');
    expect(out).toContain('not yet a project a user can open');
  });
});

describe('buildPreview', () => {
  it('returns an image as bytes the model can see', async () => {
    const d = dir();
    const f = path.join(d, 'a.png');
    writeFileSync(f, Buffer.from('PNGDATA'));
    const p = await buildPreview(f, 'image');
    expect(p.imageBase64).toBe(Buffer.from('PNGDATA').toString('base64'));
    expect(p.mimeType).toBe('image/png');
  });

  /* An empty artefact is the classic silent failure — it must not read as fine. */
  it('calls an empty file EMPTY', async () => {
    const d = dir();
    const f = path.join(d, 'notes.md');
    writeFileSync(f, '   \n  ');
    expect((await buildPreview(f, 'text')).text).toBe('The file is EMPTY.');
  });

  it('runs a script and returns what it printed', async () => {
    const d = dir();
    const f = path.join(d, 'hi.py');
    writeFileSync(f, 'print("hello from the artefact")');
    const p = await buildPreview(f, 'run');
    expect(p.text).toContain('hello from the artefact');
  });

  it('says so when running printed nothing at all', async () => {
    const d = dir();
    const f = path.join(d, 'quiet.py');
    writeFileSync(f, 'x = 1');
    expect((await buildPreview(f, 'run')).text).toContain('printed nothing at all');
  });

  it('reports a failed render rather than returning a blank', async () => {
    const p = await buildPreview('/nope/index.html', 'render', { renderPage: async () => null });
    expect(p.error).toContain('could not be rendered');
  });

  it('lists a project folder', async () => {
    const d = dir();
    await mkdir(path.join(d, 'scripts'), { recursive: true });
    writeFileSync(path.join(d, 'index.html'), '<p>hi</p>');
    expect((await buildPreview(d, 'project')).text).toContain('Entry point: index.html');
  });

  it('surfaces an unreadable path as an error, not as silence', async () => {
    expect((await buildPreview('/definitely/not/here.png', 'image')).error).toBeDefined();
  });
});
