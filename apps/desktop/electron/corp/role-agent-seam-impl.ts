/**
 * The APP's impl of the harness {@link RunRoleAgentFn} seam — it adapts the
 * ELECTRON-MAIN role-agent runtime ({@link ./role-agent}) to the pi-AGNOSTIC
 * interface the harness ({@link runCorp}) injects.
 *
 * The harness never imports the pi SDK; it declares the shape it needs
 * ({@link RoleAgentRunInput} → {@link RoleAgentRunOutput}) and this closure fills
 * it, building the in-process keyless `corp-local` provider ONCE (against the same
 * resolved baseUrl/model the chat seam uses) and running each role contract as a
 * scoped {@link runRoleAgent} AgentSession.
 *
 * It owns two engineer-specific mechanisms the harness can only describe neutrally:
 *  - ISOLATED WORKSPACE (spec §91): when `input.isolation` is set, seed a fresh
 *    temp dir with the engineer's read-only dependency files, run the agent there,
 *    then HARVEST what it wrote back into the shared product tree ({@link input.cwd}).
 *  - The §164 SUBMISSION INTERCEPTOR: the `submit_contract` custom tool's execute
 *    is STATEFUL — the first call returns the self-review prompt (the bounce), the
 *    second verifies the slot file exists and finalizes — and records whether the
 *    bounce fired and whether the file changed (the quality signal).
 *
 * ELECTRON-MAIN ONLY (Node): value-imports the pi SDK via `./role-agent`, which is
 * fine here (the renderer never imports this). It is electron-free, so it stays
 * unit-testable and loadable from the real-server validation script.
 */

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentToolResult,
  ExtensionFactory,
  ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import type {
  RoleAgentCustomTool,
  RoleAgentRunInput,
  RoleAgentRunOutput,
  RoleAgentSeedFile,
  RunRoleAgentFn,
} from '@pi-desktop/harness/corp';
import { createCorpModelProvider, runRoleAgent, type SamplingMode } from './role-agent';

/** The web-research tool names a role's allowlist may request (the CEO vision
 * turn). When any is present AND a {@link RunRoleAgentConfig.webResearchFactory} is
 * injected, that factory is installed for the run so the tools exist; the allowlist
 * still gates which of them the role may call. The names are kept local (not
 * imported from @pi-desktop/web-tools) so this module carries NO dependency on the
 * web-tools package — the APP injects the concrete registrar, keeping the seam impl
 * loadable everywhere (incl. the Node type-stripping e2e drivers). */
const WEB_TOOL_NAMES: ReadonlySet<string> = new Set(['web_search', 'web_fetch']);

// --- small fs helpers --------------------------------------------------------

/** UTF-8 byte length of a string (no node:Buffer dependency). */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Read a regular file's UTF-8 content, or undefined when it does not exist. */
function readIfExists(absPath: string): string | undefined {
  try {
    return statSync(absPath).isFile() ? readFileSync(absPath, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/** Normalize a slot to a safe workspace-relative path (drop leading `/` and `./`). */
function relClean(p: string): string {
  return p.replace(/^[/\\]+/, '').replace(/^(\.[/\\]+)+/, '');
}

/** Recursively list regular files under `root`, as `/`-separated paths relative to
 * `root`, skipping junk dirs a stray bash step might create. Never throws. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const SKIP = new Set(['node_modules', '.git', '.pi', 'dist', '.cache']);
  const readEntries = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const visit = (relDir: string): void => {
    for (const e of readEntries(path.join(root, relDir))) {
      const rel = relDir === '' ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) visit(rel);
      } else if (e.isFile()) {
        out.push(rel);
      }
    }
  };
  visit('');
  return out;
}

// --- isolated workspace (spec §91) -------------------------------------------

/** A live isolated engineer workspace: a fresh dir seeded with read-only deps,
 * plus a `harvest` that copies the engineer's OWN writes into the shared tree. */
export interface IsolatedWorkspace {
  /** The isolated dir the agent runs in (its cwd). */
  readonly dir: string;
  /**
   * Copy every file the engineer WROTE (the diff against the seeded deps) into
   * `sharedRoot` at its relative path — that is the merge (spec §8). Returns the
   * harvested files (relative path + byte size). Seeded dep files are read-only
   * context and are NEVER harvested back, so a stray edit to one can't clobber its
   * owner's work.
   */
  harvest(sharedRoot: string): { path: string; bytes: number }[];
  /** Remove the isolated dir (best-effort). */
  dispose(): void;
}

/**
 * Create a fresh ISOLATED engineer workspace (spec §91): a temp dir seeded with the
 * engineer's dependency files at their exact relative paths (read-only context), so
 * the engineer reads real code and has nothing else to wander. `harvest` diffs the
 * dir against the seed to find what the engineer produced. Pure fs; never throws
 * from the constructor path beyond a genuine mkdtemp failure.
 */
export function seedIsolatedWorkspace(seed: readonly RoleAgentSeedFile[]): IsolatedWorkspace {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'corp-engineer-iso-'));
  const seedPaths = new Set<string>();
  for (const f of seed) {
    const rel = relClean(f.path);
    if (rel === '') continue;
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, 'utf8');
    seedPaths.add(rel);
  }
  return {
    dir,
    harvest(sharedRoot: string): { path: string; bytes: number }[] {
      const harvested: { path: string; bytes: number }[] = [];
      for (const rel of walkFiles(dir)) {
        if (seedPaths.has(rel)) continue; // read-only dep — never harvest it back
        const dst = path.join(sharedRoot, rel);
        mkdirSync(path.dirname(dst), { recursive: true });
        copyFileSync(path.join(dir, rel), dst);
        let bytes = 0;
        try {
          bytes = statSync(dst).size;
        } catch {
          // best-effort size
        }
        harvested.push({ path: rel, bytes });
      }
      return harvested;
    },
    dispose(): void {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    },
  };
}

