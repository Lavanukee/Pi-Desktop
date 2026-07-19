/**
 * Connects the pi event stream to the renderer store: IPC events →
 * event router → StoreSink (pi-slice). Also installs the `window.__pi_store`
 * test hook and exposes the thin invoke wrappers the chat UI calls.
 */
import { createEventRouter, type ImageContent, rehydrateSessionJsonl } from '@pi-desktop/engine';
import type { TaskClass } from '@pi-desktop/harness';
import { maybeRouteAuto } from '../chat/auto-router';
import { resetCanvasForNewSession } from './canvas-store';
import { ensureVisionMode } from './local-model';
import { createPiSink, usePiStore } from './pi-slice';
import { useSettingsStore } from './settings-store';

/** An outgoing message's vision-relevant shape (pure helper input). */
export interface OutgoingMessage {
  /** `data:<mime>;base64,…` image attachments the composer produced. */
  readonly imageDataUris?: readonly string[];
}

/**
 * Pure: does this outgoing message carry an image attachment? An image can only
 * be seen by a vision-capable model launched in multimodal mode, so a `true`
 * here is the on-demand-vision trigger (see {@link ensureVisionMode}).
 */
export function messageNeedsVision(msg: OutgoingMessage): boolean {
  return (msg.imageDataUris?.length ?? 0) > 0;
}

/**
 * True when a turn is IN FLIGHT — either the agent is actively streaming or a
 * follow-up is queued behind it. While in flight the running model is LOCKED for
 * the task: neither the Auto router nor the on-demand vision relaunch may
 * hard-restart llama (a restart would kill the in-progress generation). The switch
 * waits for the next clean idle boundary; only an EXPLICIT user model change is
 * allowed to restart mid-task. Read live off the pi-slice so any send path
 * (composer, edit-fork, programmatic resend) observes the same lock.
 */
export function agentInFlight(): boolean {
  const agent = usePiStore.getState().agent;
  return agent.isStreaming || agent.pendingMessageCount > 0;
}

let disconnect: (() => void) | null = null;

/**
 * Custom-instructions seam. The frozen harness/pi exposes no system-prompt-suffix
 * channel (before_agent_start only classifies; the RPC `prompt` command has no
 * system field), so the cleanest available seam is to PREPEND the user's saved
 * custom instructions to the FIRST prompt of each fresh session, wrapped in a
 * clearly-labeled block. It is armed on a new/fresh session start (startPi /
 * restartPi with no sessionPath) and consumed by the first sendPrompt; switching
 * into an existing session disarms it (those turns already carry their history).
 * The user's chat bubble echo is unaffected — only pi's copy gets the preamble.
 */
let instructionsArmed = false;

function armSessionInstructions(): void {
  instructionsArmed = true;
}

/** Consume the armed flag, returning `message` with the custom-instructions
 * preamble prepended when one is pending and configured. */
function withPendingInstructions(message: string): string {
  if (!instructionsArmed) return message;
  instructionsArmed = false;
  const instructions = useSettingsStore.getState().settings.customInstructions.trim();
  if (instructions.length === 0) return message;
  return `<user-instructions>\n${instructions}\n</user-instructions>\n\n${message}`;
}

export function connectPi(): () => void {
  if (disconnect !== null) return disconnect;
  const router = createEventRouter(createPiSink());
  // Subscribing at module-init time (pre-mount) — the preload event hub
  // buffers anything main pushed before this point and flushes it here.
  const unsubscribe = window.piDesktop.onEvent('pi:event', (event) => router.handleEvent(event));
  disconnect = () => {
    unsubscribe();
    disconnect = null;
  };
  return disconnect;
}

/**
 * Stable id for THIS conversation surface (Wave D). When no project/working
 * folder is selected, main roots the pi child at this conversation's own
 * `~/.pi/desktop/sandbox/<id>/` sandbox (see electron/sandbox.ts + pi-main) so
 * a bare "make me a file" lands in a dedicated folder rather than the user's
 * HOME. Persisted in sessionStorage so a window reload keeps the same sandbox;
 * a new window is a new conversation and mints a fresh id. (Note: a projectless
 * "New chat" reuses the same sandbox — pi's cwd is fixed at spawn and
 * new_session deliberately never respawns.)
 */
