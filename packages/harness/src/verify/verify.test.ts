import { describe, expect, it, vi } from 'vitest';
import {
  type CheckOutcome,
  detectPackageManager,
  detectProjectCheck,
  type ProjectProbe,
  runCheck,
  runVerifyPass,
  syntaxCheckCommand,
  type VerifyBashRunner,
} from './verify.js';

/** Build a probe from a map of repo-relative path → contents. */
function probe(files: Record<string, string>): ProjectProbe {
  return {
    readText: (rel) => (rel in files ? files[rel] : undefined),
    exists: (rel) => rel in files,
  };
}

describe('detectPackageManager', () => {
  it('reads the lockfile, defaulting to npm', () => {
    expect(detectPackageManager(probe({ 'pnpm-lock.yaml': '' }))).toBe('pnpm');
    expect(detectPackageManager(probe({ 'yarn.lock': '' }))).toBe('yarn');
    expect(detectPackageManager(probe({ 'bun.lockb': '' }))).toBe('bun');
    expect(detectPackageManager(probe({ 'package.json': '{}' }))).toBe('npm');
  });
});

describe('detectProjectCheck', () => {
  it('prefers a package.json test script and the right package manager', () => {
    const c = detectProjectCheck(
      probe({
        'package.json': JSON.stringify({ scripts: { test: 'vitest', lint: 'biome' } }),
        'pnpm-lock.yaml': '',
      }),
    );
    expect(c).toEqual({ command: 'pnpm run test', kind: 'test', label: 'pnpm run test' });
  });

  it('falls to typecheck, then lint, then build when test is absent', () => {
    expect(
      detectProjectCheck(
        probe({ 'package.json': JSON.stringify({ scripts: { lint: 'x', build: 'y' } }) }),
      )?.kind,
    ).toBe('lint');
    expect(
      detectProjectCheck(
        probe({ 'package.json': JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'x' } }) }),
      ),
    ).toEqual({ command: 'npm run typecheck', kind: 'typecheck', label: 'npm run typecheck' });
    expect(
      detectProjectCheck(probe({ 'package.json': JSON.stringify({ scripts: { build: 'y' } }) }))
        ?.kind,
    ).toBe('build');
  });

  it('returns null for a package.json with no useful scripts', () => {
    expect(
      detectProjectCheck(
        probe({ 'package.json': JSON.stringify({ scripts: { start: 'node .' } }) }),
      ),
    ).toBeNull();
  });

  it('ignores malformed package.json without throwing', () => {
    expect(detectProjectCheck(probe({ 'package.json': '{ not json' }))).toBeNull();
  });

  it('detects a Makefile target', () => {
    expect(detectProjectCheck(probe({ Makefile: 'test:\n\tpytest\n' }))).toEqual({
      command: 'make test',
      kind: 'test',
      label: 'make test',
    });
    expect(detectProjectCheck(probe({ Makefile: 'lint:\n\truff .\n' }))?.kind).toBe('lint');
  });

  it('detects Rust, Go, and pytest-configured Python projects', () => {
    expect(detectProjectCheck(probe({ 'Cargo.toml': '[package]' }))?.command).toBe('cargo check');
    expect(detectProjectCheck(probe({ 'go.mod': 'module x' }))?.command).toBe('go build ./...');
    expect(detectProjectCheck(probe({ 'pytest.ini': '[pytest]' }))?.command).toBe(
      'python3 -m pytest -q',
    );
    expect(
      detectProjectCheck(probe({ 'pyproject.toml': '[tool.pytest.ini_options]\n' }))?.kind,
    ).toBe('test');
  });

  it('returns null when no infra is present', () => {
    expect(detectProjectCheck(probe({ 'README.md': '# hi' }))).toBeNull();
  });
});