// --- the §164 submission interceptor (spec §7) -------------------------------

/** The §164 quality signal captured across one engineer's submit calls. */
export interface SubmitReviewCapture {
  /** The self-review bounce fired (the engineer called submit at least once). */
  bounced: boolean;
  /** The engineer finalized (a second submit that found its slot file). */
  finalized: boolean;
  /** The slot file CHANGED between the draft (first submit) and the final. */
  changed: boolean;
  /** UTF-8 byte length of the draft (at first submit). */
  draftBytes: number;
  /** UTF-8 byte length of the final (at finalize). */
  finalBytes: number;
}

/** A fresh, empty {@link SubmitReviewCapture}. */
export function newSubmitReviewCapture(): SubmitReviewCapture {
  return { bounced: false, finalized: false, changed: false, draftBytes: 0, finalBytes: 0 };
}

/**
 * The §164 submission interceptor as a STATEFUL step over the engineer's submit
 * calls within ONE agent run (spec §7):
 *  - FIRST call → BOUNCE: snapshot the draft, return the model-free self-review
 *    prompt, and do NOT finalize — the agent keeps working and improves.
 *  - SECOND (or later) call → FINALIZE: verify the slot file exists (THROW the
 *    actionable error when it does not, so the pi loop feeds it back and the model
 *    writes then re-submits), record the final + whether it CHANGED from the draft,
 *    and ack.
 * `readSlot` reads the slot content from the run's cwd (undefined = missing), so the
 * gate is pure and unit-testable without touching disk. Returns the tool-result
 * text; throws only the missing-slot finalize error.
 */
export function createSubmitReviewGate(args: {
  readonly slot: string;
  readonly reviewPrompt: string;
  readonly readSlot: () => string | undefined;
  readonly capture?: SubmitReviewCapture;
}): () => string {
  let calls = 0;
  let draft = '';
  return (): string => {
    calls += 1;
    if (calls === 1) {
      draft = args.readSlot() ?? '';
      if (args.capture !== undefined) {
        args.capture.bounced = true;
        args.capture.draftBytes = byteLength(draft);
      }
      return args.reviewPrompt;
    }
    const final = args.readSlot();
    if (final === undefined) {
      throw new Error(
        `Your slot file ${args.slot} does not exist yet — write it before submitting.`,
      );
    }
    if (args.capture !== undefined) {
      args.capture.finalized = true;
      args.capture.finalBytes = byteLength(final);
      args.capture.changed = draft !== final;
    }
    return `Slot file ${args.slot} submitted and finalized — you are done. Stop here; do not call any further tools.`;
  };
}

/** How a consult tool spawns a clean-context advisor + charges the run budget. The
 * impl runs the advisor read-only with NO consult tools (advice-only, depth cap 1). */
