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
  buildEngineerPrompt,
  buildSubmitContractTool,
  ENGINEER_SYSTEM_PROMPT,
  engineerAgentToolAllowlist,
  parseEngineerOutput,
} from './engineer.js';
import { buildManagerRescopePrompt, escalateContract, runBoundedEscalation } from './escalate.js';
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
import { type WorkspaceFs, type WorkspaceReadFs, writeSlot } from './workspace.js';

// --- The model seam ----------------------------------------------------------

/** The kind of model turn — every turn the budget charges is one of these. */
export type CorpTurnPurpose =
  | 'worker'
  | 'architect'
  | 'manager'
  | 'engineer'
  | 'ceo'
  | 'rescope'
  | 'revise';

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

/** One escalated failed contract's bounded outcome. */
export interface EscalationSummary {
  readonly contractId: string;
  readonly ownerManager: string;
  readonly reason: string;
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
  worker: 0,
  architect: 0,
  manager: 0,
  engineer: 0,
  ceo: 0,
  rescope: 0,
  revise: 0,
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

  const makeAgentEngineer =
    (extraNotes?: string): RunEngineer =>
    async (request: EngineerRequest): Promise<readonly WrittenFile[]> => {
      if (runRoleAgent === undefined) return [];
      if (!chargeTurn(budget)) {
        terminatedReason ??= 'budget-exceeded';
        throw new BudgetExhausted();
      }
      turnsByPurpose.engineer += 1;
      // SELF-CONTAINED module-builder system prompt (spec §91): no CEO/manager/
      // division/corporation lore — the engineer knows only its contract + deps.
      // The division PURPOSE is appended as neutral domain flavor, not org structure.
      const domain = request.promptExtension?.trim();
      const systemPrompt =
        domain !== undefined && domain !== ''
          ? `${AGENT_ENGINEER_SYSTEM_PROMPT}\n\nThis module's domain: ${domain}`
          : AGENT_ENGINEER_SYSTEM_PROMPT;
      const userPrompt = buildAgentEngineerPrompt(
        request.contract,
        request.depContext,
        request.architectureRegion,
        extraNotes,
      );
      // ISOLATED WORKSPACE (spec §91/§119/§182 — default isolated): the seam runs
      // the engineer in a fresh dir seeded with ONLY its dependency files (read-only
      // context), then HARVESTS what it wrote back into the shared product tree. An
      // explicit Contract.workspace==='shared' opts back into the shared tree. The
      // architect's non-overlapping module map keeps the harvest merge conflict-free.
      const isolated = request.contract.workspace !== 'shared';
      const seed = request.depContext
        .filter((d) => d.content !== undefined && d.content !== '')
        .map((d) => ({ path: d.slot, content: d.content as string }));
      const out = await runRoleAgent({
        purpose: 'engineer',
        systemPrompt,
        userPrompt,
        // The built-in toolset PLUS the `submit_contract` name — the pi allowlist
        // gates custom tools by name, so the submit tool must be listed here or the
        // model never sees it (the same gotcha as the worker).
        tools: engineerAgentToolAllowlist(request.contract.available.tools),
        // submit_contract IS the §164 submission interceptor: the FIRST call bounces
        // with a self-review prompt (improve, do not finalize); the SECOND verifies
        // the slot file exists in the isolated cwd and finalizes.
        customTools: [buildSubmitContractTool(request.contract)],
        cwd: options.workspace, // the SHARED product tree = harvest target
        ...(isolated ? { isolation: { seed } } : {}),
        thinking: engineerThinking,
        samplingMode: samplingModeForPurpose('engineer'),
        maxTokens: genMaxTokens,
        // NO per-agent caps: the engineer runs fully autonomously (any tools, as
        // long as it wants) until it calls submit_contract, bounded only by the
        // global RunBudget. The app runtime keeps only a per-CALL network abort.
      });
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

  try {
    // 1. WORKER → promote-or-not. Thinking ON — the promote-or-not judgment is the
    // value. On the agent path the promotion tool is a CUSTOM tool, so calling it
    // surfaces in toolCalls (detectPromotion reads it; falls back to finalText).
    log('worker turn');
    let workerRes: CorpChatResult;
    if (runRoleAgent !== undefined) {
      const out = await agentRoleTurn({
        purpose: 'worker',
        systemPrompt: PROMOTION_SYSTEM_PROMPT,
        userPrompt: options.task,
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
          { role: 'user', content: options.task },
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
          userPrompt: buildArchitectPrompt(options.task, divisions),
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
            { role: 'user', content: buildArchitectPrompt(options.task, divisions) },
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
            const basePrompt = buildManagerContractPrompt(division, options.task, architecture);
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
      // VISION-ONLY user turn (original task + product manifest + verify evidence) —
      // NEVER the build transcript. The false-completion cure is enforced by
      // buildCeoReviewPrompt's SHAPE (it has no transcript field) and is preserved
      // identically on BOTH the agent and the chat path.
      const userContent = buildCeoReviewPrompt({
        originalTask: options.task,
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

    // BOUNDED ESCALATION: each still-failed contract routes ONE level up for a
    // single re-scope turn, then an accepted gap — never a deadlock. Budget-checked.
    escalations = await runEscalations({
      chart,
      dispatchReport,
      budget,
      chat: options.chat,
      genMaxTokens,
      turnsByPurpose,
      errors,
      onBudgetOut: () => {
        terminatedReason ??= 'budget-exceeded';
      },
    });
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

/** Run the bounded escalation for every still-failed contract (one re-scope turn
 * each, budget-checked, then an accepted gap). Extracted to keep {@link runCorp}
 * legible; never throws. */
async function runEscalations(params: {
  readonly chart: OrgChart | undefined;
  readonly dispatchReport: DispatchReport | undefined;
  readonly budget: RunBudget;
  readonly chat: CorpChatFn;
  readonly genMaxTokens: number;
  readonly turnsByPurpose: Record<CorpTurnPurpose, number>;
  readonly errors: { purpose: string; message: string }[];
  readonly onBudgetOut: () => void;
}): Promise<EscalationSummary[]> {
  const { chart, dispatchReport } = params;
  const out: EscalationSummary[] = [];
  if (chart === undefined || dispatchReport === undefined) return out;
  for (const failedId of dispatchReport.failed) {
    const contract = chart.contracts.find((c) => c.id === failedId);
    if (contract === undefined) continue;
    const failedResult = dispatchReport.results.find((r) => r.contractId === failedId);
    const record = escalateContract(chart, failedId, failedResult?.error);
    const outcome = await runBoundedEscalation({
      record,
      attemptRescope: async () => {
        // Budget-checked: no budget → accept the gap without a turn (never hang).
        if (!chargeTurn(params.budget)) {
          params.onBudgetOut();
          return false;
        }
        params.turnsByPurpose.rescope += 1;
        try {
          await params.chat({
            purpose: 'rescope',
            messages: [
              { role: 'system', content: getRolePrompt('manager').prompt },
              { role: 'user', content: buildManagerRescopePrompt(contract, record.reason) },
            ],
            thinking: roleThinkingEnabled('manager'),
            maxTokens: params.genMaxTokens,
          });
        } catch (err) {
          params.errors.push({ purpose: 'rescope', message: errorMessage(err) });
        }
        // Bounded: this pass does not re-dispatch, so the gap is accepted.
        return false;
      },
    });
    out.push({
      contractId: record.contractId,
      ownerManager: record.ownerManager,
      reason: record.reason,
      acceptedGap: outcome.acceptedGap,
    });
  }
  return out;
}
