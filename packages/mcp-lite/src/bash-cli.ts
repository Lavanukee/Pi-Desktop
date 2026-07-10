/**
 * bash-CLI connector mode — the third way to surface MCP connectors to the
 * model, alongside lite (proxy tools) and native (per-tool registration).
 *
 * Instead of a structured tool call, the model reaches connectors through the
 * REAL `bash` tool by running a generated `pi-tool` dispatcher that lives on an
 * injected PATH dir. `pi-tool` is a POSIX shim that re-execs the Electron binary
 * as Node against a tiny `dispatcher.js`, which forwards its argv over a
 * token-gated Unix-domain socket to THIS extension (hosted in the pi child). The
 * socket server parses the argv, routes `list`/`help`/`call` to the shared
 * {@link ConnectorHost}, and returns text — so `--help` is generated live from
 * each tool's `inputSchema` and can never drift.
 *
 * Why: a small local model makes fewer errors emitting `pi-tool gmail search
 * --query foo` in a bash block than composing a nested JSON tool call. The bridge
 * grants NO new capability (the model already has unrestricted bash + could
 * mcp_call); the socket is 0700-dir + token-gated and torn down on shutdown.
 *
 * The pure pieces ({@link parseDispatcherArgs}, {@link coerceArgs},
 * {@link renderHelp}, {@link buildDispatcherSource}, {@link buildPiToolWrapper})
 * are exported and unit-tested without a socket; {@link registerBashCliTools}
 * wires the live bridge and returns a disposer.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { type Static, Type } from '@sinclair/typebox';
import { renderCatalogText } from './catalog';
import type { ConnectorHost } from './connector-host';
import type { JsonSchema } from './mcp-types';
import { type McpToolResultDetails, runMcpCall } from './pi-tools';
import type { PiContentItem } from './schema';

/** Env var carrying the bridge socket path (inherited by the pi-tool shim). */
export const PI_MCP_CLI_SOCK_ENV = 'PI_MCP_CLI_SOCK';
/** Env var carrying the shared secret every dispatcher request must echo. */
export const PI_MCP_CLI_TOKEN_ENV = 'PI_MCP_CLI_TOKEN';

/** Per-request budget the dispatcher waits for the bridge before giving up. */
const REQUEST_TIMEOUT_MS = 30_000;

/** One-line usage banner, shared by the shim and the `cli` fallback tool. */
export const PI_TOOL_USAGE = [
  'Usage:',
  '  pi-tool list [<server>]                 list connectors and their tools',
  '  pi-tool <server> <tool> --help          show a tool’s arguments',
  '  pi-tool <server> <tool> [--key value …] call a tool',
].join('\n');

// ── argv parsing (pure) ──────────────────────────────────────────────────────

/** A parsed `pi-tool` invocation. */
export type DispatcherCommand =
  | { op: 'usage' }
  | { op: 'list'; server?: string }
  | { op: 'help'; server: string; tool: string }
  | { op: 'call'; server: string; tool: string; rawArgs: Record<string, string | boolean> }
  | { op: 'error'; message: string };

/** Parse `--key value`, `--key=value`, and bare `--flag` tokens into a record. */
function parseFlags(tokens: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === undefined || !tok.startsWith('--')) continue;
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[body] = next;
      i++;
    } else {
      out[body] = true;
    }
  }
  return out;
}

/**
 * Parse a `pi-tool` argv (the tokens after the program name) into a command.
 * Never throws — malformed input yields `{op:'error'}` with a helpful message.
 */
export function parseDispatcherArgs(argv: readonly string[]): DispatcherCommand {
  const args = argv.filter((a) => a.length > 0);
  if (args.length === 0) return { op: 'usage' };
  const first = args[0];
  if (first === '--help' || first === '-h' || first === 'help') return { op: 'usage' };
  if (first === 'list') {
    const second = args[1];
    const server = second !== undefined && !second.startsWith('-') ? second : undefined;
    return server === undefined ? { op: 'list' } : { op: 'list', server };
  }
  const server = first as string;
  const tool = args[1];
  if (tool === undefined || tool.startsWith('-')) {
    return {
      op: 'error',
      message: `pi-tool: expected "pi-tool ${server} <tool> [--key value]". Run "pi-tool list" to see tools.`,
    };
  }
  const rest = args.slice(2);
  if (rest.includes('--help') || rest.includes('-h')) return { op: 'help', server, tool };
  return { op: 'call', server, tool, rawArgs: parseFlags(rest) };
}