export interface ConsultRunner {
  /** Spawn a peer/specialist advisor and return its prose advice. */
  readonly spawnAdvisor: (req: {
    readonly kind: 'peer' | 'specialist';
    readonly systemPrompt: string;
    readonly context: string;
    readonly question: string;
    readonly samplingMode: SamplingMode;
  }) => Promise<string>;
  /** Charge one consult turn against the global RunBudget; `false` → decline. */
  readonly onConsult?: () => boolean;
}

/** One line of concrete advice to fall back to when a consult cannot run. */
const CONSULT_DECLINED =
  'The advice budget is spent — proceed with your best judgment, or reply "unfulfillable, because <reason>".';

/** The engineer's explicit terminal "give up" declaration (bump-to-continue stops
 * on it rather than spending another bump). */
const UNFULFILLABLE_RE = /unfulfillable[,:]?\s+because/i;

/**
 * The BUMP-TO-CONTINUE decision (spec "Run safety & budgets" — the completeness
 * backstop), pure + testable. Given the terminal state of a role-agent run, return
 * the continue prompt to RE-PROMPT the same session, or `undefined` to STOP.
 *
 * It STOPS when the deliverable is present:
 *  - ENGINEER: the submit finalized OR the slot file exists;
 *  - a TERMINAL custom tool was called (the CEO vision turn's `submit_vision`);
 *  - `textIsDeliverable` (a role whose OUTPUT is its assistant text, e.g. vision)
 *    AND the final text is non-empty;
 *  - the engineer declared the contract "unfulfillable, because …".
 * Otherwise (a premature stop — quit with no deliverable) it returns the continue
 * prompt. The extra fields default off, so the engineer's behaviour is unchanged.
 */
export function bumpDecision(args: {
  readonly finalized: boolean;
  readonly slotExists: boolean;
  readonly finalText: string;
  readonly continuePrompt: string;
  /** A `terminal` custom tool was called (submit_vision) — the turn is finished. */
  readonly terminalCalled?: boolean;
  /** This role's deliverable IS its assistant text (vision), so non-empty text stops. */
  readonly textIsDeliverable?: boolean;
}): string | undefined {
  if (args.finalized || args.slotExists) return undefined; // deliverable present (engineer)
  if (args.terminalCalled === true) return undefined; // a terminal tool call (submit_vision)
  if (args.textIsDeliverable === true && args.finalText.trim() !== '') return undefined; // text IS the deliverable
  if (UNFULFILLABLE_RE.test(args.finalText)) return undefined; // terminal decision
  return args.continuePrompt; // premature stop → bump
}

/**
 * Convert a harness-neutral {@link RoleAgentCustomTool} into a pi
 * {@link ToolDefinition}. The `parameters` are a plain JSON Schema; the SDK
 * serializes them to the LLM tool schema and does NOT TypeBox-validate custom-tool
 * arguments before dispatch, so a plain object is safe here — the single cast is
 * confined to this seam boundary. `promptSnippet` is set so the tool appears in the
 * default system prompt's Available-tools section (custom tools are omitted from it
 * otherwise), keeping the tool discoverable.
 *
 * `execute` behaviour:
 *  - `submitReview` set (the engineer's `submit_contract`): the §164 interceptor —
 *    a STATEFUL {@link createSubmitReviewGate} that bounces on the first call and
 *    finalizes (verifying the slot file) on the second, recording into `capture`.
 *  - `consult` set (`call_peer` / `call_specialist`): spawns a CLEAN-CONTEXT advisor
 *    via {@link ConsultRunner.spawnAdvisor} (advice-only, read-only, depth-capped)
 *    and returns its prose. Charged via {@link ConsultRunner.onConsult}; declines
 *    with {@link CONSULT_DECLINED} when the budget is spent.
 *  - neither (e.g. the promotion tool): a no-op ack — the CALL itself is the signal
 *    (captured via the runtime's `tool_call` event into `toolCalls`). When the tool
 *    is marked `terminal` (the vision turn's `submit_vision`), the ack also flips
 *    `onTerminal` so the completeness bump knows the turn finished.
 */
