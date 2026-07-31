/**
 * Connects the pi event stream to the renderer store: IPC events →
 * event router → StoreSink (pi-slice). Also installs the `window.__pi_store`
 * test hook and exposes the thin invoke wrappers the chat UI calls.
 */
import type { CanvasState } from '@pi-desktop/canvas';
import {
  type AssistantMsg,
  type ChatMsg,
  createEventRouter,
  type ImageContent,
  rehydrateSessionJsonl,
} from '@pi-desktop/engine';
import type { TaskClass } from '@pi-desktop/harness';
import { createResumeSplitter, type ResumeEvent } from '@pi-desktop/provider-llamacpp/resume';
import { ensureChatServerReady, maybeRouteAuto } from '../chat/auto-router';
import { ADVANCED_GROUNDTRUTH_KEY } from './advanced-store';
import { resetCanvasForNewSession, restoreCanvas, snapshotCanvas } from './canvas-store';
import { renameChat } from './chat-org';
import { ensureVisionMode } from './local-model';
import {
  type BgRun,
  createPiSink,
  createQueueDrain,
  type PausedChat,
  type QueuedSend,
  usePiStore,
} from './pi-slice';
import { useSettingsStore } from './settings-store';
import { appendOrMergeBlock, mutateAssistant } from './transcript-fold';

/** A resume continuation's raw partial-block shape (matches the IPC contract +
 * the adapter's `PartialBlock`), mapped from the frozen reply's ChatMsg blocks. */
type ResumePartialBlock = { type: 'text'; text: string } | { type: 'thinking'; thinking: string };

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

/**
 * Invalidate any PRE-DISPATCH send parked mid-await (promptInFlight, not yet
 * streaming). `sendPrompt` snapshots `sessionEpoch` before its awaits and drops
 * the dispatch if the epoch moved; bumping it the instant the user switches /
 * starts a chat guarantees a parked send can never land in the session we're
 * about to point pi at — the "the message I sent showed up in the chat I flipped
 * to" bug. Cheap and safe: the epoch also bumps in `setMessagesExternal`, so a
 * double-bump here is a no-op beyond dropping the stale send.
 */
