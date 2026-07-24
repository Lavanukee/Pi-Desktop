import { describe, expect, it } from 'vitest';
import { assembleSidecarArgs, resolveUv, SIDECAR_HF_HUB_PIN } from './sidecar';

describe('assembleSidecarArgs', () => {
  it('builds the pinned uv run argv', () => {
    const args = assembleSidecarArgs({
      serverScript: '/pkg/python/server.py',
      port: 4242,
      cacheDir: '/home/u/.cache/pi-desktop/gen3d',
      sandboxDir: '/home/u/.pi/desktop/sandbox/gen3d',
      registryPath: '/home/u/.cache/pi-desktop/gen3d/registry.json',
    });
    expect(args).toEqual([
      'run',
      '--no-project',
      '--python',
      '3.12',
      '--with',
      `huggingface_hub==${SIDECAR_HF_HUB_PIN}`,
      '/pkg/python/server.py',
      '--port',
      '4242',
      '--cache-dir',
      '/home/u/.cache/pi-desktop/gen3d',
      '--sandbox-dir',
      '/home/u/.pi/desktop/sandbox/gen3d',
      '--registry',
      '/home/u/.cache/pi-desktop/gen3d/registry.json',
    ]);
  });
});

describe('resolveUv', () => {
  const statFor = (present: string[]) => async (p: string) => {
    if (present.includes(p)) return { isFile: () => true };
    throw new Error('ENOENT');
  };

  it('prefers PATH hits', async () => {
    const uv = await resolveUv({
      pathEnv: '/usr/local/bin:/opt/bin',
      home: '/home/u',
      statFn: statFor(['/opt/bin/uv', '/home/u/.local/bin/uv']),
    });
    expect(uv).toBe('/opt/bin/uv');
  });

  it('falls back to the app-provisioned copy, then ~/.local/bin', async () => {
    const provisioned = await resolveUv({
      pathEnv: '/usr/bin',
      home: '/home/u',
      statFn: statFor(['/home/u/.cache/pi-desktop/uv/uv']),
    });
    expect(provisioned).toBe('/home/u/.cache/pi-desktop/uv/uv');
    const local = await resolveUv({
      pathEnv: '/usr/bin',
      home: '/home/u',
      statFn: statFor(['/home/u/.local/bin/uv']),
    });
    expect(local).toBe('/home/u/.local/bin/uv');
  });

  it('returns undefined when uv is nowhere', async () => {
    expect(
      await resolveUv({ pathEnv: '/usr/bin', home: '/h', statFn: statFor([]) }),
    ).toBeUndefined();
  });
});
