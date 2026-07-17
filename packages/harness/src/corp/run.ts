/**
 * The CORP RUN ORCHESTRATOR — the whole flow behind ONE injected model seam, with
 * the global backstop threaded through every turn (spec §0.6 "robustness is
 * external", §7/§8/§9).
 *
 * Slices 1–5 built the pieces (promotion, architect, managers, dispatch, assemble,
 * verify, CEO sign-off, escalation) and the slice-4 driver wired them for a LIVE
 * model. But the live wiring lived only in a `.mjs` script that talks to a real
 * server, so there was no way to prove — as a unit test, without a server — that
 * the WHOLE run terminates however the model misbehaves. This module is that
 * proof-able core: {@link runCorp} sequences the entire pipeline behind a single
 * {@link CorpChatFn} seam and threads a {@link RunBudget} through EVERY model turn,
 * so an endless-looped or misbehaving model is caught and the run terminates
 * gracefully with a recorded terminal state.
 *
 * The two robustness guarantees it enforces around the existing bounded pieces:
 *  - GLOBAL BACKSTOP (budget.ts): every worker / architect / manager / engineer /
 *    re-scope / revise turn is charged first; when the budget is spent the run
 *    stops starting new turns, assembles whatever product exists, records
 *    `terminatedReason: 'budget-exceeded'`, and STILL runs the terminal CEO review
 *    over the partial product (an honest final verdict).
 *  - BOUNDED REVISE (revise.ts): a CEO `revise` re-works the flagged contracts and
 *    re-reviews, capped at `maxRevisions`; after the cap the honest final state
 *    stands. A CEO that always revises terminates at the cap (or, with the cap
 *    disabled, at the budget).
 *
 * It never touches `node:*` — the workspace fs is injected — so it runs fully
 * in-memory in tests. The live `.mjs` driver provides a streaming {@link CorpChatFn}
 * and the node fs seams.
 */

import { ARCHITECT_PROMPT, buildArchitectPrompt, parseArchitecture } from './architect.js';
import {
  buildProductManifest,
  type ContractStatusSummary,
  type ProductManifest,
} from './assemble.js';
import {
  budgetExceeded,
  chargeTurn,
  fitBudgetToPlan,
  newRunBudget,
  type RunBudget,
} from './budget.js';
import {
  buildCeoReviewPrompt,
  CEO_REVIEW_PROMPT,
  type CeoDecision,
  parseCeoDecision,
} from './ceo.js';
import { buildManagerContractPrompt, parseManagerContracts } from './contracts.js';
import {
  type DispatchReport,
  dispatchContracts,
  type EngineerRequest,
  type RunEngineer,
  type WrittenFile,
} from './dispatch.js';
import {
  AGENT_ENGINEER_SYSTEM_PROMPT,
  buildAgentEngineerPrompt,
  buildBumpContinuePrompt,
  buildConsultTools,
  buildEngineerPrompt,
  buildSubmitContractTool,
  ENGINEER_SYSTEM_PROMPT,
  engineerAgentToolAllowlist,
  MAX_ENGINEER_BUMPS,
  parseEngineerOutput,
} from './engineer.js';
import {
  buildManagerRescopeContractPrompt,
  escalateContract,
  rescopedContractFrom,
  runBoundedEscalation,
} from './escalate.js';
import { type DivisionContracts, resolveInterfaceHandles } from './integrate.js';
import type { Contract, ContractStatus, OrgChart, OrgNode } from './org-chart.js';
import { buildOrgChartQueueWithReport } from './plan.js';
import {
  applyCreateHierarchy,
  CREATE_PRODUCTION_HIERARCHY,
  CREATE_PRODUCTION_HIERARCHY_TOOL,
  type CreateHierarchyArgs,
  type HierarchyDivisionSpec,
  type OpenAiFunctionTool,
  PROMOTION_SYSTEM_PROMPT,
  parseCreateHierarchyArgs,
} from './promotion.js';
import { composeNodePrompt, getRolePrompt, roleThinkingEnabled } from './prompts.js';
import { isBlankFile, MANAGER_EMPTY_RETRY_NUDGE, withRetryOnEmpty } from './retry.js';
import { type ReviseOutcome, runBoundedRevise } from './revise.js';
import {
  type RoleAgentCustomTool,
  type RoleAgentRunInput,
  type RoleAgentRunOutput,
  type RunRoleAgentFn,
  samplingModeForPurpose,
} from './role-agent-seam.js';
import { type FileCheck, type VerifyResult, verifyProduct } from './verify.js';
import {
  buildCeoVisionPrompt,
  CEO_VISION_PROMPT,
  MAX_VISION_BUMPS,
  parseVisionBrief,
  SUBMIT_VISION,
  SUBMIT_VISION_TOOL,
  VISION_BUMP_PROMPT,
} from './vision.js';
import { type WorkspaceFs, type WorkspaceReadFs, writeSlot } from './workspace.js';

// --- The model seam ----------------------------------------------------------

/** The kind of model turn — every turn the budget charges is one of these. */
export type CorpTurnPurpose =
  | 'vision'
  | 'worker'
  | 'architect'
  | 'manager'
  | 'engineer'
  | 'ceo'
  | 'rescope'
  | 'revise'
  | 'consult';

/** One chat message handed to the seam (provider-agnostic: no `/no_think` tag,
 * no `chat_template_kwargs` — the seam applies provider specifics from `thinking`). */
export interface CorpChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** A tool call the seam surfaces from the model (the worker promotion call). */
export interface CorpToolCall {
  readonly name: string;
  /** Raw JSON-string arguments, or an already-decoded object. */
  readonly arguments: string | Record<string, unknown>;
}

/** One model turn requested by the orchestrator. The seam turns this into a real
 * provider call (or a mock in tests) and returns the assistant reply. */
export interface CorpChatRequest {
  readonly purpose: CorpTurnPurpose;
  readonly messages: readonly CorpChatMessage[];
  /** Whether this role runs with model "thinking" on (prompts.ts `roleThinkingEnabled`). */
  readonly thinking: boolean;
  /** The per-role generation cap (judgment turns vs. floored generation turns). */
  readonly maxTokens: number;
  /** Present only on the worker promotion turn. */
  readonly tools?: readonly OpenAiFunctionTool[];
}

/** The seam's reply. */
export interface CorpChatResult {
  /** Accumulated assistant text (already stripped of any reasoning channel). */
  readonly content: string;
  /** Tool calls the model emitted, if any (worker promotion). */
  readonly toolCalls?: readonly CorpToolCall[];
}

/** The single injected model seam the whole orchestrator runs on. Sync or async. */
export type CorpChatFn = (request: CorpChatRequest) => Promise<CorpChatResult> | CorpChatResult;

// --- Options + result --------------------------------------------------------