function invalidateInFlightSend(): void {
  usePiStore.setState((s) => ({ sessionEpoch: s.sessionEpoch + 1 }));
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

/** A "New chat" opened while another chat was still streaming: pi stays pinned to
 * the streaming chat (backgrounded), and the fresh pi session is DEFERRED — created
 * lazily on this new chat's first send (once the running chat finishes), because
 * `pi:new-session` would otherwise dispose the running turn. See newSession +
 * ensurePiOnViewedSession. */
let pendingNewSession = false;

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

  // Drain queued sends whenever the pipe is IDLE. A message typed while a turn was
  // in-flight (or while another chat streams in the background) is held in the
  // store (ChatComposer) and dispatched here as its OWN sequential turn the moment
  // there's capacity. The idle predicate + the FIFO/latch/restore semantics live
  // in pi-slice (`createQueueDrain`) where they are unit-testable; this only binds
  // the dispatcher.
  const unsubscribeQueue = usePiStore.subscribe(
    createQueueDrain((head) =>
      sendPrompt(
        head.text,
        head.images,
        head.agentMessage,
        head.taskClass as TaskClass | undefined,
      ),
    ),
  );

  // Report the viewed chat's session to main so a model-spawned subagent
  // (spawn_subagent → app bridge) nests under it in the sidebar dropdown.
  let lastReportedSession = '';
  const unsubscribeSession = usePiStore.subscribe((state) => {
    const file = state.session?.sessionFile ?? '';
    if (file === lastReportedSession) return;
    lastReportedSession = file;
    void window.piDesktop.invoke('pi:report-active-session', { sessionFile: file });
  });

  disconnect = () => {
    unsubscribe();
    unsubscribeQueue();
    unsubscribeSession();
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
    // NOT synchronously. The bridge-exit event is delivered over IPC and can land
    // a tick or two AFTER `pi:restart` resolves — clearing the flag here raced it,
    // and the deliberate restart then surfaced as a crash notice. Hold the flag
    // briefly so the paired exit can consume it; the timer is the backstop for the
    // already-dead-bridge case (recovery after a real crash), where no fresh exit
    // event ever arrives to consume it.
    setTimeout(() => usePiStore.setState({ intentionalRestart: false }), 3000);
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
  const store = usePiStore.getState();
  const bg = store.bgRun;
  const viewed = store.session?.sessionFile ?? null;
  const activeStreaming = store.agent.isStreaming || store.promptInFlight;

  // A chat is streaming — the viewed one, OR one already in the background. Open a
  // DEFERRED new chat WITHOUT touching pi: `pi:new-session` would dispose the
  // running turn (killing the reply + popping a false "finished"). Keep pi pinned
  // to the running chat; the fresh pi session is created lazily on this chat's
  // first send (ensurePiOnViewedSession), which queues until that chat finishes.
  if (activeStreaming || bg?.streaming === true) {
    captureCurrentSession();
    if (activeStreaming && bg === null && viewed !== null) {
      usePiStore.setState({
        bgRun: {
          sessionFile: viewed,
          messages: usePiStore.getState().messages,
          streaming: true,
          title: store.windowTitle,
        },
      });
    }
    pendingNewSession = true;
    usePiStore.getState().setMessagesExternal([]);
    resetCanvasForNewSession();
    armSessionInstructions();
    // No pi session yet — a null pointer so nothing dispatches into the bg chat.
    usePiStore.setState((s) => ({
      session: { ...(s.session ?? {}), sessionFile: undefined, sessionId: undefined },
    }));
    return { ok: true };
  }

  // Preserve the chat we're leaving (its messages + canvas) so it restores on
  // return, and halt any in-flight turn so it can't leak into the new chat.
  captureCurrentSession();
  // Drop any parked pre-dispatch send so it can't fire into the fresh session.
  invalidateInFlightSend();
  if (agentInFlight()) await abortPi();
  pendingNewSession = false;
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
  // A chat is still streaming in the BACKGROUND ⇒ pi is busy on another session.
  // Queue this send for the viewed chat rather than dispatch it into the background
  // one (the composer normally queues first; this is the safety net for the drain /
  // programmatic callers). No echo here — it shows as a queued bubble.
  const bgNow = usePiStore.getState().bgRun;
  if (bgNow?.streaming === true) {
    usePiStore.getState().enqueueSend({
      text: message,
      images: imageDataUris,
      ...(agentMessage !== undefined ? { agentMessage } : {}),
      ...(forcedClass !== undefined ? { taskClass: forcedClass } : {}),
    });
    return;
  }
  // Echo the user's message IMMEDIATELY (before any awaits) — a fresh send inits
  // the chat + shows the bubble at once, never "delete the text, wait 60s, then
  // show it" (jedd). Safe because a server-load restart (restartPi) preserves the
  // local thread and does NOT bump the session epoch, so the echo survives the
  // ensureChatServerReady wait below.
  usePiStore.getState().appendUser(message, imageDataUris);
  // Mark in-flight the instant we accept the send (before the awaits below, which
  // can be a multi-second vision relaunch). This bridges the dispatch→agent_start
  // gap so a 2nd message sent during it STEERS instead of racing in as a fresh
  // send (which reorders the echoes ahead of the first assistant turn). Cleared by
  // agent_start / agent_end, and on every early return below.
  usePiStore.setState({ promptInFlight: true });
  // pi may be parked on a chat that finished streaming in the background — move it
  // onto the viewed chat (saving the finished bg thread) before we dispatch.
  await ensurePiOnViewedSession();
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
    // Guarantee the selected model's server is up + the model is loaded before we
    // POST — otherwise pi fetches a dead/loading endpoint → "fetch failed" / 503.
    // WAITS for a loading server (never restarts it); starts one only if none is
    // coming up. The echo is already on screen, so this wait is visible as the
    // model-loading indicator, not a blank pause.
    await ensureChatServerReady();
  }

  // ONE guard after all the awaits: a session switch raced us → drop this send (the
  // echo was appended to the now-cleared old session; do NOT dispatch into the new one).
  if (usePiStore.getState().sessionEpoch !== epochAtSend) {
    usePiStore.setState({ promptInFlight: false });
    return;
  }

  if (visionUnavailable) {
    usePiStore.setState({ promptInFlight: false });
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
  const body = {
    message: withPendingInstructions(agentMessage ?? message),
    ...(images.length > 0 ? { images } : {}),
  };
  // Re-check RIGHT HERE, not just at the composer's gate: everything above can
  // await for seconds (a vision relaunch, an Auto tier switch, waiting for the
  // server), so a turn may have started since this send was accepted. Dispatching
  // a bare prompt into a busy pi is REJECTED ("Agent is already processing…"),
  // which stranded the echo as a user bubble with no reply and raised a red toast
  // (jedd's blank-gap repro). `followUp` is pi's own supported way to queue it,
  // and it preserves the ordering we want: [msg1, reply1, msg2, reply2].
  const ack = await window.piDesktop.invoke('pi:prompt', {
    ...body,
    ...(agentInFlight() ? { streamingBehavior: 'followUp' as const } : {}),
  });
  // Belt and braces for any race the check above still loses (pi's view of busy
  // is authoritative, ours is a mirror): retry once as a follow-up instead of
  // surfacing the rejection.
  if (ack?.success === false && /already processing/i.test(ack.error ?? '')) {
    return window.piDesktop.invoke('pi:prompt', { ...body, streamingBehavior: 'followUp' });
  }
  return ack;
}

export async function steerPrompt(message: string, agentMessage?: string) {
  usePiStore.getState().appendUser(message);
  return window.piDesktop.invoke('pi:prompt', {
    message: agentMessage ?? message,
    streamingBehavior: 'steer',
  });
}

export async function abortPi() {
  // Stopping interrupts the current turn AND drops anything queued behind it —
  // the user asked to halt, so pending messages must not fire after the abort.
  const resuming = usePiStore.getState().resuming;
  // `promptInFlight: false` for the same reason as {@link pausePi}: a stop during
  // the dispatch→agent_start gap has no turn for pi to end, so nothing else ever
  // lowers the flag and the composer stays stuck showing Stop.
  usePiStore.setState({ queuedSends: [], pausedChat: null, promptInFlight: false });
  // Stop pressed DURING a token-exact resume: there's no pi turn to abort — cancel
  // the direct `/completion` continuation instead. Discards resumability (Stop).
  if (resuming) {
    usePiStore.setState({ resuming: false });
    return window.piDesktop.invoke('pi:resume-abort', undefined);
  }
  return window.piDesktop.invoke('pi:abort', undefined);
}

/**
 * Halt the CURRENT turn but KEEP the queue — the "Why isn't my message sending?"
 * modal's Stop. Stopping the running chat there is meant to FREE the slot so the
 * user's queued message goes through, so (unlike {@link abortPi}) it must not drop
 * the queue. A background run ends → the drain switches pi over + sends the queued
 * message; the same-chat case simply ends the current reply and the queue drains.
 */
export async function stopRunningForQueue(): Promise<void> {
  // Lower the dispatch bridge (see {@link pausePi}) — this path exists PURELY to
  // let the queue through, and a stuck `promptInFlight` is exactly what stops the
  // drain from running.
  usePiStore.setState({ pausedChat: null, promptInFlight: false });
  await window.piDesktop.invoke('pi:abort', undefined);
}

/**
 * PAUSE the current turn (distinct from Stop): halt generation to free the local
 * model, but — unlike {@link abortPi} — KEEP any queued sends so they can now go
 * through, and record the chat as paused (with its last user prompt) so a Resume
 * affordance can continue it. The frozen partial reply is left in the thread. This
 * is the "free the model for another message, but I may come back to this reply"
 * control jedd asked for, sitting left of Stop in the composer + the queue modal.
 *
 * The pause aborts the generation but the slot's KV (system+history+user+partial)
 * stays resident, which is what lets {@link resumePausedChat} continue the reply
 * TOKEN-EXACT rather than regenerate it.
 */
export async function pausePi(): Promise<void> {
  const store = usePiStore.getState();
  const lastUser = [...store.messages].reverse().find((m) => m.kind === 'user');
  const userText = lastUser !== undefined && lastUser.kind === 'user' ? lastUser.text : '';
  usePiStore.setState({
    pausedChat: { sessionFile: store.session?.sessionFile ?? null, userText },
    /*
     * RELEASE THE DISPATCH BRIDGE, ALWAYS.
     *
     * `promptInFlight` is normally cleared by `agent_start` / `agent_end`. Pause
     * can land BEFORE either exists: the composer flips to Stop/Pause the instant
     * Enter is pressed, and a send can sit for seconds in `ensureChatServerReady`
     * before it ever reaches pi. Aborting there is a no-op inside pi (there is no
     * turn), so no `agent_end` is coming — and the flag stays raised forever.
     * A store stuck in-flight is a chat that silently swallows everything after
     * it: the composer queues each new message (it sees a turn in flight) and the
     * drain refuses to dispatch (it sees the same), so the message just sits as a
     * faded bubble that never sends. Clearing it here is safe for the normal case
     * too — the turn we just aborted is over by definition.
     */
    promptInFlight: false,
  });
  // Pausing DURING a token-exact resume: cancel the direct `/completion`
  // continuation (not a pi turn) but stay resumable (pausedChat set above).
  if (store.resuming) {
    usePiStore.setState({ resuming: false });
    await window.piDesktop.invoke('pi:resume-abort', undefined);
    return;
  }
  await window.piDesktop.invoke('pi:abort', undefined);
}

/** The frozen partial assistant reply to continue: the last assistant row that
 * isn't still streaming. Null if the thread has no such row (nothing to continue). */
function frozenPartialAssistant(messages: ChatMsg[]): AssistantMsg | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.kind === 'assistant') return m.isStreaming === true ? null : m;
    if (m.kind === 'user') return null; // hit the prompt without an assistant row
  }
  return null;
}