const CONVERSATION_ID_KEY = 'pi-desktop:conversationId';
let conversationIdCache: string | null = null;

function mintConversationId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to the non-crypto fallback */
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function conversationId(): string {
  if (conversationIdCache !== null) return conversationIdCache;
  let store: Storage | null = null;
  try {
    store = typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    store = null; // storage can throw under strict privacy settings
  }
  const existing = store?.getItem(CONVERSATION_ID_KEY) ?? null;
  const id = existing ?? mintConversationId();
  if (existing === null) {
    try {
      store?.setItem(CONVERSATION_ID_KEY, id);
    } catch {
      /* unavailable — the in-memory cache still keeps it stable this session */
    }
  }
  conversationIdCache = id;
  return id;
}

export async function startPi(opts: { cwd?: string; sessionPath?: string } = {}) {
  // A fresh session (no explicit sessionPath) should adopt the saved custom
  // instructions on its first prompt.
  if (opts.sessionPath === undefined) armSessionInstructions();
  // Always carry the conversation id so main can root a projectless session at
  // its dedicated sandbox; an explicit `cwd` in `opts` still wins downstream.
  return window.piDesktop.invoke('pi:start', { conversationId: conversationId(), ...opts });
}

/** Force a fresh pi child (dispose → whenExited → respawn) — the recovery path
 * for a wedged bridge (pi:start returns the live-but-stuck one) and the
 * model-switch seam (afm/local-model respawn to re-read models.json). NOT the
 * New-chat path anymore — that uses newSession(), which never respawns. */
export async function restartPi(
  opts: { cwd?: string; sessionPath?: string } | undefined = undefined,
) {
  // A new-chat restart (no sessionPath) re-arms custom instructions; a restart
  // that re-opens a specific session (e.g. to apply search keys) does not.
  if (opts?.sessionPath === undefined) armSessionInstructions();
  // Mark the dispose+respawn as DELIBERATE so the pi-exit it triggers is not
  // surfaced as a crash toast (model switch, search-key apply, recovery
  // restart). The pi-slice consumes this flag on the paired bridge-exit; the
  // finally clears it for the already-dead-bridge case (recovery restart after
  // a real crash), where no fresh exit event fires to consume it.
  usePiStore.setState({ intentionalRestart: true });
  try {
    // Same conversation id as the initial spawn: a projectless respawn (project
    // cleared, model switch with no session to resume) lands back in this
    // conversation's sandbox rather than HOME.
    return await window.piDesktop.invoke('pi:restart', {
      conversationId: conversationId(),
      ...(opts ?? {}),
    });
  } finally {
    usePiStore.setState({ intentionalRestart: false });
  }
}

/**
 * New chat: start a fresh session INSIDE the running pi (`new_session` RPC).
 * Unlike restartPi this does NOT dispose/respawn the child — pi keeps the same
 * pid, no "pi exited" crash toast fires, and nothing new appears in the dock. It
 * resets the rendered thread + transient run state, re-arms the saved custom
 * instructions for the fresh session's first prompt (round-4 armed this on the
 * old restart path), and points the store at pi's new session.
 */
export async function newSession(): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
  const res = await window.piDesktop.invoke('pi:new-session', undefined);
  // Reset the rendered thread + transient run/branch state to the fresh session
  // (also clears any stale bridgeExited/notifications). Unconditional so New
  // chat always yields a clean slate, even if the RPC failed.
  usePiStore.getState().setMessagesExternal([]);
  // Session isolation (backlog #2): a new conversation gets its OWN clean canvas
  // — drop the previous chat's accumulated tabs + close the rail so canvases
  // don't pile up across "separate" chats.
  resetCanvasForNewSession();
  if (!res.success) return { ok: false, error: res.error };
  if (res.cancelled === true) return { ok: true, cancelled: true };
  // A fresh session adopts the saved custom instructions on its first prompt.
  armSessionInstructions();
  // Sync the store's session id/file to pi's new session so the sidebar refresh
  // trigger + selected-row highlight track it (pi emits no session event here).
  const state = await getPiState();
  if (state.success && state.state !== undefined) {
    usePiStore.setState((s) => ({
      session: {
        ...s.session,
        sessionFile: state.state?.sessionFile,
        sessionId: state.state?.sessionId,
      },
    }));
  }
  return { ok: true };
}

