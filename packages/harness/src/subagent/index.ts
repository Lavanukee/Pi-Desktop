/** Barrel for the subagent feature: budget, child-agent runner, scheduler, tool. */
export {
  type BudgetInputs,
  type ConcurrencyBudget,
  computeConcurrencyBudget,
  DEFAULT_HARD_CAP,
  DEFAULT_PER_AGENT_GB,
  DEFAULT_RESERVE_GB,
  detectBudget,
  type HostProbe,
  LOW_RAM_GB,
} from './budget.js';
export {
  buildChildSpawnPlan,
  type ChildAgentResult,
  type ChildLike,
  type ChildSpawnOverrides,
  type ChildSpawnPlan,
  extractExtensionPaths,
  type RunChildAgentOptions,
  runChildAgent,
  type SpawnLike,
} from './child-agent.js';
export {
  type SchedulerOptions,
  type SchedulerSnapshot,
  type SubagentRecord,
  type SubagentRunner,
  type SubagentRunOutcome,
  SubagentScheduler,
  type SubmitResult,
  type SubmitSpec,
} from './scheduler.js';
export {
  deriveSubagentName,
  registerSubagentTool,
  SPAWN_SUBAGENT_TOOL_NAME,
  type SubagentToolDeps,
} from './subagent-tool.js';
export {
  HARNESS_SUBAGENTS_STATUS_KEY,
  type HarnessSubagentsStatus,
  MAX_SUBAGENT_DEPTH,
  readSubagentDepth,
  SUBAGENT_DEPTH_ENV,
  type SubagentStatus,
  type SubagentStatusItem,
} from './types.js';