/** Map a frozen reply's blocks to the resume payload (text/thinking only; a
 * tool-call block is not continued through the `/completion` path). */
function partialBlocksOf(assistant: AssistantMsg): ResumePartialBlock[] {
  const out: ResumePartialBlock[] = [];
  for (const b of assistant.blocks) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'thinking') out.push({ type: 'thinking', thinking: b.thinking });
  }
  return out;
}

/** The EXACT `[system, ...history, user]` the paused turn was sent, from the
 * captured ground truth (the provider's `before_provider_request` snapshot —
 * includes the real system prompt, so the render is token-exact + KV-resident).
 * Null when unavailable → the caller reconstructs from the thread. */
function groundTruthMessages(): Array<Record<string, unknown>> | null {
  const raw = usePiStore.getState().extensionStatus[ADVANCED_GROUNDTRUTH_KEY];
  if (raw === undefined || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as { messages?: unknown };
    return Array.isArray(parsed.messages)
      ? (parsed.messages as Array<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

/** Fallback: reconstruct `[...history, user]` (no system prompt) from the thread,
 * up to but excluding the partial reply. Used only when the ground-truth capture
 * is unavailable — the continuation is still correct (the server re-prefills),
 * just not byte-identical to the never-paused one-shot. */
function reconstructMessages(
  messages: ChatMsg[],
  partialId: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.kind === 'assistant' && m.id === partialId) break;
    if (m.kind === 'user') {
      out.push({ role: 'user', content: m.text });
    } else if (m.kind === 'assistant') {
      const text = m.blocks
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      out.push({ role: 'assistant', content: text });
    }
  }
  return out;
}

let resumeCounter = 0;

/** Re-run the last user prompt as a fresh pi turn (the pre-token-exact fallback),
 * dropping the frozen partial so the new reply replaces it under the same user
 * bubble. Used when there is no partial to continue. */
async function regenerateFromPrompt(text: string): Promise<void> {
  if (text.length === 0) return;
  usePiStore.setState((s) => {
    const messages = [...s.messages];
    const last = messages[messages.length - 1];
    if (last !== undefined && last.kind === 'assistant' && last.isStreaming !== true)
      messages.pop();
    return { messages, promptInFlight: true };
  });
  const epoch = usePiStore.getState().sessionEpoch;
  await ensureChatServerReady();
  if (usePiStore.getState().sessionEpoch !== epoch) {
    usePiStore.setState({ promptInFlight: false });
    return;
  }
  await window.piDesktop.invoke('pi:prompt', { message: text });
}

/**
 * Resume a paused chat by CONTINUING its partial reply TOKEN-EXACT. The pause
 * left the reply's KV resident on the llama-server slot; here we render the exact
 * `[system, ...history, user]` prompt and continue the frozen partial over the
 * raw `/completion` endpoint (via the separated llama.cpp adapter in main),
 * streaming the continuation tokens straight into the SAME assistant message —
 * so the reply seamlessly picks up where it stopped, no duplicate echo, no
 * regeneration. Falls back to re-running the prompt when there is no partial to
 * continue. A no-op if nothing is paused.
 */
export async function resumePausedChat(): Promise<void> {
  const store = usePiStore.getState();
  const paused = store.pausedChat;
  if (paused === null) return;
  usePiStore.setState({ pausedChat: null });

  const partial = frozenPartialAssistant(store.messages);
  if (partial === null) {
    // Nothing to continue (empty/streaming/no assistant row) — regenerate.
    await regenerateFromPrompt(paused.userText.trim());
    return;
  }

  const messages = groundTruthMessages() ?? reconstructMessages(store.messages, partial.id);
  const partialBlocks = partialBlocksOf(partial);
  const enableThinking =
    partial.blocks.some((b) => b.type === 'thinking') || store.agent.thinkingLevel !== 'off';
  const temperature = useSettingsStore.getState().settings.advanced.sampling.temperature;
  const resumeId = `resume-${Date.now()}-${++resumeCounter}`;
  const partialId = partial.id;

  // Re-mark the frozen reply as streaming + flag the resume so the composer shows
  // the Pause/Stop affordance (this is not a pi turn, so agent.isStreaming stays
  // false — `resuming` drives the busy state).
  usePiStore.setState((s) => ({
    resuming: true,
    messages: mutateAssistant(s.messages, partialId, (m) => ({ ...m, isStreaming: true })),
  }));

  /*
   * Stream each continuation token onto the SAME assistant message, through the
   * splitter that tells the reply's channels apart.
   *
   * The resume runs over llama.cpp's RAW `/completion` endpoint, so — unlike a
   * normal turn — nothing upstream has separated reasoning from the answer or
   * lifted tool calls out of their template envelope. Appending every token
   * straight into a text block (what this used to do) is what made a reply paused
   * mid-thought appear to close its thinking block on its own and spill the rest
   * of the reasoning, a bare `</think>`, and any `<tool_call>{…}` markup into the
   * visible answer. The splitter is seeded from the frozen partial the same way
   * the partial itself is re-serialized for the server: a trailing thinking block
   * means the reply was still inside `<think>` when it was paused.
   */
  const splitter = createResumeSplitter({
    thinkingOpen: partial.blocks[partial.blocks.length - 1]?.type === 'thinking',
  });
  let resumeToolSeq = 0;
  const applyResumeEvents = (events: readonly ResumeEvent[]): void => {
    for (const ev of events) {
      if (ev.type === 'delta') {
        usePiStore.setState((s) => ({
          messages: appendOrMergeBlock(s.messages, partialId, ev.channel, ev.delta),
        }));
        continue;
      }
      // A tool call in a continuation is shown as the CALL it is rather than as
      // raw markup. It is not dispatched: this path talks to llama-server
      // directly, outside pi, so there is no agent loop here to run a tool and
      // feed the result back — the row is the honest record of what the model
      // asked for.
      const id = `resume-tc-${resumeId}-${++resumeToolSeq}`;
      usePiStore.setState((s) => ({
        messages: mutateAssistant(s.messages, partialId, (m) => ({
          ...m,
          blocks: [
            ...m.blocks,
            { type: 'toolCall' as const, id, name: ev.name, arguments: ev.arguments },
          ],
        })),
      }));
    }
  };
  const off = window.piDesktop.onEvent('pi:resume-delta', (e) => {
    if (e.resumeId !== resumeId) return;
    applyResumeEvents(splitter.push(e.token));
  });

  const epoch = store.sessionEpoch;
  try {
    const res = await window.piDesktop.invoke('pi:resume-continue', {
      resumeId,
      messages,
      partial: partialBlocks,
      enableThinking,
      temperature,
    });
    // A GENUINE failure (server down mid-stream) returns { success:false }: the
    // partial stays in the thread and — unless the user switched chats — Resume is
    // re-offered so they can retry, with no error toast. An abort (pause/stop)
    // resolves { success:true, aborted:true } and already set the right
    // paused/cleared state, so it is left alone.
    if (res.success === false && usePiStore.getState().sessionEpoch === epoch) {
      usePiStore.setState({
        pausedChat: { sessionFile: paused.sessionFile, userText: paused.userText },
      });
    }
  } finally {
    off();
    // Release anything the splitter was holding back waiting for a marker the
    // stream never delivered (an abort mid-`</thi`), so no token is swallowed.
    if (usePiStore.getState().sessionEpoch === epoch) applyResumeEvents(splitter.flush());
    // Only touch THIS session's state (a switch during the resume moved on).
    if (usePiStore.getState().sessionEpoch === epoch) {
      usePiStore.setState((s) => ({
        resuming: false,
        messages: mutateAssistant(s.messages, partialId, (m) => ({ ...m, isStreaming: false })),
      }));
    }
  }
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
 * title — a subsequent user rename still wins. Gated by `useHarnessTitleSync`
 * (which checks the user-rename lock), so it never clobbers a user-chosen name.
 *
 * The SIDEBAR row is the point (jedd: auto-naming "doesn't get renamed or named
 * at all in the left sidebar"). A row's label is `chatOrg.titles[file] ??` the
 * main-process-derived first-user-message (see chat-org displayTitle), so the
 * title has to land in that SAME per-file map the manual rename box writes —
 * `windowTitle` only drives the header, and the `pi:set-session-name` RPC is
 * forwarded to the pi child and never read back by the session list. So we write
 * all three: the header state, the persisted per-file title the sidebar actually
 * reads (which also survives a restart), and the RPC for pi's own bookkeeping.
 */
export async function applyHarnessTitle(name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return;
  usePiStore.setState({ windowTitle: trimmed });
  const sessionFile = usePiStore.getState().session?.sessionFile ?? null;
  if (sessionFile !== null && sessionFile.length > 0) {
    await renameChat(sessionFile, trimmed).catch(() => {});
  }
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
 * Per-chat state snapshots, keyed by session file. Switching away SAVES the chat
 * we're leaving (its messages — including a frozen in-flight partial — and its
 * canvas tabs) so returning RESTORES it instead of a blank thread + a leaked
 * canvas. In-memory only, bounded by the chats visited this app-run.
 */
interface SessionSnapshot {
  messages: ChatMsg[];
  canvas: CanvasState | null;
  /** The chat's pending queue (jedd: each conversation holds its own queued
   * messages) — captured before the switch-abort drops it, restored on return. */
  queuedSends: QueuedSend[];
  /** A paused turn, so returning to the chat still offers Resume. */
  pausedChat: PausedChat | null;
}
const sessionSnapshots = new Map<string, SessionSnapshot>();

/** Canvas tab kinds that are EPHEMERAL/live and can't be reconstructed from a tab
 * spec — excluded from a per-chat snapshot so restoring a chat re-inits nothing
 * and can never strand a PTY or a live-derived surface. Everything else preserves:
 * document/media tabs (file/image/pdf/model/doc/markdown/code/…) carry their own
 * data, the `filetree` carries its tree nodes, and a `browser` tab carries its URL
 * (re-navigated on restore — see native-surfaces `#onMount`). Kept ephemeral:
 * `terminal` (a live PTY), `subagent`/`situation` (re-derived from live corp state). */
const EPHEMERAL_CANVAS_KINDS = new Set(['terminal', 'subagent', 'situation']);

/** The snapshot-safe canvas state: drop live tabs, and re-anchor the active tab
 * to a surviving one so the restored canvas is always well-formed. */
function preservableCanvas(): CanvasState | null {
  const raw = snapshotCanvas();
  if (raw === null) return null;
  const tabs = raw.tabs.filter((t) => !EPHEMERAL_CANVAS_KINDS.has(t.kind));
  const activeTabId = tabs.some((t) => t.id === raw.activeTabId)
    ? raw.activeTabId
    : (tabs[0]?.id ?? null);
  return { ...raw, tabs, activeTabId };
}

/** Snapshot the CURRENTLY-active chat before we leave it. A still-streaming
 * assistant turn is FROZEN (isStreaming cleared) — the single pi child can't keep
 * generating it once we switch, so the restored view must not look "live". */
function captureCurrentSession(): void {
  const store = usePiStore.getState();
  const file = store.session?.sessionFile;
  if (file === undefined || file === null) return;
  const messages = store.messages.map((m) =>
    m.kind === 'assistant' && m.isStreaming === true ? { ...m, isStreaming: false } : m,
  );
  sessionSnapshots.set(file, {
    messages,
    canvas: preservableCanvas(),
    queuedSends: store.queuedSends,
    pausedChat: store.pausedChat,
  });
}

/** Point the store at the session we just switched to. `sessionFile` is set to
 * the EXACT path the sidebar row carries so the row highlights + its spinner
 * attach (switchSession otherwise never syncs the pointer — pi emits no session
 * event on switch, so it stays stale). We deliberately do NOT call getPiState()
 * here: its response is applied by the event router as a `sessionChanged`, which
 * would race in AFTER this and clobber the clicked path with pi's own path
 * format. The streaming flag is cleared — the target isn't generating in this
 * child (any old turn was halted above). */
function syncSessionPointer(sessionPath: string): void {
  usePiStore.setState((s) => ({
    session: { ...(s.session ?? {}), sessionFile: sessionPath },
    agent: { ...s.agent, isStreaming: false },
  }));
}

/** Load a session's thread + canvas into the VIEW (messages, canvas, queue, paused)
 * WITHOUT touching which session pi is bound to. Shared by a normal switch (after
 * pi has moved) and by merely VIEWING a chat while another runs pinned in the
 * background. Does NOT set the view pointer or `agent.isStreaming` — the caller owns
 * those. Returns whether the rehydrated history was truncated. */
async function loadViewedThread(sessionPath: string): Promise<{ truncated: boolean }> {
  const snap = sessionSnapshots.get(sessionPath);
  if (snap !== undefined) {
    usePiStore.getState().setMessagesExternal(snap.messages);
    if (snap.canvas !== null) restoreCanvas(snap.canvas);
    else resetCanvasForNewSession();
    usePiStore.setState({ queuedSends: snap.queuedSends, pausedChat: snap.pausedChat });
    return { truncated: false };
  }
  resetCanvasForNewSession();
  const read = await window.piDesktop.invoke('fs:read-session', { file: sessionPath });
  if (read.text === null) {
    usePiStore.getState().setMessagesExternal([]);
    return { truncated: false };
  }
  const r = rehydrateSessionJsonl(read.text);
  usePiStore.getState().setMessagesExternal(r.messages);
  return { truncated: r.truncated };
}

/** Persist a finished background run's thread into the per-chat snapshot (freezing
 * any still-streaming marker) so returning to that chat later shows the completed
 * reply. Preserves its canvas/queue/paused if already snapshotted. */
function stashBgRun(bg: BgRun): void {
  const existing = sessionSnapshots.get(bg.sessionFile);
  sessionSnapshots.set(bg.sessionFile, {
    messages: bg.messages.map((m) =>
      m.kind === 'assistant' && m.isStreaming === true ? { ...m, isStreaming: false } : m,
    ),
    canvas: existing?.canvas ?? null,
    queuedSends: existing?.queuedSends ?? [],
    pausedChat: existing?.pausedChat ?? null,
  });
}

/** Set the VIEW pointer to `sessionPath`, optionally forcing the streaming flag
 * (a background chat you return to may still be live). */
function setViewPointer(sessionPath: string, isStreaming?: boolean): void {
  usePiStore.setState((s) => ({
    session: { ...(s.session ?? {}), sessionFile: sessionPath },
    ...(isStreaming !== undefined ? { agent: { ...s.agent, isStreaming } } : {}),
  }));
}

/**
 * Switch which chat the user is looking at. The ONE pi child runs ONE turn on ONE
 * session (pi's switch_session DISPOSES a running turn), so the rules are:
 *
 *  - Case B — RETURN to the chat running in the background: pi is already on it;
 *    swap its live/finished buffer back into the view and clear the bg run.
 *  - Case A — LEAVE a chat whose turn is STREAMING: DON'T abort it. Pin pi to it,
 *    mirror its events into `bgRun` (see the sink's threadSet), and just view the
 *    target. The chat keeps generating off-screen with a sidebar spinner.
 *  - Case C — a bg run is already going and you switch to yet ANOTHER chat: just
 *    change the view; pi stays pinned to the bg session.
 *  - Case D — the plain switch (nothing streaming, no bg run): move pi over.
 */
export async function switchSession(
  sessionPath: string,
): Promise<{ ok: boolean; truncated: boolean; cancelled?: boolean; error?: string }> {
  const store = usePiStore.getState();
  const viewed = store.session?.sessionFile ?? null;
  if (sessionPath === viewed) return { ok: true, truncated: false };

  const bg = store.bgRun;
  const activeStreaming = store.agent.isStreaming || store.promptInFlight;
  instructionsArmed = false;
  // Switching to a real chat abandons any deferred (unsent) new chat.
  pendingNewSession = false;
  // Opening a chat clears its "unread" dot (you've now looked at it).
  usePiStore.getState().clearUnread(sessionPath);

  // ── Case B: returning to the background chat. pi is already on it.
  if (bg !== null && sessionPath === bg.sessionFile) {
    captureCurrentSession(); // snapshot the chat we're leaving (the viewed one)
    invalidateInFlightSend();
    usePiStore.getState().setMessagesExternal(bg.messages);
    const snap = sessionSnapshots.get(sessionPath);
    if (snap?.canvas != null) restoreCanvas(snap.canvas);
    else resetCanvasForNewSession();
    usePiStore.setState({ bgRun: null });
    setViewPointer(sessionPath, bg.streaming);
    return { ok: true, truncated: false };
  }

  // ── Case A: leaving a STREAMING chat → background it (keep pi on it).
  if (activeStreaming && bg === null && viewed !== null) {
    captureCurrentSession(); // canvas/queue/paused for the backgrounded chat
    usePiStore.setState({
      bgRun: {
        sessionFile: viewed,
        messages: usePiStore.getState().messages,
        streaming: true,
        title: store.windowTitle,
      },
    });
    const { truncated } = await loadViewedThread(sessionPath);
    // The viewed chat isn't the one streaming; drop its streaming flag for this view
    // (the bg run drives the sidebar spinner instead).
    setViewPointer(sessionPath, false);
    return { ok: true, truncated };
  }

  // ── Case C: a bg run is going; view another chat without moving pi.
  if (bg !== null) {
    captureCurrentSession();
    invalidateInFlightSend();
    const { truncated } = await loadViewedThread(sessionPath);
    setViewPointer(sessionPath, false);
    return { ok: true, truncated };
  }

  // ── Case D: the plain switch — move pi to the target.
  captureCurrentSession();
  invalidateInFlightSend();
  if (agentInFlight()) await abortPi();
  const switched = await window.piDesktop.invoke('pi:switch-session', { sessionPath });
  if (!switched.success) return { ok: false, truncated: false, error: switched.error };
  if (switched.cancelled === true) return { ok: false, truncated: false, cancelled: true };
  const { truncated } = await loadViewedThread(sessionPath);
  syncSessionPointer(sessionPath);
  return { ok: true, truncated };
}

/**
 * Before dispatching a send into the VIEWED chat, make pi actually be on it. pi may
 * be parked on a chat that finished streaming in the background while the user moved
 * on; in that case save the finished bg thread, switch pi to the viewed chat, and
 * clear the run. A STILL-streaming bg run is not switched here — such a send is
 * queued upstream (the composer) rather than dispatched.
 */
async function ensurePiOnViewedSession(): Promise<void> {
  const store = usePiStore.getState();
  const bg = store.bgRun;
  // A DEFERRED new chat (opened while another was streaming): now create its fresh
  // pi session. Save the finished bg thread first, then repoint the store at pi's
  // new session so the sidebar row + dispatch target the new chat, not the bg one.
  if (pendingNewSession) {
    pendingNewSession = false;
    if (bg !== null) stashBgRun(bg);
    await window.piDesktop.invoke('pi:new-session', undefined);
    const state = await getPiState();
    usePiStore.setState((s) => ({
      bgRun: null,
      session:
        state.success && state.state !== undefined
          ? {
              ...(s.session ?? {}),
              sessionFile: state.state.sessionFile,
              sessionId: state.state.sessionId,
            }
          : (s.session ?? null),
    }));
    return;
  }
  if (bg === null || bg.streaming) return;
  const viewed = store.session?.sessionFile ?? null;
  if (viewed === null || viewed === bg.sessionFile) {
    usePiStore.setState({ bgRun: null });
    return;
  }
  stashBgRun(bg);
  await window.piDesktop.invoke('pi:switch-session', { sessionPath: viewed });
  usePiStore.setState({ bgRun: null });
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