export function toToolDefinition(
  tool: RoleAgentCustomTool,
  cwd: string,
  capture?: SubmitReviewCapture,
  consultRunner?: ConsultRunner,
  onTerminal?: () => void,
): ToolDefinition {
  const base = {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    promptSnippet: tool.description,
    parameters: tool.parameters as unknown as ToolDefinition['parameters'],
  };
  const submit = tool.submitReview;
  if (submit !== undefined) {
    const slotAbs = path.isAbsolute(submit.slot) ? submit.slot : path.join(cwd, submit.slot);
    const gate = createSubmitReviewGate({
      slot: submit.slot,
      reviewPrompt: submit.reviewPrompt,
      readSlot: () => readIfExists(slotAbs),
      ...(capture !== undefined ? { capture } : {}),
    });
    return {
      ...base,
      // A missing slot on finalize throws inside the gate → the pi loop surfaces it
      // to the model as an error result (write the file, then re-submit).
      execute: async (): Promise<AgentToolResult<unknown>> => ({
        content: [{ type: 'text', text: gate() }],
        details: undefined,
      }),
    };
  }
  const consult = tool.consult;
  if (consult !== undefined && consultRunner !== undefined) {
    return {
      ...base,
      execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
        // Budget gate: charge one turn (like any turn). Spent → decline (never a
        // silent free spawn); the engineer proceeds or returns unfulfillable.
        if (consultRunner.onConsult !== undefined && !consultRunner.onConsult()) {
          return { content: [{ type: 'text', text: CONSULT_DECLINED }], details: undefined };
        }
        const args = (params ?? {}) as Record<string, unknown>;
        const question = typeof args.question === 'string' ? args.question : '';
        // Resolve the advisor's system prompt: a peer uses its single prompt; a
        // specialist picks the lens the model chose (first lens as the fallback).
        let systemPrompt = consult.systemPrompt ?? '';
        if (consult.kind === 'specialist' && consult.lensPrompts !== undefined) {
          const keys = Object.keys(consult.lensPrompts);
          const picked =
            typeof args.lens === 'string' && consult.lensPrompts[args.lens] !== undefined
              ? args.lens
              : keys[0];
          systemPrompt = (picked !== undefined ? consult.lensPrompts[picked] : undefined) ?? '';
        }
        const advice = await consultRunner.spawnAdvisor({
          kind: consult.kind,
          systemPrompt,
          context: consult.context,
          question,
          samplingMode: consult.samplingMode as SamplingMode,
        });
        return { content: [{ type: 'text', text: advice }], details: undefined };
      },
    };
  }
  return {
    ...base,
    execute: async (): Promise<AgentToolResult<unknown>> => {
      // A TERMINAL no-op tool (submit_vision): flip the flag so the bump stops, and
      // ack decisively so the model does not keep calling tools.
      if (tool.terminal === true) {
        onTerminal?.();
        return {
          content: [{ type: 'text', text: `${tool.name} recorded — you are done. Stop here.` }],
          details: undefined,
        };
      }
      return { content: [{ type: 'text', text: `${tool.name} recorded.` }], details: undefined };
    },
  };
}

/** The resolved corp server the role-agents talk to (same baseUrl/model as chat). */
export interface RunRoleAgentConfig {
  /** OpenAI-compat base URL ending in `/v1` (the local llama-server). */
  readonly baseUrl: string;
  /** The served model id. */
  readonly model: string;
  /**
   * The web-research registrar (spec §4 — the CEO vision turn researches
   * references). INJECTED by the app (corp-main.ts passes
   * `(pi) => registerWebTools(pi)` from @pi-desktop/web-tools) so this seam carries
   * NO dependency on the web-tools package and stays loadable everywhere. Installed
   * ONLY for a run whose allowlist requests a web tool ({@link WEB_TOOL_NAMES}); the
   * allowlist still gates which tools the role may call. Absent → the vision turn
   * runs WITHOUT web research (it still has read/write/bash to draft its mockup).
   */
  readonly webResearchFactory?: ExtensionFactory;
}

/**
 * Build the {@link RunRoleAgentFn} the harness injects for every corp role. The
 * provider handle is created once and reused across contracts; each call runs one
 * bounded AgentSession — in an ISOLATED, dep-seeded workspace when `input.isolation`
 * is set (harvesting the engineer's writes back into `input.cwd`), else directly in
 * `input.cwd` — and maps its recorded result back to the harness's neutral
 * {@link RoleAgentRunOutput}, including the §164 submit-review signal. Never throws
 * — a misbehaving turn surfaces as a recorded terminal state.
 */