/** Inputs to {@link runCorp}. */
export interface RunCorpOptions {
  /** The user task to route. */
  readonly task: string;
  /** The model seam (streaming provider call in the driver; a mock in tests). */
  readonly chat: CorpChatFn;
  /**
   * The role-agent seam (pi-agnostic, injected by the app). When present, EVERY
   * corp role runs as a real agentic loop instead of a bare chat completion: the
   * engineer writes its slot file with tools + a bash self-check; the worker calls
   * the promotion tool; the architect + managers emit their structured JSON with
   * thinking off; and the CEO reviews the product with read + bash. The EXISTING
   * parsers still parse each role's output (the agent framing + thinking-off +
   * owner-tuned sampling is what curbs the runaway). When ABSENT (driver / tests),
   * every role falls back to the chat-based seam — so all existing flows keep
   * working with zero server.
   */
  readonly runRoleAgent?: RunRoleAgentFn;
  /** Workspace write seam (the chat-fallback engineer + assembly write here). */
  readonly fs: WorkspaceFs;
  /** Workspace read seam (assemble + verify read produced files back). */
  readonly readFs: WorkspaceReadFs;
  /** The per-task workspace root. */
  readonly workspace: string;
  /** Dispatch at most this many engineers (a subset); default: all ready ones. */
  readonly limit?: number;
  /** Run up to this many engineer jobs concurrently, bounded by the contract DAG
   * (dispatch.ts). Default 1 = the sequential walk, byte-for-byte. */
  readonly concurrency?: number;
  /** Cap on CEO revise cycles (revise.ts); default 1. */
  readonly maxRevisions?: number;
  /** Base generation cap for judgment turns (default 8192); manager + engineer
   * turns floor at 16k regardless (config robustness — see docs). */
  readonly maxTokens?: number;
  /** A preconstructed budget (tests pass a small one to force termination). When
   * omitted, one is minted from the `maxTurns` / `maxWallClockMs` / `now` options. */
  readonly budget?: RunBudget;
  readonly maxTurns?: number;
  readonly maxWallClockMs?: number;
  /** Clock seam for the minted budget (deterministic wall-clock tests). */
  readonly now?: () => number;
  /** Verify per-file check (default: verify.ts structural check). */
  readonly fileCheck?: FileCheck;
  /** Progress sink (the driver logs to stderr; tests may ignore). */
  readonly log?: (message: string) => void;
  /** Project id for the built chart (default from promotion). */
  readonly projectId?: string;
}

/** Why the run ended. */
export type TerminatedReason = 'completed' | 'solo' | 'budget-exceeded' | 'error';

/** A coarse manifest roll-up for the result. */
export interface ManifestSummary {
  readonly divisions: number;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly contractStatusSummary: ContractStatusSummary;
}

/** One escalated failed contract's bounded outcome (spec §9 → §7 re-dispatch). */
export interface EscalationSummary {
  readonly contractId: string;
  readonly ownerManager: string;
  readonly reason: string;
  /** The manager's re-scope turn produced a re-dispatchable contract (vs. accepting
   * the gap outright). */
  readonly rescoped: boolean;
  /** The re-scoped contract was RE-DISPATCHED through the engineer path (the one
   * bounded re-attempt). */
  readonly redispatched: boolean;
  /** The re-dispatch produced the slot file — the gap was RECOVERED (not silently
   * accepted). */
  readonly recovered: boolean;
  /** True when, after the one bounded attempt, the gap was accepted (not recovered)
   * — never a deadlock. */
  readonly acceptedGap: boolean;
}

/** The revise loop's summary for the result. */
export interface ReviseSummary {
  readonly revisionsRun: number;
  readonly maxRevisions: number;
  readonly hitCap: boolean;
  readonly approved: boolean;
  readonly stoppedForBudget: boolean;
}

/** The CEO vision-forming turn's summary for the result (spec §4). */
export interface VisionSummary {
  /** The synthesized vision brief that seeded the build (empty when the turn
   * produced nothing usable and the raw task was used instead). */
  readonly brief: string;
  /** True when the vision turn yielded no usable brief, so the RAW task was used
   * downstream (the vision can never silently blank the build). */
  readonly usedRawTask: boolean;
  /** Distinct tool names the CEO used while forming the vision (agent path only;
   * empty on the chat-fallback path, which has no tools). */
  readonly toolsUsed: readonly string[];
  /** How many scratch files (e.g. a mockup) the CEO wrote (agent path; the files
   * live in a disposed scratch dir and never enter the product tree). */
  readonly filesWritten: number;
  /** How many assistant turns the vision agent ran, when reported by the seam. */
  readonly turns?: number;
}

/** The budget's final state for the result. */
export interface BudgetSummary {
  readonly maxTurns: number;
  readonly maxWallClockMs: number;
  readonly turnsUsed: number;
  readonly exceeded: boolean;
}

/** The recorded terminal state of a whole run — never a hang, never a throw. */
export interface CorpRunResult {
  readonly task: string;
  readonly promoted: boolean;
  readonly terminatedReason: TerminatedReason;
  /** The CEO vision-forming turn that ran FIRST and seeded the build (spec §4). */
  readonly vision?: VisionSummary;
  readonly promotionReason?: string;
  readonly divisions: readonly string[];
  /** The solo (unpromoted) direct answer preview, when the worker stayed solo. */
  readonly directAnswerPreview?: string;
  readonly architecture?: { readonly moduleCount: number; readonly interfaceCount: number };
  readonly totalContracts: number;
  readonly emptyAfterRetryDivisions: readonly string[];
  readonly contractsDispatched: number;
  readonly engineerEmptyAfterRetry: number;
  readonly workspace: string;
  readonly manifest?: ManifestSummary;
  readonly verify?: {
    readonly ok: boolean;
    readonly errorCount: number;
    readonly filesChecked: number;
  };
  /** The CEO's first verdict, before any revision. */
  readonly initialCeoDecision?: CeoDecision;
  /** The delivered CEO verdict, after the bounded revise loop. */
  readonly ceoDecision?: CeoDecision;
  readonly revise?: ReviseSummary;
  readonly escalations: readonly EscalationSummary[];
  readonly failures: readonly { readonly contractId: string; readonly error?: string }[];
  readonly budget: BudgetSummary;
  /** How many model turns ran per purpose — bounded by the budget (test evidence). */
  readonly turnsByPurpose: Readonly<Record<CorpTurnPurpose, number>>;
  /** Turns that errored / were degraded, recorded (never silently dropped). */
  readonly errors: readonly { readonly purpose: string; readonly message: string }[];
}

// --- Internals ---------------------------------------------------------------

