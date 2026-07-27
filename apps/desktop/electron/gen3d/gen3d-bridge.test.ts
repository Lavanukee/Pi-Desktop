/**
 * The gen3d bridge over a REAL unix socket, driven by the harness's real client
 * — so the two halves of the wire contract (env keys, token, method names,
 * param names, reply shape) are pinned against each other rather than each side
 * being tested against its own assumptions.
 */
import { imageBridgeFromEnv } from '@pi-desktop/harness';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  disposeGen3dBridge,
  gen3dBridgeEnv,
  handleMethod,
  type RunImageJob,
  registerGen3dBridge,
} from './gen3d-bridge';

const SOCK_ENV = 'PI_DESKTOP_GEN3D_SOCK';
const TOKEN_ENV = 'PI_DESKTOP_GEN3D_TOKEN';

function startBridge(run: RunImageJob) {
  delete process.env[SOCK_ENV];
  delete process.env[TOKEN_ENV];
  registerGen3dBridge(run);
  const { sock, token } = gen3dBridgeEnv();
  return { sock: sock ?? '', token: token ?? '' };
}

/** The harness's real client, pointed at a socket/token pair. */
function clientFor(sock: string, token: string) {
  const client = imageBridgeFromEnv({ [SOCK_ENV]: sock, [TOKEN_ENV]: token });
  if (client === null) throw new Error('expected a bridge client for this env');
  return client;
}

afterEach(() => {
  disposeGen3dBridge();
  delete process.env[SOCK_ENV];
  delete process.env[TOKEN_ENV];
});

describe('registerGen3dBridge', () => {
  it('publishes a socket path + token on the env for the pi child to read', () => {
    const { sock, token } = startBridge(async () => ({ ok: true, path: '/a.png' }));
    expect(sock).not.toBe('');
    expect(token.length).toBeGreaterThan(16);
  });
});

describe('bridge ↔ harness client (real socket)', () => {
  it('carries a generate_image request through and returns the path', async () => {
    const run = vi.fn<RunImageJob>(async () => ({ ok: true, path: '/out/prompt-image.png' }));
    const { sock, token } = startBridge(run);

    const res = await clientFor(sock, token).generateImage('a red bicycle');

    expect(run).toHaveBeenCalledWith({ prompt: 'a red bicycle' });
    expect(res).toEqual({ ok: true, path: '/out/prompt-image.png' });
  });

  it('carries an edit_image request through, mapping imagePath → editFrom', async () => {
    const run = vi.fn<RunImageJob>(async () => ({ ok: true, path: '/out/edited-image.png' }));
    const { sock, token } = startBridge(run);

    const res = await clientFor(sock, token).editImage('/tmp/src.png', 'make the jacket red');

    expect(run).toHaveBeenCalledWith({
      prompt: 'make the jacket red',
      editFrom: '/tmp/src.png',
    });
    expect(res).toEqual({ ok: true, path: '/out/edited-image.png' });
  });

  it('passes an engine refusal back as a clean reason, not a hang', async () => {
    const { sock, token } = startBridge(async () => ({
      ok: false,
      error: 'Mage-Flow-Edit-Turbo is not downloaded yet. Open Bobble 3D → Image…',
    }));
    const res = await clientFor(sock, token).editImage('/tmp/src.png', 'x');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('not downloaded yet');
  });

  it('rejects a wrong token', async () => {
    const run = vi.fn<RunImageJob>(async () => ({ ok: true, path: '/a.png' }));
    const { sock } = startBridge(run);
    const res = await clientFor(sock, 'not-the-token').generateImage('x');
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
    expect(run).not.toHaveBeenCalled();
  });

  it('never hangs when the socket does not exist', async () => {
    const res = await clientFor('/tmp/definitely-not-a-socket-xyz.sock', 't').generateImage('x');
    expect(res.ok).toBe(false);
  });

  it('has NO client at all outside Pi Desktop (no bridge env → no tools)', () => {
    expect(imageBridgeFromEnv({})).toBeNull();
  });
});

describe('handleMethod', () => {
  it('refuses an unknown method', async () => {
    const res = await handleMethod('delete_everything', {}, async () => ({
      ok: true,
      path: '/a.png',
    }));
    expect(res).toEqual({ ok: false, error: 'unknown method: delete_everything' });
  });

  it('requires image_path for an edit', async () => {
    const run = vi.fn<RunImageJob>(async () => ({ ok: true, path: '/a.png' }));
    const res = await handleMethod('edit_image', { instruction: 'x' }, run);
    expect(res).toEqual({ ok: false, error: 'image_path is required' });
    expect(run).not.toHaveBeenCalled();
  });

  it('reports no engine rather than throwing when nothing is wired', async () => {
    const res = await handleMethod('generate_image', { prompt: 'x' }, null);
    expect(res.ok).toBe(false);
  });
});