export function createRunRoleAgent(config: RunRoleAgentConfig): RunRoleAgentFn {
  // Build the provider handle ONCE and reuse it across contracts. It is now async
  // (createCorpModelProvider dynamic-imports the ESM-only pi SDK — the boot-crash
  // fix), so keep the PROMISE here and await it inside the returned run fn;
  // createRunRoleAgent itself stays synchronous, so corp-main's wiring is unchanged.
  const handlePromise = createCorpModelProvider({ baseUrl: config.baseUrl, model: config.model });
  const webResearchFactory = config.webResearchFactory;

  return async (input: RoleAgentRunInput): Promise<RoleAgentRunOutput> => {
    const handle = await handlePromise;
    // ISOLATED WORKSPACE (spec §91): seed a fresh dir with the engineer's deps and
    // run there; else run directly in the shared tree.
    const iso =
      input.isolation !== undefined ? seedIsolatedWorkspace(input.isolation.seed) : undefined;
    const agentCwd = iso?.dir ?? input.cwd;

    // The §164 quality signal — filled by the submit tool's stateful closure.
    const hasSubmitTool = (input.customTools ?? []).some((t) => t.submitReview !== undefined);
    const capture = hasSubmitTool ? newSubmitReviewCapture() : undefined;

    // CONSULTS (spec §7, advice-only, depth cap 1): a consult spawns a CLEAN-CONTEXT
    // advisor here — read-only, NO consult tools of its own, so it returns prose and
    // can neither edit the requester's files nor recurse. Charged via `onConsult`.
    const spawnAdvisor: ConsultRunner['spawnAdvisor'] = async (req) => {
      const advisorUser = [
        req.context,
        '',
        'QUESTION:',
        req.question.trim() !== ''
          ? req.question.trim()
          : '(Review the module above and advise on the best approach.)',
        '',
        'Answer with concise, concrete, evidence-grounded advice as prose. You may READ files to ground your advice. Do NOT write or edit any files — you advise only.',
      ].join('\n');
      try {
        const out = await runRoleAgent(handle, {
          purpose: `consult-${req.kind}`,
          systemPrompt: req.systemPrompt,
          userPrompt: advisorUser,
          // Read-only: advice only (no write/edit). No customTools → NO consult tools
          // for the advisor (depth cap 1). No bump — advisors are not engineers.
          tools: ['read'],
          cwd: agentCwd,
          thinking: true,
          samplingMode: req.samplingMode,
        });
        const text = out.finalText.trim();
        return text !== '' ? text : '(the advisor returned no specific advice)';
      } catch (err) {
        return `(consult unavailable: ${err instanceof Error ? err.message : String(err)})`;
      }
    };
    const consultRunner: ConsultRunner = {
      spawnAdvisor,
      ...(input.onConsult !== undefined ? { onConsult: input.onConsult } : {}),
    };

    // A `terminal` custom tool (submit_vision) flips this so the completeness bump
    // knows the turn finished (there is no submit gate / slot file to detect).
    let terminalCalled = false;
    const customTools =
      input.customTools !== undefined && input.customTools.length > 0
        ? input.customTools.map((t) =>
            toToolDefinition(t, agentCwd, capture, consultRunner, () => {
              terminalCalled = true;
            }),
          )
        : undefined;

    // WEB-RESEARCH (spec §4 CEO research): when the run's allowlist requests
    // web_search / web_fetch (the CEO vision turn) AND the app injected a
    // webResearchFactory, install it so those tools exist. The allowlist still gates
    // which of them the role may call, so no other role is affected. Absent factory
    // → the vision turn simply runs without web research.
    const wantsWebTools = input.tools.some((t) => WEB_TOOL_NAMES.has(t));
    const extensionFactories: ExtensionFactory[] =
      wantsWebTools && webResearchFactory !== undefined ? [webResearchFactory] : [];

    // BUMP-TO-CONTINUE (spec "Run safety & budgets"): after the session's loop ends,
    // if the engineer did NOT finalize AND its slot file is absent AND it did not
    // declare unfulfillable, re-prompt the SAME session — up to input.bump.maxBumps.
    const submitTool = (input.customTools ?? []).find((t) => t.submitReview !== undefined);
    const bumpSlot = submitTool?.submitReview?.slot;
    const bumpSlotAbs =
      bumpSlot !== undefined
        ? path.isAbsolute(bumpSlot)
          ? bumpSlot
          : path.join(agentCwd, relClean(bumpSlot))
        : undefined;
    // A run WITHOUT a submit gate (the vision turn — no submit_contract) has no slot
    // file; its deliverable is the `terminal` tool call (submit_vision) or its final
    // assistant text. A run WITH a submit gate (the engineer) keeps the file-based
    // semantics (text is NOT its deliverable).
    const hasSubmitGate = submitTool !== undefined;
    const deliverablePresent = (): boolean =>
      capture?.finalized === true ||
      (bumpSlotAbs !== undefined && readIfExists(bumpSlotAbs) !== undefined) ||
      terminalCalled;
    const bumpInput = input.bump;
    const bumpConfig =
      bumpInput !== undefined
        ? {
            maxBumps: bumpInput.maxBumps,
            nextPrompt: ({ finalText }: { finalText: string }): string | undefined =>
              bumpDecision({
                finalized: capture?.finalized === true,
                slotExists: bumpSlotAbs !== undefined && readIfExists(bumpSlotAbs) !== undefined,
                terminalCalled,
                textIsDeliverable: !hasSubmitGate,
                finalText,
                continuePrompt: bumpInput.continuePrompt,
              }),
          }
        : undefined;

    let result: Awaited<ReturnType<typeof runRoleAgent>>;
    try {
      result = await runRoleAgent(handle, {
        purpose: input.purpose,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        tools: [...input.tools],
        cwd: agentCwd,
        thinking: input.thinking,
        // The harness SamplingMode and the runtime's SamplingMode are the same
        // string union; keep the narrow cast at the single seam boundary.
        samplingMode: input.samplingMode as SamplingMode,
        ...(customTools !== undefined ? { customTools } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        ...(bumpConfig !== undefined ? { bump: bumpConfig } : {}),
        ...(extensionFactories.length > 0 ? { extensionFactories } : {}),
        // LIVE ACTIVITY (spec §11): forward the run's tool/turn events straight
        // through to the CorpEngine's sink. The runtime reports each `file-write`
        // path relative to the agent cwd (the isolated dir for an engineer, whose
        // relative slot === the product-tree slot), so the file map lights up the
        // right region mid-work — before the harvest at contract end.
        ...(input.onActivity !== undefined ? { onActivity: input.onActivity } : {}),
        // NO maxSteps and NO per-agent timeout are forwarded: the role runs fully
        // autonomously until it submits / the global RunBudget. runRoleAgent keeps
        // only its internal per-CALL network abort.
      });
    } catch (err) {
      if (iso !== undefined) iso.dispose();
      throw err;
    }

    // A genuine terminal "give up" (read while the slot is still in the isolated dir,
    // before harvest/dispose): no deliverable + an explicit unfulfillable line.
    const declaredUnfulfillable =
      !deliverablePresent() && UNFULFILLABLE_RE.test(result.finalText ?? '');

    // HARVEST the engineer's own files into the shared product tree (isolated only);
    // else the files it wrote directly in `input.cwd` are already in place. A
    // SCRATCH isolation (harvest === false — the CEO vision turn's mockup) is NOT
    // copied back: it must never enter the product tree the verify pass scans. Its
    // written files are still REPORTED (from the scratch dir, before dispose) so the
    // run can note "the CEO wrote a mockup" without polluting the product.
    const harvestBack = iso !== undefined && input.isolation?.harvest !== false;
    const filesWritten =
      iso !== undefined
        ? harvestBack
          ? iso.harvest(input.cwd)
          : result.filesWritten.map((f) => ({ path: f.path, bytes: f.bytes }))
        : result.filesWritten.map((f) => ({ path: f.path, bytes: f.bytes }));
    if (iso !== undefined) iso.dispose();

    return {
      filesWritten,
      finalText: result.finalText,
      toolCalls: result.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
      terminatedReason: result.terminatedReason,
      maxTurnOutputTokens: result.maxTurnOutputTokens,
      turns: result.turns,
      bumps: result.bumps,
      declaredUnfulfillable,
      ...(capture !== undefined
        ? {
            submitReview: {
              bounced: capture.bounced,
              finalized: capture.finalized,
              changed: capture.changed,
              draftBytes: capture.draftBytes,
              finalBytes: capture.finalBytes,
            },
          }
        : {}),
    };
  };
}