/** `data:<mime>;base64,<data>` → pi ImageContent. */
function dataUriToImage(uri: string): ImageContent | null {
  const match = uri.match(/^data:([^;]+);base64,(.*)$/s);
  if (match === null) return null;
  return { type: 'image', mimeType: match[1] ?? 'image/png', data: match[2] ?? '' };
}

/**
 * Sends a prompt with a local user-message echo (the RPC has no user event).
 * `agentMessage` decouples what pi receives from what the bubble shows — the
 * composer uses it to fold attached text-file contents into pi's copy without
 * bloating the visible bubble. The custom-instructions preamble (if armed) is
 * applied to pi's copy only.
 */
export async function sendPrompt(
  message: string,
  imageDataUris: string[] = [],
  agentMessage?: string,
  forcedClass?: TaskClass,
) {
  usePiStore.getState().appendUser(message, imageDataUris);
  // Capture the session boundary: the awaits below can hard-restart llama (a vision
  // relaunch or an Auto tier switch), and if the user switches / starts a new chat
  // during that window, this prompt must NOT land in the new chat (BUG: sent message
  // appeared in a freshly-started chat).
  const epochAtSend = usePiStore.getState().sessionEpoch;

  // Did the on-demand vision relaunch fail to give us a model that can SEE? (Only
  // relevant on an image turn.) If so, we must not dispatch the image — a text-only
  // llama-server just drops the request → a bare "fetch failed".
  let visionUnavailable = false;
  let visionReason: string | undefined;
  if (messageNeedsVision({ imageDataUris })) {
    // Round-12 on-demand VISION (ask #3): an image needs a multimodal model. Relaunch
    // the current model (or a vision-capable pick) BEFORE dispatch — sticky, restart-
    // based. Gated by the in-flight lock (a vision relaunch is a hard restart; the
    // composer routes an in-flight send to steerPrompt instead). The result is now
    // CHECKED (previously ignored, which is why images 'fetch failed' on a text model):
    // ok:false covers both "no vision model" and "the mmproj download/relaunch failed".
    if (!agentInFlight()) {
      const vision = await ensureVisionMode();
      visionUnavailable = !vision.ok;
      visionReason = vision.reason;
    }
  } else {
    // Round-12 Auto router (W3): when the selection is Auto, classify this prompt and
    // switch the running model to the routed tier BEFORE dispatch. Awaited; no-op
    // unless mode==='auto'; never throws.
    await maybeRouteAuto(agentMessage ?? message, { hasImages: false, forcedClass });
  }

  // ONE guard after all the awaits: a session switch raced us → drop this send (the
  // echo was appended to the now-cleared old session; do NOT dispatch into the new one).
  if (usePiStore.getState().sessionEpoch !== epochAtSend) return;

  if (visionUnavailable) {
    const detail = visionReason !== undefined && visionReason !== '' ? ` (${visionReason})` : '';
    usePiStore
      .getState()
      .appendAssistantText(
        `I can't see images right now${detail}. Download a vision-capable model in Settings → Models and resend, or send the message without the image.`,
      );
    return;
  }

  const images = imageDataUris
    .map(dataUriToImage)
    .filter((img): img is ImageContent => img !== null);
  return window.piDesktop.invoke('pi:prompt', {
    message: withPendingInstructions(agentMessage ?? message),
    ...(images.length > 0 ? { images } : {}),
  });
}

export async function steerPrompt(message: string, agentMessage?: string) {
  usePiStore.getState().appendUser(message);
  return window.piDesktop.invoke('pi:prompt', {
    message: agentMessage ?? message,
    streamingBehavior: 'steer',
  });
}

export async function abortPi() {
  return window.piDesktop.invoke('pi:abort', undefined);
}

export async function setModel(provider: string, modelId: string) {
  return window.piDesktop.invoke('pi:set-model', { provider, modelId });
}

/**
 * Rename the active pi session (top-bar inline rename → `set_session_name` RPC).
 * Optimistically pushes the new name to `windowTitle` so the title reflects the
 * edit immediately (pi doesn't reliably echo a title event for a rename), then
 * persists it to the session. Best-effort: a no-pi session keeps the local echo.
 *
 * A user rename LOCKS the title (`titleLocked`) so the harness's auto-generated
 * title can no longer overwrite it — the lock resets on the next session change.
 */