/**
 * Coerce string/boolean flag values to the JS types the tool schema expects
 * (number/integer→Number, boolean→bool, array/object→JSON.parse, else string).
 * Unknown keys pass through as strings so a server can still receive them.
 */
export function coerceArgs(
  rawArgs: Record<string, string | boolean>,
  schema: JsonSchema | undefined,
): Record<string, unknown> {
  const props = (schema?.properties ?? {}) as Record<string, { type?: string } | undefined>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawArgs)) {
    if (typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    const type = props[key]?.type;
    if (type === 'number' || type === 'integer') {
      const n = Number(value);
      out[key] = Number.isNaN(n) ? value : n;
    } else if (type === 'boolean') {
      out[key] = value === 'true' || value === '1';
    } else if (type === 'array' || type === 'object') {
      try {
        out[key] = JSON.parse(value);
      } catch {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ── --help rendering (pure) ──────────────────────────────────────────────────

/** Render a tool's argument help from its MCP `inputSchema` (never drifts). */
export function renderHelp(
  server: string,
  tool: string,
  def: { description?: string; inputSchema?: JsonSchema } | undefined,
): string {
  if (def === undefined) {
    return `pi-tool: unknown tool "${tool}" on "${server}". Run "pi-tool list".`;
  }
  const lines: string[] = [`Usage: pi-tool ${server} ${tool} [--key value …]`, ''];
  if (def.description) lines.push(def.description, '');
  const schema = def.inputSchema;
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const keys = Object.keys(props);
  if (keys.length === 0) {
    lines.push('Arguments: none.');
    return lines.join('\n');
  }
  lines.push('Arguments:');
  for (const key of keys) {
    const p = props[key] ?? {};
    const type = typeof p.type === 'string' ? p.type : 'string';
    const req = required.has(key) ? ' (required)' : '';
    const desc = typeof p.description === 'string' ? ` — ${p.description}` : '';
    lines.push(`  --${key} <${type}>${req}${desc}`);
  }
  return lines.join('\n');
}

// ── in-process routing ───────────────────────────────────────────────────────

/** Flatten pi tool-result content blocks to the plain text the shim prints. */
function contentToText(content: PiContentItem[]): string {
  return content
    .map((c) =>
      c.type === 'text' ? c.text : `[${c.type}${'mimeType' in c ? ` ${c.mimeType}` : ''}]`,
    )
    .join('\n');
}

/** A bridge response: the text to print + whether it was an error. */
export interface DispatchResult {
  text: string;
  isError: boolean;
}

/**
 * Route a parsed command against the host — the single place list/help/call are
 * resolved, shared by the socket bridge and the `cli` fallback tool.
 */
export async function dispatchCommand(
  host: ConnectorHost,
  cmd: DispatcherCommand,
): Promise<DispatchResult> {
  switch (cmd.op) {
    case 'usage':
      return { text: PI_TOOL_USAGE, isError: false };
    case 'error':
      return { text: cmd.message, isError: true };
    case 'list':
      return { text: renderCatalogText(host.getCatalog(), cmd.server), isError: false };
    case 'help': {
      const def = host.getTool(cmd.server, cmd.tool);
      return { text: renderHelp(cmd.server, cmd.tool, def), isError: def === undefined };
    }
    case 'call': {
      const def = host.getTool(cmd.server, cmd.tool);
      const args = coerceArgs(cmd.rawArgs, def?.inputSchema);
      const res = await runMcpCall(host, cmd.server, cmd.tool, args);
      const details = res.details as McpToolResultDetails | undefined;
      return {
        text: contentToText(res.content as PiContentItem[]),
        isError: details?.isError === true,
      };
    }
  }
}

// ── generated shim + dispatcher sources (pure) ───────────────────────────────

/** The POSIX `pi-tool` wrapper: re-exec Electron as Node against dispatcher.js. */
export function buildPiToolWrapper(execPath: string, dispatcherPath: string): string {
  return `#!/bin/sh\n# Generated by @pi-desktop/mcp-lite (bash-cli mode). Do not edit.\nELECTRON_RUN_AS_NODE=1 exec "${execPath}" "${dispatcherPath}" "$@"\n`;
}

/**
 * The dispatcher.js source: a thin, dependency-free transport. It forwards argv
 * over the socket and prints the bridge's reply — ALL parsing/routing lives
 * in-process (server-side) so it stays test-covered and never drifts.
 */
export function buildDispatcherSource(): string {
  return `'use strict';
// Generated by @pi-desktop/mcp-lite (bash-cli mode). Do not edit.
const net = require('node:net');
const sock = process.env['${PI_MCP_CLI_SOCK_ENV}'];
const token = process.env['${PI_MCP_CLI_TOKEN_ENV}'];
if (!sock || !token) {
  process.stderr.write('pi-tool: connector bridge unavailable (${PI_MCP_CLI_SOCK_ENV} unset)\\n');
  process.exit(2);
}
const argv = process.argv.slice(2);
let buffer = '';
let done = false;
const socket = net.connect(sock);
socket.setEncoding('utf8');
const timer = setTimeout(function () {
  if (!done) { process.stderr.write('pi-tool: bridge timed out\\n'); process.exit(1); }
}, ${REQUEST_TIMEOUT_MS});
if (timer.unref) timer.unref();
socket.on('connect', function () {
  socket.write(JSON.stringify({ id: 1, token: token, argv: argv }) + '\\n');
});
socket.on('data', function (chunk) {
  buffer += chunk;
  const nl = buffer.indexOf('\\n');
  if (nl === -1) return;
  done = true;
  clearTimeout(timer);
  const line = buffer.slice(0, nl);
  socket.end();
  let msg;
  try { msg = JSON.parse(line); } catch (e) {
    process.stderr.write('pi-tool: malformed bridge response\\n');
    process.exit(1);
  }
  if (msg.ok === false) {
    process.stderr.write(String(msg.error || 'pi-tool: bridge error') + '\\n');
    process.exit(1);
  }
  const text = String(msg.text == null ? '' : msg.text);
  const out = text.endsWith('\\n') ? text : text + '\\n';
  if (msg.isError) { process.stderr.write(out); process.exit(1); }
  process.stdout.write(out);
  process.exit(0);
});
socket.on('error', function (e) {
  if (!done) {
    process.stderr.write('pi-tool: ' + ((e && e.message) || String(e)) + '\\n');
    process.exit(1);
  }
});
`;
}

// ── the `cli` fallback tool (no socket / PATH / subprocess) ──────────────────

const cliToolSchema = Type.Object({
  argv: Type.Array(Type.String(), {
    description:
      'The pi-tool argv, e.g. ["list"] or ["github","search_issues","--query","bug"]. ' +
      'Run ["list"] first, then ["<server>","<tool>","--help"] for a tool’s arguments.',
  }),
});

/**
 * Register the de-risked `cli` pi-tool: it runs the SAME parse+route logic in
 * process (no socket, no PATH, no subprocess), so bash-cli connectors are usable
 * even where PATH shims are undesirable. A structured tool call, so it does not
 * itself test the "bash reduces small-model errors" hypothesis — it complements
 * the real `pi-tool` dispatcher.
 */
export function registerCliTool(pi: ExtensionAPI, host: ConnectorHost): void {
  pi.registerTool({
    name: 'cli',
    label: 'Connector CLI',
    description:
      'Run a connector command line: list connectors/tools, read a tool’s --help, or call it. ' +
      'Mirrors the `pi-tool` shell command available in bash.',
    parameters: cliToolSchema,
    execute: async (_id, params: Static<typeof cliToolSchema>) => {
      const argv = Array.isArray(params?.argv) ? params.argv.map(String) : [];
      const result = await dispatchCommand(host, parseDispatcherArgs(argv));
      return {
        content: [{ type: 'text', text: result.text }],
        details: { isError: result.isError } as McpToolResultDetails,
      };
    },
  });
}

// ── live socket bridge + shim install ────────────────────────────────────────

/** Options for {@link registerBashCliTools}; all defaulted for production use. */
export interface BashCliOptions {
  /** Unix socket path. Default: a random path under os.tmpdir(). */
  socketPath?: string;
  /** Shared secret. Default: a fresh 24-byte hex token. */
  token?: string;
  /** Shim dir holding pi-tool + dispatcher.js. Default: random under tmpdir. */
  shimDir?: string;
  /** The Electron/Node binary the shim re-execs. Default: process.execPath. */
  execPath?: string;
  /** Env object to inject PATH + socket/token into. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Also register the in-process `cli` fallback tool. Default: true. */
  registerCliFallback?: boolean;
  /** Optional stderr sink for bridge server errors. */
  onLog?: (line: string) => void;
}

/** Live bash-cli bridge handle; call {@link BashCliHandle.dispose} on shutdown. */
export interface BashCliHandle {
  readonly socketPath: string;
  readonly token: string;
  readonly shimDir: string;
  /** Absolute path of the generated `pi-tool` shim (for PATH / tests). */
  readonly piToolPath: string;
  /** Close the socket, remove the shim dir, and restore PATH + env. */
  dispose(): void;
}

function randomSuffix(): string {
  return `${process.pid}-${randomBytes(4).toString('hex')}`;
}

/**
 * Stand up the bash-cli bridge: write the `pi-tool` shim + dispatcher, start the
 * token-gated socket server, inject the shim dir onto `env.PATH`, publish the
 * socket/token env, and (by default) register the `cli` fallback tool. Returns a
 * handle whose `dispose()` restores everything (call it from session_shutdown).
 */
export function registerBashCliTools(
  pi: ExtensionAPI,
  host: ConnectorHost,
  opts: BashCliOptions = {},
): BashCliHandle {
  const suffix = randomSuffix();
  const shimDir = opts.shimDir ?? path.join(os.tmpdir(), `pi-mcpcli-${suffix}`);
  const socketPath = opts.socketPath ?? path.join(os.tmpdir(), `pi-mcpcli-${suffix}.sock`);
  const token = opts.token ?? randomBytes(24).toString('hex');
  const execPath = opts.execPath ?? process.execPath;
  const env = opts.env ?? process.env;
  const onLog = opts.onLog ?? (() => {});

  // 1) Write the shim dir (0700) with pi-tool (0755) + dispatcher.js.
  const dispatcherPath = path.join(shimDir, 'dispatcher.js');
  const piToolPath = path.join(shimDir, 'pi-tool');
  fs.mkdirSync(shimDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(dispatcherPath, buildDispatcherSource(), 'utf8');
  fs.writeFileSync(piToolPath, buildPiToolWrapper(execPath, dispatcherPath), { mode: 0o755 });

  // 2) Start the token-gated socket server.
  try {
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  } catch {
    // stale socket; listen() will surface a real problem.
  }
  const server = net.createServer((socket) => handleConnection(socket, host, token));
  server.on('error', (e) => onLog(`bash-cli bridge error: ${String(e)}`));
  server.listen(socketPath);

  // 3) Inject PATH + publish the socket/token for the pi child's bash calls.
  const prevPath = env.PATH;
  env.PATH = prevPath ? `${shimDir}${path.delimiter}${prevPath}` : shimDir;
  env[PI_MCP_CLI_SOCK_ENV] = socketPath;
  env[PI_MCP_CLI_TOKEN_ENV] = token;

  // 4) Ship the de-risked `cli` fallback tool alongside the real shim.
  if (opts.registerCliFallback !== false) registerCliTool(pi, host);

  let disposed = false;
  return {
    socketPath,
    token,
    shimDir,
    piToolPath,
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        server.close();
      } catch {
        // best-effort
      }
      try {
        if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
      } catch {
        // best-effort
      }
      try {
        fs.rmSync(shimDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      if (prevPath === undefined) delete env.PATH;
      else env.PATH = prevPath;
      delete env[PI_MCP_CLI_SOCK_ENV];
      delete env[PI_MCP_CLI_TOKEN_ENV];
    },
  };
}

interface DispatcherRequest {
  id?: number;
  token?: string;
  argv?: unknown;
}

function handleConnection(socket: net.Socket, host: ConnectorHost, token: string): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {
    /* a peer reset must never crash the pi child */
  });
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() !== '') void handleLine(socket, line, host, token);
      nl = buffer.indexOf('\n');
    }
  });
}

async function handleLine(
  socket: net.Socket,
  line: string,
  host: ConnectorHost,
  token: string,
): Promise<void> {
  let req: DispatcherRequest;
  try {
    req = JSON.parse(line) as DispatcherRequest;
  } catch {
    return;
  }
  const id = typeof req.id === 'number' ? req.id : 0;
  const write = (payload: Record<string, unknown>): void => {
    try {
      socket.write(`${JSON.stringify({ id, ...payload })}\n`);
    } catch {
      /* peer gone */
    }
  };
  if (req.token !== token) {
    write({ ok: false, error: 'unauthorized' });
    return;
  }
  const argv = Array.isArray(req.argv) ? req.argv.map(String) : [];
  try {
    const result = await dispatchCommand(host, parseDispatcherArgs(argv));
    write({ ok: true, text: result.text, isError: result.isError });
  } catch (e) {
    write({ ok: true, text: e instanceof Error ? e.message : String(e), isError: true });
  }
}
