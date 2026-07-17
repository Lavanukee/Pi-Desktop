import { describe, expect, it } from 'vitest';
import { BASE_EXTENSION_PACKAGE_DIRS, extensionPackageDirs } from './extension-dirs';

describe('extensionPackageDirs (gen-tools flag gating)', () => {
  it('OMITS gen-tools when the generation flag is off (default build stays clean)', () => {
    const dirs = extensionPackageDirs(false);
    expect(dirs).not.toContain('gen-tools');
    expect(dirs).toEqual(BASE_EXTENSION_PACKAGE_DIRS);
  });

  it('APPENDS gen-tools when the generation flag is on', () => {
    const dirs = extensionPackageDirs(true);
    expect(dirs).toContain('gen-tools');
    expect(dirs.at(-1)).toBe('gen-tools');
    // Additive: every base extension is still present, in order.
    expect(dirs.slice(0, BASE_EXTENSION_PACKAGE_DIRS.length)).toEqual([
      ...BASE_EXTENSION_PACKAGE_DIRS,
    ]);
  });

  it('base list carries the always-on providers/tools', () => {
    expect(BASE_EXTENSION_PACKAGE_DIRS).toContain('provider-llamacpp');
    expect(BASE_EXTENSION_PACKAGE_DIRS).toContain('web-tools');
    expect(BASE_EXTENSION_PACKAGE_DIRS).not.toContain('gen-tools');
  });
});
