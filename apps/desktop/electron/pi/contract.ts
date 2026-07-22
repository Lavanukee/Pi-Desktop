/**
 * pi engine IPC contract (W2 wire-up stub). Composed into the app-wide maps in
 * ../ipc-contract.ts. Type-only imports keep the engine's runtime out of the
 * sandboxed preload bundle.
 */
import type {
  AgentMessage,
  BashResult,
  ExtensionUiAnswer,
  ImageContent,
  Model,
  PiBridgeEvent,
  RpcSessionState,
  RpcSlashCommand,
} from '@pi-desktop/engine';

/** Structured ack for commands whose payload the renderer doesn't need.
 * Errors come back as data (not thrown) so callers get clean typed handling
 * across the IPC boundary. */
export interface PiCommandAck {
  success: boolean;
  error?: string;
}

export type PiInvokeMap = {
  /** Spawn (or reuse) the window's pi child and await first-event readiness.
   * `conversationId` (Wave D) roots a projectless conversation at its own
   * `~/.pi/desktop/sandbox/<conversationId>/` sandbox when no `cwd`/`sessionPath`
   * is given (see electron/sandbox.ts); an explicit `cwd` still wins. */
  'pi:start': {
    request: { cwd?: string; sessionPath?: string; conversationId?: string };
    response: { pid: number; alreadyRunning: boolean };
  };
  'pi:prompt': {
    request: { message: string; images?: ImageContent[]; streamingBehavior?: 'steer' | 'followUp' };
    response: PiCommandAck;
  };
  'pi:steer': { request: { message: string }; response: PiCommandAck };
  'pi:abort': { request: undefined; response: PiCommandAck };
  'pi:set-model': { request: { provider: string; modelId: string }; response: PiCommandAck };
  /** Rename the active session (set_session_name RPC — the top-bar inline
   * rename). Best-effort: a no-pi session just returns success:false. */
  'pi:set-session-name': { request: { name: string }; response: PiCommandAck };
  /** Answer a blocking extension_ui_request dialog. */
  'pi:respond-ui': {
    request: { id: string; answer: ExtensionUiAnswer };
    response: { delivered: boolean };
  };
  'pi:get-messages': {
    request: undefined;
    response: { success: boolean; messages: AgentMessage[]; error?: string };
  };
  'pi:switch-session': {
    request: { sessionPath: string };
    response: PiCommandAck & { cancelled?: boolean };
  };
  /** Start a fresh session INSIDE the running pi (`new_session` RPC) — the
   * New-chat action. No dispose/respawn: same pid, no "pi exited" crash toast,
   * and nothing new spawned in the dock. `cancelled` reflects an extension veto. */
  'pi:new-session': {
    request: { parentSession?: string } | undefined;
    response: PiCommandAck & { cancelled?: boolean };
  };
  /** Fork a new branch at a user message's entry (mirrors the `fork` RPC).
   * Returns the forked message's text; pi switches its active session to the
   * new branch (a fresh session file whose leaf is the forked message's
   * parent). `cancelled` reflects a `session_before_fork` extension veto. */
  'pi:fork': {
    request: { entryId: string };
    response: { success: boolean; text?: string; cancelled?: boolean; error?: string };
  };
  /** User messages available for forking on pi's active branch, in order
   * (`get_fork_messages` RPC). Maps a rendered user message → its entryId. */
  'pi:get-fork-messages': {
    request: undefined;
    response: {
      success: boolean;
      messages: Array<{ entryId: string; text: string }>;
      error?: string;
    };
  };
  'pi:get-state': {
    request: undefined;
    response: { success: boolean; state?: RpcSessionState; error?: string };
  };
  'pi:get-models': {
    request: undefined;
    response: { success: boolean; models: Model[]; error?: string };
  };
  /** Slash commands for the composer autocomplete (get_commands RPC). */
  'pi:get-commands': {
    request: undefined;
    response: { success: boolean; commands: RpcSlashCommand[]; error?: string };
  };
  /** Composer `!` bash mode: one-shot bash outside the agent turn. */
  'pi:bash': {
    request: { command: string };
    response: { success: boolean; result?: BashResult; error?: string };
  };
  /** Force a fresh pi child even when the current one is alive-but-wedged
   * (dispose → whenExited → respawn); pi:start short-circuits on a live bridge. */
  'pi:restart': {
    request: { cwd?: string; sessionPath?: string; conversationId?: string } | undefined;
    response: { success: boolean; pid?: number; error?: string };
  };

  // ── Child agents (subagents / roles as their own app-owned pi instances) ─────
  /** Spawn an app-owned `pi --mode rpc` instance for a subagent/role and drive
   * it with `goal`. Its events stream to the renderer over `pi:child-event`
   * tagged with `childId`, so it renders as a nested chat under `parentId`. */
  'pi:child-spawn': {
    request: { childId: string; parentId: string; title: string; goal: string; cwd?: string };
    response: { success: boolean; pid?: number; error?: string };
  };
  /** Tear down a child agent's pi instance. */
  'pi:child-dispose': { request: { childId: string }; response: PiCommandAck };
  /** The child agents currently alive for this window (sidebar dropdown data). */
  'pi:child-list': {
    request: undefined;
    response: { children: Array<{ childId: string; parentId: string; title: string }> };
  };
};

/** One child-agent record for the sidebar dropdown. */
export interface ChildAgentInfo {
  childId: string;
  parentId: string;
  title: string;
}

/** A single child pi instance's bridge event, tagged so the renderer folds it
 * into that child's own transcript (a nested chat). Carries the title so the
 * renderer can name the child from its first event, no pre-seeding required. */
export interface ChildAgentEvent {
  childId: string;
  parentId: string;
  title: string;
  event: PiBridgeEvent;
}

/** Runtime list of every pi invoke channel, composed into the preload
 * allowlist (../ipc-contract.ts). `satisfies` checks membership; the
 * exhaustiveness assertion lives beside APP_INVOKE_CHANNELS. */
export const PI_INVOKE_CHANNELS = [
  'pi:start',
  'pi:prompt',
  'pi:steer',
  'pi:abort',
  'pi:set-model',
  'pi:set-session-name',
  'pi:respond-ui',
  'pi:get-messages',
  'pi:switch-session',
  'pi:new-session',
  'pi:fork',
  'pi:get-fork-messages',
  'pi:get-state',
  'pi:get-models',
  'pi:get-commands',
  'pi:bash',
  'pi:restart',
  'pi:child-spawn',
  'pi:child-dispose',
  'pi:child-list',
] as const satisfies readonly (keyof PiInvokeMap)[];

export type PiEventMap = {
  /** Every bridge event for this window, verbatim (renderer router consumes). */
  'pi:event': PiBridgeEvent;
  /** A child agent's bridge event, tagged with its childId/parentId so the
   * renderer folds it into that child's own transcript (a nested chat). */
  'pi:child-event': ChildAgentEvent;
};