export async function setSessionName(name: string) {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { success: false, error: 'empty name' };
  usePiStore.setState({ windowTitle: trimmed, titleLocked: true });
  return window.piDesktop.invoke('pi:set-session-name', { name: trimmed });
}

/**
 * Apply the harness's auto-generated conversation title to the active session
 * (sidebar + top-bar). Unlike {@link setSessionName} this does NOT lock the
 * title — a subsequent user rename still wins. Persisted via the same RPC so a
 * reload / the sidebar list reflects it. Gated by `useHarnessTitleSync` (which
 * checks the user-rename lock), so it never clobbers a user-chosen name.
 */
export async function applyHarnessTitle(name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return;
  usePiStore.setState({ windowTitle: trimmed });
  await window.piDesktop.invoke('pi:set-session-name', { name: trimmed }).catch(() => {});
}

/**
 * Push permission-mode / effort into the running harness. The frozen harness
 * only takes runtime config through its `/harness` slash commands, so we send
 * them as command messages (no local user echo — the RPC has no user event, so
 * nothing appears as a chat bubble). Best-effort: a session without the harness
 * loaded simply ignores them. Called on settings change and on session start so
 * a fresh pi adopts the saved config.
 */
export async function applyHarnessConfig(opts: {
  permissionMode?: 'bypass' | 'reviewer' | 'review-all';
  effort?: 'low' | 'medium' | 'high' | 'max';
}): Promise<void> {
  const messages: string[] = [];
  if (opts.permissionMode !== undefined) messages.push(`/harness set-mode ${opts.permissionMode}`);
  if (opts.effort !== undefined) messages.push(`/harness effort ${opts.effort}`);
  for (const message of messages) {
    await window.piDesktop.invoke('pi:prompt', { message }).catch(() => {});
  }
}

/**
 * Push the classifier preset into the running harness (`/harness preset <x>`).
 * `auto` restores the tier-1 classifier; any task class pins that preset. Same
 * best-effort slash-command transport as {@link applyHarnessConfig} (no user
 * echo; a no-harness session ignores it). The harness republishes its status so
 * the UI's active-class reflects the change.
 */
export async function applyHarnessPreset(preset: string): Promise<void> {
  await window.piDesktop
    .invoke('pi:prompt', { message: `/harness preset ${preset}` })
    .catch(() => {});
}

export async function getModels() {
  return window.piDesktop.invoke('pi:get-models', undefined);
}

export async function getPiState() {
  return window.piDesktop.invoke('pi:get-state', undefined);
}

/** entryId of the user message at `ordinal` on pi's active branch, or null.
 * get_fork_messages returns user messages in session order, matching the order
 * of user bubbles in the thread — so the ordinal indexes straight in. */
async function forkEntryIdForOrdinal(ordinal: number): Promise<string | null> {
  const res = await window.piDesktop.invoke('pi:get-fork-messages', undefined);
  if (!res.success) return null;
  return res.messages[ordinal]?.entryId ?? null;
}

/**
 * Edit → fork: fork a fresh pi branch at the edited user message, trim the
 * thread back to that point, and stream the edited turn into the new branch —
 * which becomes the active alternate (BranchSwitcher shows the new total).
 * Falls back to a plain edit-and-continue resend whenever forking isn't
 * available (entry can't be resolved, an extension vetoes the fork, or pi is
 * gone), so Save always does *something* useful.
 */
