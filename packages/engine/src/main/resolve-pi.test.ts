import { describe, expect, it } from 'vitest';
import { locateBundledPiCli, resolvePiSpawn } from './resolve-pi';

const CLI = '/fake/app/node_modules/@mariozechner/pi-coding-agent/dist/cli.js';
const existsAtFakeApp = (candidate: string): boolean => candidate === CLI;
const existsNowhere = (): boolean => false;

describe('locateBundledPiCli', () => {
  it('finds the CLI directly under appRoot/node_modules', () => {
    expect(locateBundledPiCli('/fake/app', existsAtFakeApp)).toBe(CLI);
  });

  it('walks up parent directories (monorepo hoisting)', () => {
    expect(locateBundledPiCli('/fake/app/packages/desktop', existsAtFakeApp)).toBe(CLI);
  });

  it('returns undefined when nothing is installed', () => {
    expect(locateBundledPiCli('/fake/app', existsNowhere)).toBeUndefined();
  });
});

describe('resolvePiSpawn resolution order', () => {
  it('1) explicit binPath wins over everything', () => {
    const plan = resolvePiSpawn({
      binPath: '/custom/pi',
      env: { PI_BIN: '/env/pi' },
      appRoot: '/fake/app',
      fileExists: existsAtFakeApp,
    });
    expect(plan).toEqual({ command: '/custom/pi', argsPrefix: [], env: {}, source: 'binPath' });
  });

  it('2) PI_BIN env wins over bundled', () => {
    const plan = resolvePiSpawn({
      env: { PI_BIN: '/env/mock-pi.mjs' },
      appRoot: '/fake/app',
      fileExists: existsAtFakeApp,
    });
    expect(plan).toEqual({
      command: '/env/mock-pi.mjs',
      argsPrefix: [],
      env: {},
      source: 'env',
    });
  });

  it('3) bundled cli.js under Electron: execPath + ELECTRON_RUN_AS_NODE', () => {
    const plan = resolvePiSpawn({
      env: {},
      appRoot: '/fake/app',
      execPath: '/Applications/Pi.app/Contents/MacOS/Pi',
      isElectron: true,
      fileExists: existsAtFakeApp,
    });
    expect(plan).toEqual({
      command: '/Applications/Pi.app/Contents/MacOS/Pi',
      argsPrefix: [CLI],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      source: 'bundled',
    });
  });

  it('3b) bundled cli.js outside Electron: plain node, no env override', () => {
    const plan = resolvePiSpawn({
      env: {},
      appRoot: '/fake/app',
      isElectron: false,
      fileExists: existsAtFakeApp,
    });
    expect(plan).toEqual({ command: 'node', argsPrefix: [CLI], env: {}, source: 'bundled' });
  });

  it('4) falls back to PATH when the bundled package is missing', () => {
    const plan = resolvePiSpawn({
      env: {},
      appRoot: '/fake/app',
      fileExists: existsNowhere,
    });
    expect(plan).toEqual({ command: 'pi', argsPrefix: [], env: {}, source: 'path' });
  });

  it('4b) falls back to PATH with no appRoot at all', () => {
    const plan = resolvePiSpawn({ env: {} });
    expect(plan).toEqual({ command: 'pi', argsPrefix: [], env: {}, source: 'path' });
  });

  it('treats empty-string PI_BIN as unset', () => {
    const plan = resolvePiSpawn({ env: { PI_BIN: '' }, fileExists: existsNowhere });
    expect(plan.source).toBe('path');
  });

  it('really locates the workspace-installed pi package (bundled path exists)', () => {
    const plan = resolvePiSpawn({
      env: {},
      appRoot: new URL('../../', import.meta.url).pathname,
      isElectron: false,
    });
    expect(plan.source).toBe('bundled');
    expect(plan.argsPrefix[0]).toMatch(/pi-coding-agent\/dist\/cli\.js$/);
  });
});
