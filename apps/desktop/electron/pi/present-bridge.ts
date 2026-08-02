/**
 * The app side of `present`: show the artefact to the user, and hand the model
 * back a picture of what they will see.
 *
 * jedd: "presents a file to the user, shows a card and the file open or running
 * in canvas, if it's a godot game or whatever, that should show up as well in the
 * canvas as well, able to work. this also will show the model an immediate
 * preview of the file/game/project via returning an image or output whatever
 * applicable, it will essentially force a review and iteration if at this last
 * minute it sees, something is wrong."
 *
 * The forcing function is the return value, not the card. A model that cannot
 * finish without receiving its own artefact back has no way to hand over an empty
 * file, a blank render or a project that does not open — it sees them, in
 * context, with a turn still available.
 *
 * Transport mirrors the sibling bridges (subagent-bridge.ts, gen3d-bridge.ts):
 * a token-authed unix socket, one JSON line per request.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '@pi-desktop/shared';
import type { WebContents } from 'electron';

const log = createLogger('desktop:present');
const run = promisify(execFile);

/** Head of a text preview — enough to judge, small enough not to flood context. */
const TEXT_HEAD_CHARS = 2_000;
/** A script that hangs must not hang the turn. */
const RUN_TIMEOUT_MS = 20_000;

let server: net.Server | null = null;
let socketPath = '';
let token = '';
let getWindow: (() => WebContents | null) | null = null;
let renderPage: ((filePath: string) => Promise<string | null>) | null = null;

interface Request {
  id: number;
  token: string;
  method: string;
  params?: { path?: string; note?: string; kind?: string };
}

/**
 * Entry point → the command that OPENS it, and what to say when that command is
 * missing.
 *
 * jedd, on a presented Godot project: "I can't as the user go and see the run
 * even primitively following its instructions going to the folder and the file
 * and pressing f5, won't do anything. it hasn't installed godot or looked for an
 * installation or run any visual tests."
 *
 * A project the user cannot open is not finished, and "the files exist" is not
 * evidence that they can. So presenting a folder now REPORTS whether the thing
 * that runs it is actually on this machine. `null` means the entry point needs
 * nothing installed (a browser opens an HTML file).
 */
const ENTRY_POINTS: ReadonlyArray<{ file: string; runtime: string | null; what: string }> = [
  { file: 'project.godot', runtime: 'godot', what: 'Godot' },
  { file: 'index.html', runtime: null, what: 'a browser' },
  { file: 'package.json', runtime: 'node', what: 'Node' },
  { file: 'Cargo.toml', runtime: 'cargo', what: 'Rust/Cargo' },
  { file: 'main.py', runtime: 'python3', what: 'Python' },
  { file: 'README.md', runtime: null, what: 'nothing (it is a document)' },
];