describe('syntaxCheckCommand', () => {
  it('py_compiles touched Python files (quoted)', () => {
    const c = syntaxCheckCommand(['a.py', "weird name's.py", 'notes.txt']);
    expect(c?.kind).toBe('syntax');
    expect(c?.command).toBe(`python3 -m py_compile 'a.py' 'weird name'\\''s.py'`);
  });

  it('node --checks a single plain JS file', () => {
    expect(syntaxCheckCommand(['x.mjs'])?.command).toBe(`node --check 'x.mjs'`);
  });

  it('returns null when nothing is sanity-checkable (e.g. TS only)', () => {
    expect(syntaxCheckCommand(['a.ts', 'b.tsx'])).toBeNull();
    expect(syntaxCheckCommand([])).toBeNull();
  });
});

describe('runCheck', () => {
  const check = { command: 'npm run test', kind: 'test', label: 'npm run test' } as const;

  it('maps exit 0 → pass', async () => {
    const run: VerifyBashRunner = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
    const r = await runCheck(run, check, { cwd: '/w' });
    expect(r.status).toBe('pass');
  });

  it('maps a non-zero exit → fail and captures output', async () => {
    const run: VerifyBashRunner = vi.fn(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'FAIL: 3 tests',
    }));
    const r = await runCheck(run, check, { cwd: '/w' });
    expect(r.status).toBe('fail');
    expect(r.output).toContain('FAIL: 3 tests');
  });

  it('a timeout is inconclusive (fail-open, no fix)', async () => {
    const run: VerifyBashRunner = vi.fn(async () => ({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: true,
    }));
    expect((await runCheck(run, check, { cwd: '/w' })).status).toBe('inconclusive');
  });

  it('a runner that throws is inconclusive, not a crash', async () => {
    const run: VerifyBashRunner = vi.fn(async () => {
      throw new Error('spawn ENOENT');
    });
    const r = await runCheck(run, check, { cwd: '/w' });
    expect(r.status).toBe('inconclusive');
    expect(r.output).toContain('spawn ENOENT');
  });

  it('tail-truncates very long output', async () => {
    const run: VerifyBashRunner = vi.fn(async () => ({
      exitCode: 1,
      stdout: 'x'.repeat(10_000),
      stderr: '',
    }));
    const r = await runCheck(run, check, { cwd: '/w', maxOutputChars: 100 });
    expect(r.output.length).toBeLessThan(200);
    expect(r.output).toContain('elided');
  });
});

describe('runVerifyPass', () => {
  it('runs the detected project check', async () => {
    const run: VerifyBashRunner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const res = await runVerifyPass({
      cwd: '/w',
      runBash: run,
      detectCheck: () => ({ command: 'npm run test', kind: 'test', label: 'npm run test' }),
    });
    expect(res.check?.kind).toBe('test');
    expect(res.outcome?.status).toBe('pass');
    expect(run).toHaveBeenCalledWith('npm run test', expect.objectContaining({ cwd: '/w' }));
  });

  it('falls back to a syntax check over touched files when no infra is detected', async () => {
    const run: VerifyBashRunner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const res = await runVerifyPass({
      cwd: '/w',
      runBash: run,
      detectCheck: () => null,
      touchedFiles: ['mod.py'],
    });
    expect(res.check?.kind).toBe('syntax');
    expect(run).toHaveBeenCalledWith(expect.stringContaining('py_compile'), expect.anything());
  });

  it('runs nothing (check null) when there is no infra and no touched files', async () => {
    const run = vi.fn<VerifyBashRunner>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const res = await runVerifyPass({ cwd: '/w', runBash: run, detectCheck: () => null });
    expect(res).toEqual({ check: null, outcome: null });
    expect(run).not.toHaveBeenCalled();
  });
});

// Type guard so the CheckOutcome shape stays exercised.
const _sample: CheckOutcome = {
  status: 'pass',
  exitCode: 0,
  timedOut: false,
  output: '',
  command: 'x',
  kind: 'test',
};
void _sample;
