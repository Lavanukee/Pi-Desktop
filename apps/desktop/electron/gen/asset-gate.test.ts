import { describe, expect, it, vi } from 'vitest';
import {
  type AssetConsent,
  type AssetGatePorts,
  type ComfyInstallLike,
  ensureAsset,
  ensureAssetThenContinue,
  GenAssetDeclinedError,
  type GenAssetNeed,
  makeComfyAssetGate,
} from './asset-gate';

const NEED: GenAssetNeed = { kind: 'pack', id: 'ltx-2', label: 'LTX-2 (video)', approxSizeGB: 8 };
const ACCEPT: AssetConsent = { accepted: true, acceptedLicenses: [] };
const DECLINE: AssetConsent = { accepted: false, acceptedLicenses: [] };

describe('ensureAsset / ensureAssetThenContinue (download-then-continue)', () => {
  it('present → continues immediately, never prompts or installs', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const prompt = vi.fn();
    const install = vi.fn();
    const run = vi.fn().mockResolvedValue('IMAGE');

    const out = await ensureAssetThenContinue(NEED, { probe, prompt, install }, run);

    expect(out).toBe('IMAGE');
    expect(prompt).not.toBeCalled();
    expect(install).not.toBeCalled();
    expect(run).toBeCalledTimes(1);
  });

  it('missing → prompt → ACCEPT → installs → CONTINUES and returns the job result', async () => {
    const order: string[] = [];
    const ports: AssetGatePorts = {
      probe: vi.fn(async () => {
        order.push('probe');
        return false;
      }),
      prompt: vi.fn(async () => {
        order.push('prompt');
        return ACCEPT;
      }),
      install: vi.fn(async () => {
        order.push('install');
      }),
    };
    const run = vi.fn(async () => {
      order.push('run');
      return { jobId: 'j1' };
    });

    const out = await ensureAssetThenContinue(NEED, ports, run);

    // The proof: after an accepted download the SAME job runs and yields output.
    expect(out).toEqual({ jobId: 'j1' });
    expect(order).toEqual(['probe', 'prompt', 'install', 'run']);
  });

  it('missing → DECLINE → throws GenAssetDeclinedError, never installs or runs', async () => {
    const install = vi.fn();
    const run = vi.fn();
    const ports: AssetGatePorts = {
      probe: async () => false,
      prompt: async () => DECLINE,
      install,
    };

    await expect(ensureAssetThenContinue(NEED, ports, run)).rejects.toBeInstanceOf(
      GenAssetDeclinedError,
    );
    expect(install).not.toBeCalled();
    expect(run).not.toBeCalled();
  });

  it('install failure propagates and the job does not run', async () => {
    const run = vi.fn();
    const ports: AssetGatePorts = {
      probe: async () => false,
      prompt: async () => ACCEPT,
      install: async () => {
        throw new Error('download interrupted');
      },
    };

    await expect(ensureAssetThenContinue(NEED, ports, run)).rejects.toThrow('download interrupted');
    expect(run).not.toBeCalled();
  });

  it('ensureAsset resolves void when present (bare gate form)', async () => {
    await expect(
      ensureAsset(NEED, { probe: async () => true, prompt: vi.fn(), install: vi.fn() }),
    ).resolves.toBeUndefined();
  });
});

describe('makeComfyAssetGate (reuses the gen install-manager)', () => {
  /** A fake ComfyInstallManager whose pack flips to installed once `run` is called. */
  function fakeComfy(initialInstalled: boolean): ComfyInstallLike & { runs: number } {
    let installed = initialInstalled;
    return {
      runs: 0,
      status: async () => ({
        runtime: 'runtime-ready',
        packs: [{ id: NEED.id, installed }],
      }),
      recordConsent: vi.fn(async () => {}),
      run: vi.fn(async function (this: { runs: number }) {
        this.runs += 1;
        installed = true;
        return {};
      }),
    };
  }

  it('present pack → does not prompt or download', async () => {
    const comfy = fakeComfy(true);
    const awaitConsent = vi.fn();
    const gate = makeComfyAssetGate(comfy, { awaitConsent });

    await expect(gate(NEED)).resolves.toBeUndefined();
    expect(awaitConsent).not.toBeCalled();
    expect(comfy.runs).toBe(0);
  });

  it('missing pack → prompts, records consent, downloads, then continue is allowed', async () => {
    const comfy = fakeComfy(false);
    const awaitConsent = vi.fn(async () => ACCEPT);
    const gate = makeComfyAssetGate(comfy, { awaitConsent });

    await expect(gate(NEED)).resolves.toBeUndefined();
    expect(awaitConsent).toBeCalledTimes(1);
    expect(comfy.recordConsent).toBeCalledTimes(1);
    expect(comfy.runs).toBe(1);
  });

  it('missing pack + decline → throws, never downloads', async () => {
    const comfy = fakeComfy(false);
    const gate = makeComfyAssetGate(comfy, { awaitConsent: async () => DECLINE });

    await expect(gate(NEED)).rejects.toBeInstanceOf(GenAssetDeclinedError);
    expect(comfy.runs).toBe(0);
  });
});
