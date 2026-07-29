/**
 * The primitives both the chat's terminal router and the corp's activity tab
 * render with. The property that matters here is GROWTH: a mirror's text must
 * only ever be extended as a command runs, because that is what lets the xterm
 * append the new characters instead of resetting and rewriting the whole buffer
 * — the difference between a live terminal and a screen that rebuilds itself
 * every tick and throws away wherever the user had scrolled to.
 */
import { describe, expect, it } from 'vitest';
import { isInteractiveCommand, mirrorCommandText, shortCommandTitle } from './agent-surfaces';

describe('a mirror only ever grows', () => {
  it('a running command is its prompt line and nothing else', () => {
    // What a real terminal shows while something works — and it means the output
    // that follows is an APPEND, not a rewrite.
    expect(mirrorCommandText('npm test', '', true)).toBe('$ npm test\n\n');
  });

  it('output arriving EXTENDS the running text', () => {
    const running = mirrorCommandText('npm test', '', true);
    const partial = mirrorCommandText('npm test', 'PASS a.test.ts', true);
    const settled = mirrorCommandText('npm test', 'PASS a.test.ts\nPASS b.test.ts', false);
    expect(partial.startsWith(running)).toBe(true);
    expect(settled.startsWith(partial)).toBe(true);
  });

  it('a finished command that printed nothing SAYS so', () => {
    // Distinct from "still going" — the corp's old copy reported every quiet
    // mkdir as running forever.
    expect(mirrorCommandText('mkdir -p out', '', false)).toBe('$ mkdir -p out\n\n(no output)\n');
    expect(mirrorCommandText('mkdir -p out', '', false).startsWith(
      mirrorCommandText('mkdir -p out', '', true),
    )).toBe(true);
  });

  it('a second command extends the transcript rather than replacing it', () => {
    const one = [mirrorCommandText('ls', 'a\nb', false)].join('\n');
    const two = [
      mirrorCommandText('ls', 'a\nb', false),
      mirrorCommandText('npm test', '', true),
    ].join('\n');
    expect(two.startsWith(one)).toBe(true);
  });
});

describe('which commands earn a terminal of their own in the chat', () => {
  it('takes the long-running and interactive ones', () => {
    for (const c of ['npm run dev', 'vite', 'tail -f log.txt', 'python3 -m http.server', 'x &']) {
      expect(isInteractiveCommand(c)).toBe(true);
    }
  });

  it('leaves an ordinary one-shot in the activity chain', () => {
    for (const c of ['ls', 'git status', 'cat x.txt', '  ']) {
      expect(isInteractiveCommand(c)).toBe(false);
    }
  });
});

describe('the short title', () => {
  it('is the first few words, clipped', () => {
    expect(shortCommandTitle('npm run build --workspace apps/desktop')).toBe('npm run build');
    expect(shortCommandTitle('a'.repeat(40)).length).toBeLessThanOrEqual(28);
  });
});
