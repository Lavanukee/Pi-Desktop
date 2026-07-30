/**
 * Every tool's definition, captured as it is registered — including its
 * `execute`, which pi does not otherwise hand out.
 *
 * WHY THIS EXISTS. jedd's design for capabilities: the advertised tool list never
 * changes (so the prompt prefix is never invalidated and no turn pays a
 * re-prefill), and a capability simply TELLS the model, in a tool result, which
 * tools it may now use. Two live probes against the running server settled how
 * that has to work:
 *
 *   · a tool described only in a result CANNOT be called — llama-server's
 *     tool-call grammar pins the function name to the advertised list;
 *   · a stable advertised DISPATCHER can carry it. Told about `mac_snapshot` in
 *     prose, the model emitted `use({tool:"mac_snapshot",args:{app:"Safari"}})`
 *     correctly, first try.
 *
 * The one missing piece was execution: `getAllTools()` returns name, description
 * and parameters but no `execute`, and a `tool_call` handler may block a call but
 * not rewrite its name. So `use` had nothing to dispatch through.
 *
 * It does now. The harness loads BEFORE web-tools, browser-use, mac-connectors
 * and mac-computer-use (see the desktop app's extension order), so wrapping
 * `pi.registerTool` here sees every one of their definitions as it lands. The
 * wrapper is transparent: it records the definition and passes it straight on.
 */

/** The shape we need from a tool definition — kept structural, no SDK import. */
export interface CapturedTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
  readonly execute: (id: unknown, params: unknown, ...rest: unknown[]) => Promise<unknown>;
}

/** Anything with a `registerTool` — i.e. pi's ExtensionAPI, structurally. Typed
 * loosely on purpose: we only ever read `.name`/`.execute` off what goes past. */
// biome-ignore lint/suspicious/noExplicitAny: mirrors pi's own registerTool signature
type RegistrarLike = { registerTool: (def: any) => any };

export interface ToolRegistry {
  /** Look one up by the name the model used. */
  get(name: string): CapturedTool | undefined;
  /** Every captured name — for diagnostics and tests. */
  names(): string[];
}

function isCaptured(def: unknown): def is CapturedTool {
  if (def === null || typeof def !== 'object') return false;
  const d = def as { name?: unknown; execute?: unknown };
  return typeof d.name === 'string' && d.name.length > 0 && typeof d.execute === 'function';
}

/**
 * Wrap `pi.registerTool` so every tool registered from here on is remembered.
 *
 * Returns the registry. Mutates `pi` deliberately — the point is to sit in the
 * path every later extension already uses, rather than asking them to opt in.
 */
export function captureRegisteredTools(pi: RegistrarLike): ToolRegistry {
  const tools = new Map<string, CapturedTool>();
  const original = pi.registerTool.bind(pi);
  pi.registerTool = (def: unknown) => {
    // Record first, so a throw from the real registrar cannot leave us with a
    // tool the model can be told about but we cannot run.
    if (isCaptured(def)) tools.set(def.name, def);
    return original(def);
  };
  return {
    get: (name) => tools.get(name),
    names: () => [...tools.keys()],
  };
}