/** Control-flow sentinel: a work turn was refused because the budget is spent. */
class BudgetExhausted extends Error {
  constructor() {
    super('run budget exhausted');
    this.name = 'BudgetExhausted';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function preview(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** UTF-8 byte length of a produced file (no node:Buffer dependency). */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Extract the first balanced `{…}` JSON object from `text` (string-aware scan). */
function firstJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (typeof text !== 'string') return undefined;
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, i + 1));
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Detect a `create_production_hierarchy` promotion from the model reply — a tool
 * call (decoding string args) or a JSON object in the content. */
function detectPromotion(msg: CorpChatResult): CreateHierarchyArgs | undefined {
  for (const call of msg.toolCalls ?? []) {
    if (call.name !== CREATE_PRODUCTION_HIERARCHY) continue;
    const decoded =
      typeof call.arguments === 'string' ? firstJsonObject(call.arguments) : call.arguments;
    const parsed = parseCreateHierarchyArgs(decoded);
    if (parsed !== undefined) return parsed;
  }
  return parseCreateHierarchyArgs(firstJsonObject(msg.content));
}

const zeroTurns = (): Record<CorpTurnPurpose, number> => ({
  vision: 0,
  worker: 0,
  architect: 0,
  manager: 0,
  engineer: 0,
  ceo: 0,
  rescope: 0,
  revise: 0,
  consult: 0,
});

/**
 * Map a division to a prompt-library archetype id (frontend-dev / backend-dev),
 * else the generic `engineer` id, recorded as the engineer node's `promptId`
 * metadata. Heuristic over the division name + purpose; a misclassification is
 * harmless (the agent engineer's self-contained system prompt does not branch on
 * it — the typed contract governs the work). Returns a valid prompt-library id.
 */
function archetypeForDivision(division: HierarchyDivisionSpec): string {
  const hay = `${division.name} ${division.purpose}`.toLowerCase();
  const frontend =
    /\b(front[\s-]?end|ui|ux|client|view|css|html|react|vue|svelte|component|menu|hud|visual|render(?:er|ing)?|graphics?|scene|sprite|animation|3d|three|webgl|canvas|gameplay|level)\b/;
  const backend =
    /\b(back[\s-]?end|api|server|database|db|persistence|storage|auth|network|service|scor(?:e|ing)|state|engine|logic|physics|sound|audio|simulation|data|pipeline)\b/;
  if (frontend.test(hay)) return 'frontend-dev';
  if (backend.test(hay)) return 'backend-dev';
  return 'engineer';
}

/**
 * Materialize an engineer {@link OrgNode} per distinct contract owner so the
 * dispatcher can carry each engineer's DIVISION context. Today a contract's
 * `ownerNodeId` names a node that was never created, so the dispatcher finds no
 * node and the division's flavor is lost. Here each division's engineers get a node
 * whose `promptId` is the division archetype ({@link archetypeForDivision},
 * metadata) and whose `promptExtension` is the division purpose — the agent
 * engineer appends that purpose as neutral DOMAIN flavor onto its self-contained
 * system prompt. Robust: a blank owner id, or one that already exists (a permanent
 * role), is skipped.
 */
function buildEngineerNodes(
  base: OrgChart,
  divisions: readonly HierarchyDivisionSpec[],
  contractsByDivision: readonly (readonly Contract[])[],
): OrgNode[] {
  const divisionNodeIdByName = new Map<string, string>();
  for (const n of base.nodes) {
    if (n.role === 'division') divisionNodeIdByName.set(n.name.trim().toLowerCase(), n.id);
  }
  const taken = new Set(base.nodes.map((n) => n.id));
  const nodes: OrgNode[] = [];
  divisions.forEach((division, i) => {
    const promptId = archetypeForDivision(division);
    const parentId = divisionNodeIdByName.get(division.name.trim().toLowerCase());
    for (const contract of contractsByDivision[i] ?? []) {
      const ownerId = contract.ownerNodeId.trim();
      if (ownerId === '' || taken.has(ownerId)) continue;
      taken.add(ownerId);
      nodes.push({
        id: ownerId,
        role: 'engineer',
        name: ownerId,
        ...(parentId !== undefined ? { parentId } : {}),
        promptId,
        promptExtension: division.purpose,
      });
    }
  });
  return nodes;
}

/** Options for {@link buildEngineerAgentInput}. */
export interface EngineerAgentInputOptions {
  /** The shared product tree (the harvest target for an isolated engineer). */
  readonly workspace: string;
  /** The generation-heavy token cap (floored ≥16k, like the manager). */
  readonly genMaxTokens: number;
  /** Whether the engineer runs thinking-ON (prompts.ts `ROLE_THINKING.engineer`). */
  readonly engineerThinking: boolean;
  /** CEO revision notes to append (a re-dispatch of a flagged contract). */
  readonly extraNotes?: string;
}

/**
 * Build the {@link RoleAgentRunInput} for ONE engineer run on the agent path — the
 * single source of truth for the engineer's agentic framing (spec §7/§91), shared
 * by {@link runCorp}'s dispatcher AND the recovery-validation driver so neither
 * diverges. It assembles: the self-contained module-builder system prompt (+ the
 * division PURPOSE as neutral domain flavor), the write-flow user prompt, the tool
 * allowlist (built-ins + the submit + the two consult tool NAMES), the custom tools
 * (§164 `submit_contract` + the `call_peer` / `call_specialist` consults), the
 * ISOLATED-workspace directive (seeded with the dep files, harvested back), and the
 * BUMP-TO-CONTINUE policy (up to {@link MAX_ENGINEER_BUMPS} re-prompts to reach a
 * terminal decision). It does NOT attach `onConsult` — the CALLER wires that budget
 * hook (it owns the RunBudget). Pure + deterministic.
 */
export function buildEngineerAgentInput(
  request: EngineerRequest,
  options: EngineerAgentInputOptions,
): RoleAgentRunInput {
  const domain = request.promptExtension?.trim();
  const systemPrompt =
    domain !== undefined && domain !== ''
      ? `${AGENT_ENGINEER_SYSTEM_PROMPT}\n\nThis module's domain: ${domain}`
      : AGENT_ENGINEER_SYSTEM_PROMPT;
  const userPrompt = buildAgentEngineerPrompt(
    request.contract,
    request.depContext,
    request.architectureRegion,
    options.extraNotes,
  );
  // ISOLATED WORKSPACE (spec §91/§119/§182 — default isolated): seed a fresh dir
  // with ONLY the read-only dep files, harvest the engineer's writes back into the
  // shared tree. Contract.workspace==='shared' opts back into the shared tree (used
  // by the escalation re-dispatch so it can read anything already produced).
  const isolated = request.contract.workspace !== 'shared';
  const seed = request.depContext
    .filter((d) => d.content !== undefined && d.content !== '')
    .map((d) => ({ path: d.slot, content: d.content as string }));
  return {
    purpose: 'engineer',
    systemPrompt,
    userPrompt,
    // Built-ins + the submit + consult tool NAMES (the pi allowlist gates custom
    // tools by name — the submit + consults must be listed here or the model never
    // sees them).
    tools: engineerAgentToolAllowlist(request.contract.available.tools),
    // §164 submit_contract (the self-review bounce) + the two consults (the stuck
    // engineer's first stop before returning unfulfillable).
    customTools: [
      buildSubmitContractTool(request.contract),
      ...buildConsultTools(request.contract, {
        ...(request.promptId !== undefined ? { promptId: request.promptId } : {}),
        ...(domain !== undefined && domain !== '' ? { domain } : {}),
      }),
    ],
    cwd: options.workspace, // the SHARED product tree = harvest target
    ...(isolated ? { isolation: { seed } } : {}),
    thinking: options.engineerThinking,
    samplingMode: samplingModeForPurpose('engineer'),
    maxTokens: options.genMaxTokens,
    // BUMP-TO-CONTINUE: prevent a premature stop — re-prompt the SAME session up to
    // MAX_ENGINEER_BUMPS times to reach a terminal decision (write+submit, or
    // declare unfulfillable). Bounded; NOT a per-agent work cap.
    bump: {
      maxBumps: MAX_ENGINEER_BUMPS,
      continuePrompt: buildBumpContinuePrompt(request.contract),
    },
    // NO per-agent step/time cap: the engineer runs fully autonomously until it
    // submits / the global RunBudget; only a per-CALL network abort lives in the app.
  };
}

// --- The orchestrator --------------------------------------------------------

/**
 * Run the whole corp flow behind the injected model seam, threading the global
 * budget through every turn and the bounded revise loop through completion. NEVER
 * throws and NEVER hangs: a misbehaving model (always empty / always revising /
 * always erroring) is caught by the per-turn backstops and the global budget, and
 * the run returns a recorded {@link CorpRunResult}.
 */
export async function runCorp(options: RunCorpOptions): Promise<CorpRunResult> {
  const budget =
    options.budget ??
    newRunBudget({
      maxTurns: options.maxTurns,
      maxWallClockMs: options.maxWallClockMs,
      now: options.now,
    });
  const baseMaxTokens = options.maxTokens ?? 8192;
  const genMaxTokens = Math.max(baseMaxTokens, 16000);
  const limit = options.limit;
  const concurrency = options.concurrency;
  const log = options.log ?? (() => {});
  const engineerThinking = roleThinkingEnabled('engineer');

  const turnsByPurpose = zeroTurns();
  const errors: { purpose: string; message: string }[] = [];
  let terminatedReason: TerminatedReason | undefined;

  // A non-engineer work turn: charge first (a refusal STOPS the run), then call —
  // and DEGRADE a model error to empty content so a downstream parser handles it
  // (never crash the run). The recorded error is surfaced, never silently dropped.
  const workTurn = async (request: CorpChatRequest): Promise<CorpChatResult> => {
    if (!chargeTurn(budget)) {
      terminatedReason ??= 'budget-exceeded';
      throw new BudgetExhausted();
    }
    turnsByPurpose[request.purpose] += 1;
    try {
      return await options.chat(request);
    } catch (err) {
      errors.push({ purpose: request.purpose, message: errorMessage(err) });
      return { content: '' };
    }
  };

  const useAgentEngineer = options.runRoleAgent !== undefined;
  let engineerEmptyAfterRetry = 0;

  // The CHAT-FALLBACK engineer seam (no role-agent injected): a bare completion
  // whose reply IS the file. Charges every model call (draft + self-review +
  // retry); WRITES the parsed file to the slot itself and returns the written
  // file, so dispatch just records it (the write moved out of dispatch). A budget
  // refusal throws — dispatch catches it as a FAILED contract (finite) and we
  // record the terminate reason; a model error propagates too, so dispatch marks
  // the contract failed rather than aborting.
  const makeChatEngineer =
    (extraNotes?: string): RunEngineer =>
    async (request: EngineerRequest): Promise<readonly WrittenFile[]> => {
      const result = await withRetryOnEmpty({
        isEmpty: isBlankFile,
        run: async ({ isRetry }) => {
          if (!chargeTurn(budget)) {
            terminatedReason ??= 'budget-exceeded';
            throw new BudgetExhausted();
          }
          turnsByPurpose.engineer += 1;
          const thinking = isRetry ? false : engineerThinking;
          const base = buildEngineerPrompt(
            request.contract,
            request.depContext,
            request.architectureRegion,
          );
          const userContent =
            extraNotes !== undefined && extraNotes.trim() !== ''
              ? `${base}\n\nCEO REVISION NOTES (address these specifically):\n${extraNotes.trim()}`
              : base;
          const messages: CorpChatMessage[] = [
            { role: 'system', content: ENGINEER_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ];
          if (request.review !== undefined) {
            messages.push({ role: 'assistant', content: request.review.priorSubmission });
            messages.push({ role: 'user', content: request.review.prompt });
          }
          const res = await options.chat({
            purpose: 'engineer',
            messages,
            thinking,
            maxTokens: genMaxTokens,
          });
          return parseEngineerOutput(res.content ?? '');
        },
      });
      if (result.emptyAfterRetry) {
        engineerEmptyAfterRetry += 1;
        throw new Error(`engineer produced empty content for ${request.contract.id} after retry`);
      }
      const path = writeSlot(options.workspace, request.contract.slot, result.value, options.fs);
      return [{ path, bytes: byteLength(result.value) }];
    };

  // The AGENT engineer seam (role-agent injected): the engineer runs as a real
  // scoped AgentSession rooted at the shared workspace, READING its dependency
  // files and WRITING its slot file (plus small supporting files) with tools, then
  // a bash self-check — the files it writes ARE its submission. One agent run is
  // charged as ONE engineer turn against the global budget (its internal steps are
  // bounded by the seam's own step-cap + timeout, not the run budget). A budget
  // refusal throws (dispatch → FAILED, finite). The dep files are already in the
  // workspace (serial dispatch, no clobber), so the agent reads real code.
  const runRoleAgent = options.runRoleAgent;

  // A judgment/structured role run as an AGENT (worker / architect / manager):
  // charge ONE turn (a refusal STOPS the run, exactly like a work turn), record it,
  // and call the injected seam. The seam never throws per its contract; a
  // seam-level throw is degraded to an empty recorded output + a surfaced error, so
  // the downstream parser handles the empty reply rather than crashing the run.
  // NOT used for the CEO, whose terminal turn is charged-but-never-gated (it must
  // always deliver an honest verdict) — see the completion pass below.
  const agentRoleTurn = async (input: RoleAgentRunInput): Promise<RoleAgentRunOutput> => {
    if (runRoleAgent === undefined) {
      throw new Error('agentRoleTurn requires an injected runRoleAgent');
    }
    if (!chargeTurn(budget)) {
      terminatedReason ??= 'budget-exceeded';
      throw new BudgetExhausted();
    }
    turnsByPurpose[input.purpose] += 1;
    try {
      return await runRoleAgent(input);
    } catch (err) {
      errors.push({ purpose: input.purpose, message: errorMessage(err) });
      return { filesWritten: [], finalText: '', toolCalls: [], terminatedReason: 'error' };
    }
  };

  // The worker's promotion tool as a neutral custom-tool spec: calling it IS the
  // promotion signal, and detectPromotion parses the args off the recorded tool
  // call (falling back to the finalText JSON, the same detector the chat path uses).
  const promotionCustomTool: RoleAgentCustomTool = {
    name: CREATE_PRODUCTION_HIERARCHY_TOOL.function.name,
    description: CREATE_PRODUCTION_HIERARCHY_TOOL.function.description,
    parameters: CREATE_PRODUCTION_HIERARCHY_TOOL.function.parameters,
  };

  // Charge ONE consult (call_peer / call_specialist) turn against the global budget
  // — a refusal STOPS the run (like any turn). Passed to the seam as `onConsult`, so
  // the consult tool declines when the budget is spent (never a silent free turn).
  const onConsult = (): boolean => {
    if (!chargeTurn(budget)) {
      terminatedReason ??= 'budget-exceeded';
      return false;
    }
    turnsByPurpose.consult += 1;
    return true;
  };

  const makeAgentEngineer =
    (extraNotes?: string): RunEngineer =>
    async (request: EngineerRequest): Promise<readonly WrittenFile[]> => {
      if (runRoleAgent === undefined) return [];
      if (!chargeTurn(budget)) {
        terminatedReason ??= 'budget-exceeded';
        throw new BudgetExhausted();
      }
      turnsByPurpose.engineer += 1;
      // The engineer's agentic framing is assembled once, centrally (spec §7/§91) —
      // self-contained system prompt, the write-flow user turn, the submit + consult
      // custom tools, the ISOLATED-workspace directive, and the BUMP-TO-CONTINUE
      // policy. The budget hook (`onConsult`) is attached here — the harness owns it.
      const input = buildEngineerAgentInput(request, {
        workspace: options.workspace,
        genMaxTokens,
        engineerThinking,
        ...(extraNotes !== undefined ? { extraNotes } : {}),
      });
      const out = await runRoleAgent({ ...input, onConsult });
      return out.filesWritten.map((f) => ({ path: f.path, bytes: f.bytes }));
    };

  // The engineer seam dispatch uses. The agent path relies on its in-harness bash
  // self-check as the first-order review, so it does NOT run the model-free
  // submission bounce (dispatch's captureReviews); the chat-fallback path keeps
  // the self-review quality gate.
  const makeEngineerSeam = (extraNotes?: string): RunEngineer =>
    useAgentEngineer ? makeAgentEngineer(extraNotes) : makeChatEngineer(extraNotes);

  let promoted = false;
  let promotionArgs: CreateHierarchyArgs | undefined;
  let divisions: readonly HierarchyDivisionSpec[] = [];
  let architectureModuleCount = 0;
  let architectureInterfaceCount = 0;
  let hasArchitecture = false;
  let totalContracts = 0;
  const emptyAfterRetryDivisions: string[] = [];
  let chart: OrgChart | undefined;
  let dispatchReport: DispatchReport | undefined;
  let directAnswerPreview: string | undefined;
  // The VISION BRIEF the CEO forms in turn 0 (spec §4). It REPLACES the raw task
  // for everything downstream (promotion, architect, managers); an empty brief
  // means the turn produced nothing usable, so the raw task is used instead.
  let visionBrief = '';
  let visionSummary: VisionSummary | undefined;

  try {
    // 0. CEO VISION → the FIRST turn (spec §4): synthesize the user's intent into a
    // clear vision brief the whole corporation builds against. Harnessed with tools
    // (research / draft a throwaway mockup / iterate, then submit_vision) — a BARE
    // CEO overthinks. Thinking ON (the synthesis is the value). NO per-agent caps —
    // it runs until it submits; only the global RunBudget applies. On the agent path
    // it runs in an ISOLATED SCRATCH workspace (harvest OFF) so its mockup never
    // enters the product tree; on the chat-fallback path it is a plain completion
    // whose text IS the brief. A blank/failed turn falls back to the raw task.
    log('CEO vision turn');
    if (runRoleAgent !== undefined) {
      const out = await agentRoleTurn({
        purpose: 'vision',
        systemPrompt: CEO_VISION_PROMPT,
        userPrompt: buildCeoVisionPrompt(options.task),
        // read/write/bash to draft + preview a mockup; web_search/web_fetch to
        // research references (the app registers them when listed; the seam gates by
        // name). submit_vision's NAME must be in the allowlist or it is never offered.
        tools: ['read', 'write', 'bash', 'web_search', 'web_fetch', SUBMIT_VISION],
        customTools: [SUBMIT_VISION_TOOL],
        cwd: options.workspace,
        // Scratch-only isolation: the CEO's mockup lands in a fresh temp dir that is
        // NOT harvested back (verify.ts scans the whole product tree — a mockup must
        // not pollute it); the brief text is what carries forward.
        isolation: { seed: [], harvest: false },
        thinking: roleThinkingEnabled('ceo'),
        samplingMode: samplingModeForPurpose('vision'),
        maxTokens: baseMaxTokens,
        // COMPLETENESS BUMP (spec §4; like the engineer's bump-to-continue): a real
        // 4B often researches then stops WITHOUT submitting — re-prompt the SAME
        // session (its research preserved) to finalize the brief. NOT a per-agent
        // work cap; it only prevents a premature stop. Terminal when submit_vision
        // is called (SUBMIT_VISION_TOOL.terminal) or the CEO states the brief.
        bump: { maxBumps: MAX_VISION_BUMPS, continuePrompt: VISION_BUMP_PROMPT },
      });
      visionBrief = parseVisionBrief(out.toolCalls, out.finalText);
      visionSummary = {
        brief: visionBrief,
        usedRawTask: visionBrief === '',
        toolsUsed: [...new Set(out.toolCalls.map((c) => c.name))],
        filesWritten: out.filesWritten.length,
        ...(out.turns !== undefined ? { turns: out.turns } : {}),
      };
    } else {
      const res = await workTurn({
        purpose: 'vision',
        messages: [
          { role: 'system', content: CEO_VISION_PROMPT },
          { role: 'user', content: buildCeoVisionPrompt(options.task) },
        ],
        thinking: roleThinkingEnabled('ceo'),
        maxTokens: baseMaxTokens,
      });
      visionBrief = parseVisionBrief(res.toolCalls ?? [], res.content ?? '');
      visionSummary = {
        brief: visionBrief,
        usedRawTask: visionBrief === '',
        toolsUsed: [],
        filesWritten: 0,
      };
    }
    // The working task the corporation builds against: the CEO's vision brief when
    // it produced one, else the raw user task (never a silent blank — §0.6).
    const workingTask = visionBrief !== '' ? visionBrief : options.task;
    log(visionBrief !== '' ? 'vision formed' : 'vision empty — using raw task');

    // 1. WORKER → promote-or-not. Thinking ON — the promote-or-not judgment is the
    // value. On the agent path the promotion tool is a CUSTOM tool, so calling it
    // surfaces in toolCalls (detectPromotion reads it; falls back to finalText).
    log('worker turn');
    let workerRes: CorpChatResult;
    if (runRoleAgent !== undefined) {
      const out = await agentRoleTurn({
        purpose: 'worker',
        systemPrompt: PROMOTION_SYSTEM_PROMPT,
        userPrompt: workingTask,
        // The tool allowlist gates CUSTOM tools too (createAgentSession maps `tools`
        // → allowedToolNames), so the promotion tool's NAME must be listed here or
        // it is never offered to the model. No builtin file tools — a pure judgment
        // turn: promote (call the tool) or answer directly (stay solo).
        tools: [CREATE_PRODUCTION_HIERARCHY],
        customTools: [promotionCustomTool],
        cwd: options.workspace,
        thinking: true,
        samplingMode: samplingModeForPurpose('worker'),
        maxTokens: baseMaxTokens,
        // No per-agent caps — PROMOTION_SYSTEM_PROMPT tells the worker to stop the
        // moment it calls the tool; the global RunBudget is the only net.
      });
      workerRes = { content: out.finalText, toolCalls: out.toolCalls };
    } else {
      workerRes = await workTurn({
        purpose: 'worker',
        messages: [
          { role: 'system', content: PROMOTION_SYSTEM_PROMPT },
          { role: 'user', content: workingTask },
        ],
        thinking: true,
        maxTokens: baseMaxTokens,
        tools: [CREATE_PRODUCTION_HIERARCHY_TOOL],
      });
    }
    promotionArgs = detectPromotion(workerRes);

    if (promotionArgs === undefined) {
      directAnswerPreview = preview(workerRes.content ?? '');
      terminatedReason ??= 'solo';
      log('stayed solo');
    } else {
      promoted = true;
      divisions = promotionArgs.divisions;
      log(`promoted — ${divisions.length} division(s)`);

      // 2. ARCHITECT → shared architecture. Thinking OFF (structured JSON); read
      // tool on the agent path. Generation-heavy structured-output role — floor at
      // 16k like the manager so the Architecture JSON can never silently truncate.
      const architectThinking = roleThinkingEnabled('architect');
      let architectContent: string;
      if (runRoleAgent !== undefined) {
        const out = await agentRoleTurn({
          purpose: 'architect',
          systemPrompt: ARCHITECT_PROMPT,
          userPrompt: buildArchitectPrompt(workingTask, divisions),
          tools: ['read'],
          cwd: options.workspace,
          thinking: architectThinking,
          samplingMode: samplingModeForPurpose('architect'),
          maxTokens: genMaxTokens,
          // No per-agent caps — the global RunBudget is the only net.
        });
        architectContent = out.finalText;
      } else {
        const architectRes = await workTurn({
          purpose: 'architect',
          messages: [
            { role: 'system', content: ARCHITECT_PROMPT },
            { role: 'user', content: buildArchitectPrompt(workingTask, divisions) },
          ],
          thinking: architectThinking,
          maxTokens: genMaxTokens,
        });
        architectContent = architectRes.content ?? '';
      }
      const architecture = parseArchitecture(architectContent);
      architectureModuleCount = architecture.moduleMap.length;
      architectureInterfaceCount = architecture.interfaces.length;
      hasArchitecture = true;

      // 3. MANAGERS (one seeded turn per division, retry-on-empty). Thinking OFF —
      // it emits a parse-critical JSON contract array. On the agent path the system
      // prompt is DIVISION-SPECIFIC (manager base + the division's purpose
      // extension) and the read tool is available.
      const managerRolePrompt = getRolePrompt('manager');
      const managerThinking = roleThinkingEnabled('manager');
      const contractsByDivision: Contract[][] = [];
      for (const division of divisions) {
        const managerResult = await withRetryOnEmpty({
          isEmpty: (contracts: readonly Contract[]) => contracts.length === 0,
          run: async ({ isRetry }) => {
            const basePrompt = buildManagerContractPrompt(division, workingTask, architecture);
            const userContent = isRetry
              ? `${basePrompt}\n\n${MANAGER_EMPTY_RETRY_NUDGE}`
              : basePrompt;
            let content: string;
            if (runRoleAgent !== undefined) {
              const out = await agentRoleTurn({
                purpose: 'manager',
                systemPrompt: composeNodePrompt(managerRolePrompt, division.purpose),
                userPrompt: userContent,
                tools: ['read'],
                cwd: options.workspace,
                thinking: managerThinking,
                samplingMode: samplingModeForPurpose('manager'),
                maxTokens: genMaxTokens,
                // No per-agent caps — the global RunBudget is the only net.
              });
              content = out.finalText;
            } else {
              const res = await workTurn({
                purpose: 'manager',
                messages: [
                  { role: 'system', content: managerRolePrompt.prompt },
                  { role: 'user', content: userContent },
                ],
                thinking: managerThinking,
                maxTokens: genMaxTokens,
              });
              content = res.content ?? '';
            }
            return parseManagerContracts(content);
          },
        });
        contractsByDivision.push(managerResult.value);
        if (managerResult.emptyAfterRetry) emptyAfterRetryDivisions.push(division.name);
      }

      // 4. RESOLVE handles + build the queued chart.
      const byDivision: DivisionContracts[] = divisions.map((d, i) => ({
        division: d.name,
        contracts: contractsByDivision[i] ?? [],
      }));
      const { contracts: resolvedContracts } = resolveInterfaceHandles(byDivision, architecture);
      const baseChart = applyCreateHierarchy(
        null,
        { reason: promotionArgs.reason, divisions },
        options.projectId,
      );
      // Materialize an engineer node per contract owner so the dispatcher composes
      // each engineer's system prompt division-specifically (archetype base + the
      // division purpose extension) instead of falling back to the generic base.
      const engineerNodes = buildEngineerNodes(baseChart, divisions, contractsByDivision);
      const withEngineers: OrgChart = {
        ...baseChart,
        nodes: [...baseChart.nodes, ...engineerNodes],
        nodeStatus: {
          ...baseChart.nodeStatus,
          ...Object.fromEntries(engineerNodes.map((n) => [n.id, 'idle' as const])),
        },
      };
      const { chart: queued } = buildOrgChartQueueWithReport({
        ...withEngineers,
        contracts: resolvedContracts,
        architecture,
      });
      chart = queued;
      totalContracts = chart.contracts.length;

      // The plan size is now known — grow the turn cap to fit it (never below the
      // floor; the wall-clock cap is untouched — the hard net no plan can widen).
      fitBudgetToPlan(budget, {
        contractCount: totalContracts,
        divisionCount: divisions.length,
      });

      // 5. DISPATCH a subset — engineer turns run through the budget-charged seam.
      log(`dispatching (limit=${limit ?? 'all'})`);
      dispatchReport = await dispatchContracts({
        orgChart: chart,
        runEngineer: makeEngineerSeam(),
        readFs: options.readFs,
        workspace: options.workspace,
        // Chat-fallback path runs the model-free self-review bounce; the agent
        // path self-checks in-harness (bash) instead, so no bounce there.
        ...(useAgentEngineer ? {} : { captureReviews: true }),
        ...(limit !== undefined ? { limit } : {}),
        ...(concurrency !== undefined ? { concurrency } : {}),
      });
      chart = dispatchReport.chart;
    }
  } catch (err) {
    if (err instanceof BudgetExhausted) terminatedReason ??= 'budget-exceeded';
    else {
      errors.push({ purpose: 'pipeline', message: errorMessage(err) });
      terminatedReason ??= 'error';
    }
  }

  // --- Terminal completion pass (assemble → CEO sign-off → bounded revise →
  // bounded escalation). Runs whenever a corporation formed — EVEN after a budget
  // stop, so the run ends with an honest verdict over whatever product exists. ---
  let manifest: ProductManifest | undefined;
  let verifyResult: VerifyResult | undefined;
  let initialCeoDecision: CeoDecision | undefined;
  let finalCeoDecision: CeoDecision | undefined;
  let reviseSummary: ReviseSummary | undefined;
  let escalations: EscalationSummary[] = [];

  if (promoted && promotionArgs !== undefined) {
    // A chart always exists to review: the dispatched one, or (if the budget cut
    // us off before planning finished) a bare promoted chart with no files.
    const reviewChart: OrgChart =
      chart ??
      applyCreateHierarchy(null, { reason: promotionArgs.reason, divisions }, options.projectId);

    // The STANDARD the CEO judges against: the original task AND the vision brief
    // the CEO itself formed in turn 0 (spec §8 — the vision is what it later judges
    // the product against). Still transcript-free: buildCeoReviewPrompt has no
    // build-transcript field, so the false-completion cure is preserved by SHAPE.
    const reviewStandard =
      visionBrief !== ''
        ? `${options.task.trim()}\n\nVISION BRIEF you formed as the standard for this build:\n${visionBrief}`
        : options.task;

    // The terminal CEO sign-off turn — charged for accounting but NEVER gated by a
    // refusal: the run must always end with an honest verdict over the final
    // product, so this one turn is allowed past the work-turn cap. A CEO error /
    // empty reply defaults to `revise` (never rubber-stamp — the false-completion
    // cure), so it still terminates.
    const ceoReview = async (purpose: 'ceo' | 'revise'): Promise<CeoDecision> => {
      manifest = buildProductManifest(reviewChart, options.workspace, options.readFs);
      verifyResult = verifyProduct(options.workspace, options.readFs, options.fileCheck);
      chargeTurn(budget);
      turnsByPurpose[purpose] += 1;
      // VISION-ONLY user turn (original task + the vision brief + product manifest +
      // verify evidence) — NEVER the build transcript. The false-completion cure is
      // enforced by buildCeoReviewPrompt's SHAPE (it has no transcript field) and is
      // preserved identically on BOTH the agent and the chat path.
      const userContent = buildCeoReviewPrompt({
        originalTask: reviewStandard,
        manifest,
        verifyResult,
      });
      try {
        if (runRoleAgent !== undefined) {
          // Harnessed review: the CEO gets read + bash so it can INSPECT the
          // produced product and run a quick compile/typecheck sanity check — but
          // its context is still the vision + the finished artifact, never the
          // build. Thinking ON — the CEO's reasoning is the value. No per-agent
          // caps; the global RunBudget is the only net.
          const out = await runRoleAgent({
            purpose,
            systemPrompt: getRolePrompt('ceo').prompt,
            userPrompt: userContent,
            tools: ['read', 'bash'],
            cwd: options.workspace,
            thinking: roleThinkingEnabled('ceo'),
            samplingMode: samplingModeForPurpose(purpose),
            maxTokens: baseMaxTokens,
          });
          return parseCeoDecision(out.finalText);
        }
        const res = await options.chat({
          purpose,
          messages: [
            { role: 'system', content: CEO_REVIEW_PROMPT },
            { role: 'user', content: userContent },
          ],
          thinking: roleThinkingEnabled('ceo'),
          maxTokens: baseMaxTokens,
        });
        return parseCeoDecision(res.content ?? '');
      } catch (err) {
        errors.push({ purpose, message: errorMessage(err) });
        return { decision: 'revise', notes: 'CEO review turn failed; no verdict produced.' };
      }
    };

    log('CEO final review');
    initialCeoDecision = await ceoReview('ceo');

    // BOUNDED REVISE: re-work the flagged (failed) contracts addressing the notes,
    // then re-review — capped at maxRevisions, and stopped early if the budget is
    // spent. A never-satisfied CEO terminates at the cap (or the budget).
    const revise: ReviseOutcome = await runBoundedRevise({
      initialDecision: initialCeoDecision,
      maxRevisions: options.maxRevisions,
      budget,
      runRevision: async ({ notes }) => {
        // Re-dispatch the concrete gaps (the failed contracts) with the notes in
        // the engineer prompt, then re-review the updated product.
        if (chart !== undefined && dispatchReport !== undefined) {
          const failedIds = new Set(dispatchReport.failed);
          const failedContracts = chart.contracts.filter((c) => failedIds.has(c.id));
          if (failedContracts.length > 0 && !budgetExceeded(budget)) {
            const reworkChart: OrgChart = {
              ...chart,
              contracts: failedContracts.map((c) => ({
                ...c,
                status: 'queued' as ContractStatus,
                dependsOn: c.dependsOn.filter((d) => failedIds.has(d)),
              })),
              queue: [],
            };
            const rework = await dispatchContracts({
              orgChart: reworkChart,
              runEngineer: makeEngineerSeam(notes),
              readFs: options.readFs,
              workspace: options.workspace,
              ...(useAgentEngineer ? {} : { captureReviews: true }),
              ...(concurrency !== undefined ? { concurrency } : {}),
            });
            const newlyDone = new Set(rework.done);
            chart = {
              ...chart,
              contracts: chart.contracts.map((c) =>
                newlyDone.has(c.id) ? { ...c, status: 'in-review' as ContractStatus } : c,
              ),
            };
            dispatchReport = {
              ...dispatchReport,
              done: [...new Set([...dispatchReport.done, ...rework.done])],
              failed: [
                ...dispatchReport.failed.filter((id) => !newlyDone.has(id)),
                ...rework.failed,
              ],
              chart,
            };
          }
        }
        return ceoReview('revise');
      },
    });
    finalCeoDecision = revise.finalDecision;
    reviseSummary = {
      revisionsRun: revise.revisionsRun,
      maxRevisions: options.maxRevisions ?? 1,
      hitCap: revise.hitCap,
      approved: revise.approved,
      stoppedForBudget: revise.stoppedForBudget,
    };
    if (revise.stoppedForBudget) terminatedReason ??= 'budget-exceeded';

    // RE-DISPATCH a re-scoped contract through the SAME engineer path — the one
    // bounded re-attempt escalation now makes (spec §9, §205). Runs the re-scoped
    // (self-contained, shared-workspace) contract as a single-contract dispatch; on
    // success it folds the recovered contract back into `chart` + `dispatchReport`
    // (so the failure list and status reflect the recovery). Returns whether the
    // slot file was produced (recovered). The engineer turn it runs is budget-charged
    // by the seam; a spent budget or an error simply yields `false` (accepted gap).
    const redispatchRescoped = async (rescoped: Contract): Promise<boolean> => {
      if (chart === undefined || dispatchReport === undefined) return false;
      if (budgetExceeded(budget)) return false;
      const oneContractChart: OrgChart = { ...chart, contracts: [rescoped], queue: [] };
      let report: DispatchReport;
      try {
        report = await dispatchContracts({
          orgChart: oneContractChart,
          runEngineer: makeEngineerSeam(),
          readFs: options.readFs,
          workspace: options.workspace,
          ...(useAgentEngineer ? {} : { captureReviews: true }),
          ...(concurrency !== undefined ? { concurrency } : {}),
        });
      } catch {
        return false;
      }
      const recovered = report.done.includes(rescoped.id);
      if (recovered) {
        const recoveredChart: OrgChart = {
          ...chart,
          contracts: chart.contracts.map((c) =>
            c.id === rescoped.id ? { ...c, status: 'in-review' as ContractStatus } : c,
          ),
        };
        chart = recoveredChart;
        dispatchReport = {
          ...dispatchReport,
          done: [...new Set([...dispatchReport.done, rescoped.id])],
          failed: dispatchReport.failed.filter((id) => id !== rescoped.id),
          results: dispatchReport.results.map((r) =>
            r.contractId === rescoped.id ? { ...r, status: 'done' as const } : r,
          ),
          chart: recoveredChart,
        };
      }
      return recovered;
    };

    // BOUNDED ESCALATION: each still-failed contract routes ONE level up for a single
    // re-scope turn that produces a re-dispatchable contract; that contract gets ONE
    // re-attempt through the dispatch path. Recovered → the gap is closed; still
    // failing → an accepted gap. Never a deadlock; every turn is budget-charged.
    escalations = await runEscalations({
      chart,
      dispatchReport,
      budget,
      chat: options.chat,
      genMaxTokens,
      turnsByPurpose,
      errors,
      redispatch: redispatchRescoped,
      onBudgetOut: () => {
        terminatedReason ??= 'budget-exceeded';
      },
    });

    // If escalation RECOVERED any gap (re-scoped + re-dispatched), the on-disk product
    // now has more than the CEO reviewed — refresh the final manifest + verify so the
    // RESULT reflects the true product. The CEO's verdict already stands (its context
    // was the clean pre-recovery product); the manager's recovery is honestly added.
    if (escalations.some((e) => e.recovered) && chart !== undefined) {
      manifest = buildProductManifest(chart, options.workspace, options.readFs);
      verifyResult = verifyProduct(options.workspace, options.readFs, options.fileCheck);
    }
  }

  if (terminatedReason === undefined) terminatedReason = promoted ? 'completed' : 'solo';

  const manifestSummary: ManifestSummary | undefined =
    manifest === undefined
      ? undefined
      : {
          divisions: manifest.divisions.length,
          fileCount: manifest.files.length,
          totalBytes: manifest.totalBytes,
          contractStatusSummary: manifest.contractStatusSummary,
        };

  return {
    task: options.task,
    promoted,
    terminatedReason,
    ...(visionSummary !== undefined ? { vision: visionSummary } : {}),
    ...(promotionArgs !== undefined ? { promotionReason: promotionArgs.reason } : {}),
    divisions: divisions.map((d) => d.name),
    ...(directAnswerPreview !== undefined ? { directAnswerPreview } : {}),
    ...(hasArchitecture
      ? {
          architecture: {
            moduleCount: architectureModuleCount,
            interfaceCount: architectureInterfaceCount,
          },
        }
      : {}),
    totalContracts,
    emptyAfterRetryDivisions,
    contractsDispatched:
      dispatchReport === undefined ? 0 : dispatchReport.done.length + dispatchReport.failed.length,
    engineerEmptyAfterRetry,
    workspace: options.workspace,
    ...(manifestSummary !== undefined ? { manifest: manifestSummary } : {}),
    ...(verifyResult !== undefined
      ? {
          verify: {
            ok: verifyResult.ok,
            errorCount: verifyResult.errors.length,
            filesChecked: verifyResult.filesChecked,
          },
        }
      : {}),
    ...(initialCeoDecision !== undefined ? { initialCeoDecision } : {}),
    ...(finalCeoDecision !== undefined ? { ceoDecision: finalCeoDecision } : {}),
    ...(reviseSummary !== undefined ? { revise: reviseSummary } : {}),
    escalations,
    failures:
      dispatchReport === undefined
        ? []
        : dispatchReport.results
            .filter((r) => r.status === 'failed')
            .map((r) =>
              r.error !== undefined
                ? { contractId: r.contractId, error: r.error }
                : { contractId: r.contractId },
            ),
    budget: {
      maxTurns: budget.maxTurns,
      maxWallClockMs: budget.maxWallClockMs,
      turnsUsed: budget.turnsUsed,
      exceeded: budgetExceeded(budget),
    },
    turnsByPurpose,
    errors,
  };
}

/** Run the bounded escalation for every still-failed contract (spec §9, §205): ONE
 * re-scope manager turn that produces a re-dispatchable contract, then ONE bounded
 * RE-DISPATCH of it through the engineer path — recovered, or an accepted gap. Every
 * turn is budget-charged; never a deadlock, never throws. Extracted to keep
 * {@link runCorp} legible. */
async function runEscalations(params: {
  readonly chart: OrgChart | undefined;
  readonly dispatchReport: DispatchReport | undefined;
  readonly budget: RunBudget;
  readonly chat: CorpChatFn;
  readonly genMaxTokens: number;
  readonly turnsByPurpose: Record<CorpTurnPurpose, number>;
  readonly errors: { purpose: string; message: string }[];
  /** The one bounded re-attempt: dispatch the re-scoped contract through the engineer
   * path; returns whether the slot file was produced (recovered). */
  readonly redispatch: (rescoped: Contract) => Promise<boolean>;
  readonly onBudgetOut: () => void;
}): Promise<EscalationSummary[]> {
  const { chart, dispatchReport } = params;
  const out: EscalationSummary[] = [];
  if (chart === undefined || dispatchReport === undefined) return out;
  // Snapshot the failed ids: a successful re-dispatch mutates the outer report, but
  // each ORIGINALLY-failed contract still gets its one escalation attempt.
  for (const failedId of [...dispatchReport.failed]) {
    const contract = chart.contracts.find((c) => c.id === failedId);
    if (contract === undefined) continue;
    const failedResult = dispatchReport.results.find((r) => r.contractId === failedId);
    const record = escalateContract(chart, failedId, failedResult?.error);
    let rescoped = false;
    let redispatched = false;
    const outcome = await runBoundedEscalation({
      record,
      // Exactly ONE attempt (runBoundedEscalation calls this once). The re-scope
      // manager turn + the re-dispatch engineer turn are the two budget-charged turns
      // this attempt may spend.
      attemptRescope: async () => {
        // Budget-checked: no budget → accept the gap without a turn (never hang).
        if (!chargeTurn(params.budget)) {
          params.onBudgetOut();
          return false;
        }
        params.turnsByPurpose.rescope += 1;
        let content = '';
        try {
          const res = await params.chat({
            purpose: 'rescope',
            messages: [
              { role: 'system', content: getRolePrompt('manager').prompt },
              {
                role: 'user',
                content: buildManagerRescopeContractPrompt(contract, record.reason),
              },
            ],
            // Structured JSON (a re-scoped contract) → thinking-off, like the manager.
            thinking: roleThinkingEnabled('manager'),
            maxTokens: params.genMaxTokens,
          });
          content = res.content ?? '';
        } catch (err) {
          params.errors.push({ purpose: 'rescope', message: errorMessage(err) });
          return false; // a failed re-scope turn → accept the gap (never a retry)
        }
        // Parse the manager's re-scoped contract. Empty (the manager accepted the
        // gap) or unparseable → accept the gap, no re-dispatch.
        const parsed = parseManagerContracts(content)[0];
        if (parsed === undefined) return false;
        rescoped = true;
        const readyToDispatch = rescopedContractFrom(parsed, contract);
        redispatched = true;
        // The ONE bounded re-attempt through the same dispatch path. Recovered ⇒ the
        // gap is closed; else it becomes an accepted gap. Never loops.
        return await params.redispatch(readyToDispatch);
      },
    });
    out.push({
      contractId: record.contractId,
      ownerManager: record.ownerManager,
      reason: record.reason,
      rescoped,
      redispatched,
      recovered: outcome.resolved,
      acceptedGap: outcome.acceptedGap,
    });
  }
  return out;
}