export async function forkAndReprompt(messageId: string, editedText: string): Promise<void> {
  const trimmed = editedText.trim();
  if (trimmed.length === 0) return;
  const messages = usePiStore.getState().messages;
  const messageIndex = messages.findIndex((m) => m.id === messageId);
  if (messageIndex < 0) {
    await sendPrompt(trimmed);
    return;
  }
  // Ordinal of this user message among all user messages in the thread.
  let ordinal = -1;
  for (let i = 0; i <= messageIndex; i++) if (messages[i]?.kind === 'user') ordinal++;

  const entryId = await forkEntryIdForOrdinal(ordinal);
  if (entryId === null) {
    await sendPrompt(trimmed);
    return;
  }

  const before = await getPiState();
  const baseFile = before.success ? (before.state?.sessionFile ?? null) : null;

  const forked = await window.piDesktop.invoke('pi:fork', { entryId });
  if (!forked.success || forked.cancelled === true) {
    await sendPrompt(trimmed);
    return;
  }

  const after = await getPiState();
  const newFile = after.success ? (after.state?.sessionFile ?? null) : null;

  usePiStore
    .getState()
    .commitFork(ordinal, { messageIndex, newFile, baseFile, editedText: trimmed });
  // pi is now on the forked branch; this prompt appends the edited turn there.
  await window.piDesktop.invoke('pi:prompt', { message: trimmed });
}

/** Switch the visible transcript to another fork branch and keep pi's active
 *  session pointed at it (best-effort — the transcript swap is snapshot-driven,
 *  so it works even if switch_session fails or is a no-op). */
export async function switchBranch(ordinal: number, targetIndex: number): Promise<void> {
  const group = usePiStore.getState().branches[ordinal];
  if (group === undefined) return;
  const file = group.files[targetIndex];
  if (typeof file === 'string' && file.length > 0) {
    await window.piDesktop.invoke('pi:switch-session', { sessionPath: file }).catch(() => {});
  }
  usePiStore.getState().switchBranch(ordinal, targetIndex);
}

export async function getCommands() {
  return window.piDesktop.invoke('pi:get-commands', undefined);
}

/** Composer `!` bash mode: runs one command outside the agent turn, echoing a
 * bashExec row into the thread. */
export async function runBash(command: string) {
  const res = await window.piDesktop.invoke('pi:bash', { command });
  if (res.success && res.result !== undefined) {
    usePiStore.getState().appendBashExec(command, res.result.output, res.result.exitCode ?? -1);
  }
  return res;
}

export async function respondUi(
  id: string,
  answer: import('@pi-desktop/engine').ExtensionUiAnswer,
) {
  usePiStore.getState().resolveUiRequest(id);
  return window.piDesktop.invoke('pi:respond-ui', { id, answer });
}

export async function listFiles(cwd: string, query: string, limit = 20) {
  return window.piDesktop.invoke('fs:list-files', { cwd, query, limit });
}

export async function listSessions(cwd?: string) {
  return window.piDesktop.invoke('fs:list-sessions', cwd !== undefined ? { cwd } : undefined);
}

/**
 * Switches pi to another session and rehydrates the thread from its JSONL so
 * history renders immediately (pi does not replay past turns). Surfaces the
 * `truncated` flag from the leaf→root walk so the UI can note a clipped branch.
 */
export async function switchSession(
  sessionPath: string,
): Promise<{ ok: boolean; truncated: boolean; cancelled?: boolean; error?: string }> {
  // Continuing an existing session: its turns already carry their own history,
  // so do not re-inject the custom-instructions preamble.
  instructionsArmed = false;
  const switched = await window.piDesktop.invoke('pi:switch-session', { sessionPath });
  if (!switched.success) return { ok: false, truncated: false, error: switched.error };
  if (switched.cancelled === true) return { ok: false, truncated: false, cancelled: true };
  // Session isolation (backlog #2): switching to another conversation gives it
  // its own clean canvas — clear the tabs the previous session accumulated.
  resetCanvasForNewSession();
  const read = await window.piDesktop.invoke('fs:read-session', { file: sessionPath });
  if (read.text === null) {
    usePiStore.getState().setMessagesExternal([]);
    return { ok: true, truncated: false };
  }
  const { messages, truncated } = rehydrateSessionJsonl(read.text);
  usePiStore.getState().setMessagesExternal(messages);
  return { ok: true, truncated };
}

// E2E hook (load-bearing for W3 + the pi probe): expose the store accessor on
// window, but only when the probe opted in — main.ts appends ?piE2E=1 to the
// load when PI_E2E=1 (see window-policy.ts; pi-probe.mjs sets the env var).
// Same-context code can reach the store anyway, so this is not a privilege
// boundary; gating just keeps production builds from shipping a stable
// read/tamper handle to the whole chat state.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E')) {
  window.__pi_store = () => usePiStore;
}