/** Is `cmd` on PATH? Cheap, and the answer decides whether a project is openable. */
async function hasRuntime(cmd: string): Promise<boolean> {
  try {
    await run('sh', ['-lc', `command -v ${cmd}`], { timeout: 4_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Describe a folder the way somebody deciding "does this work?" would want:
 * what is in it, and the file that makes it a project rather than a pile.
 */
export async function describeProject(
  dir: string,
  probe: (cmd: string) => Promise<boolean> = hasRuntime,
): Promise<string> {
  const names = await readdir(dir);
  const entry = ENTRY_POINTS.find((e) => names.includes(e.file));
  const listed = names.slice(0, 40).sort();
  const more = names.length > listed.length ? ` (+${names.length - listed.length} more)` : '';
  const head = [`${dir} contains ${names.length} entries${more}:`, listed.join(', ')];
  if (entry === undefined) {
    head.push(
      'No recognisable entry point (no project.godot / index.html / package.json / main.py). ' +
        'A folder of files is not yet a project a user can open.',
    );
    return head.join('\n');
  }
  head.push(`Entry point: ${entry.file} — opened with ${entry.what}.`);
  if (entry.runtime !== null && !(await probe(entry.runtime))) {
    head.push(
      `BUT ${entry.what} IS NOT INSTALLED on this machine (\`${entry.runtime}\` is not on PATH), ` +
        'so the user cannot open this and neither can you. You have not verified that any of it ' +
        'works. Either install it, or say plainly in your reply that the project is written but ' +
        'unopenable here and what they need — do NOT describe it as finished and working.',
    );
  }
  return head.join('\n');
}

/** Produce the preview for one artefact. Pure-ish; the renderer is injected. */
export async function buildPreview(
  target: string,
  kind: string,
  deps: {
    renderPage?: ((p: string) => Promise<string | null>) | null;
  } = {},
): Promise<{ imageBase64?: string; mimeType?: string; text?: string; error?: string }> {
  try {
    switch (kind) {
      case 'image': {
        const buf = await readFile(target);
        const ext = path.extname(target).toLowerCase();
        const mime =
          ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.svg'
              ? 'image/svg+xml'
              : 'image/png';
        // An SVG is text to a vision model; send it as source instead.
        if (ext === '.svg') return { text: buf.toString('utf8').slice(0, TEXT_HEAD_CHARS) };
        return { imageBase64: buf.toString('base64'), mimeType: mime };
      }
      case 'render': {
        const shot = await deps.renderPage?.(target);
        if (shot === null || shot === undefined) {
          return { error: 'the page could not be rendered here' };
        }
        return { imageBase64: shot, mimeType: 'image/png' };
      }
      case 'run': {
        const ext = path.extname(target).toLowerCase();
        const cmd =
          ext === '.py' ? 'python3' : ext === '.sh' ? 'bash' : ext === '.ts' ? 'npx' : 'node';
        const args = ext === '.ts' ? ['tsx', target] : [target];
        const { stdout, stderr } = await run(cmd, args, { timeout: RUN_TIMEOUT_MS });
        const out = `${stdout}${stderr}`.trim();
        return {
          text:
            out.length > 0
              ? `Running it printed:\n${out.slice(0, TEXT_HEAD_CHARS)}`
              : 'Running it printed nothing at all.',
        };
      }
      case 'project':
        return { text: await describeProject(target) };
      case 'text': {
        const body = await readFile(target, 'utf8');
        return {
          text:
            body.trim().length === 0
              ? 'The file is EMPTY.'
              : `It contains:\n${body.slice(0, TEXT_HEAD_CHARS)}`,
        };
      }
      default: {
        const st = await stat(target);
        return { text: `${target} — ${st.size} bytes. Nothing here can open this format.` };
      }
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function handle(req: Request): Promise<Record<string, unknown>> {
  const target = typeof req.params?.path === 'string' ? req.params.path : '';
  if (target === '') return { error: 'no path' };

  if (req.method === 'show') {
    const wc = getWindow?.() ?? null;
    if (wc === null || wc.isDestroyed()) return { ok: false, error: 'no Bobble window' };
    // The renderer opens it in the canvas and renders the card.
    wc.send('present:show', { path: target, note: req.params?.note });
    log.info('presented', { path: target });
    return { ok: true };
  }
  if (req.method === 'preview') {
    return await buildPreview(target, req.params?.kind ?? 'describe', { renderPage });
  }
  return { error: `unknown method: ${req.method}` };
}

function onConnection(socket: net.Socket): void {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    const nl = buffer.indexOf('\n');
    if (nl === -1) return;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      socket.write(`${JSON.stringify({ error: 'bad request' })}\n`);
      return;
    }
    if (req.token !== token) {
      socket.write(`${JSON.stringify({ error: 'unauthorized' })}\n`);
      return;
    }
    void handle(req)
      .then((res) => socket.write(`${JSON.stringify(res)}\n`))
      .catch((err) =>
        socket.write(
          `${JSON.stringify({ error: String(err instanceof Error ? err.message : err) })}\n`,
        ),
      );
  });
  socket.on('error', () => socket.destroy());
}

/** Start the bridge. `render` captures an HTML file and returns base64 PNG. */
export function registerPresentBridge(deps: {
  getWindow: () => WebContents | null;
  renderPage?: (filePath: string) => Promise<string | null>;
}): void {
  getWindow = deps.getWindow;
  renderPage = deps.renderPage ?? null;
  token = randomBytes(16).toString('hex');
  socketPath = path.join(
    tmpdir(),
    `pi-present-${process.pid}-${randomBytes(4).toString('hex')}.sock`,
  );
  server = net.createServer(onConnection);
  // Published on the MAIN process env so every pi child inherits it through
  // buildPiEnv — same mechanism as the subagent and gen3d bridges, and it must
  // happen BEFORE the first spawn or the harness sees no bridge.
  process.env.PI_DESKTOP_PRESENT_SOCK = socketPath;
  process.env.PI_DESKTOP_PRESENT_TOKEN = token;
  server.listen(socketPath, () => log.info('present bridge live', { socketPath }));
}

export function disposePresentBridge(): void {
  server?.close();
  server = null;
}

/** Env published to every pi child so `present` can find the bridge. */
export function presentBridgeEnv(): { sock?: string; token?: string } {
  if (server === null) return {};
  return { sock: socketPath, token };
}
