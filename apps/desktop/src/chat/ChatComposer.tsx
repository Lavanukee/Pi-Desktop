/**
 * The real chat composer: a Lexical editor inside the design-system composer
 * shell, wired to pi. Enter submits (Shift+Enter newline), `@` fuzzy-file
 * mentions (fs:list-files), `/` slash commands (pi get_commands), `!` bash mode
 * (PiBridge.bash), image drop/paste attachments (with thumbnail previews), and
 * the model/TPS/context footer. Honors the claude flavor rule (hide send while
 * empty, no top tray).
 *
 * Round-3: the rule-based suggestion overlay was removed (#A7 — jedd disliked
 * it); the `@`/`/` autocomplete stays. Drag-drop attach is handled by the
 * window-level fullscreen overlay (#A8) which feeds files through `useDropStore`.
 */
import type { Model } from '@pi-desktop/engine';
import {
  ComposerAddMenu,
  type GenActionKey,
  IconArrowUp,
  IconButton,
  IconClose,
} from '@pi-desktop/ui';
import { useEffect, useRef, useState } from 'react';
import { abortCorpTask } from '../state/corp-connect';
import { useCorpStore } from '../state/corp-store';
import {
  abortPi,
  applyHarnessPreset,
  getCommands,
  runBash,
  sendPrompt,
} from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { productionHarnessEnabled } from '../state/settings-store';
import { useThemeStore } from '../store/theme';
import { ComposerBar } from './ComposerBar';
import { ComposerFooter } from './ComposerFooter';
import { type AcItem, Autocomplete } from './composer/Autocomplete';
import {
  ComposerEditor,
  type ComposerEditorApi,
  type ComposerKeymap,
} from './composer/ComposerEditor';
import { useDropStore } from './composer/drop-store';
import { type AcToken, EMPTY_TOKEN } from './composer/tokens';
import { GEN_ACTION_PLANS, type TaskClass } from './composer-gen-actions';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface SlashCommand {
  name: string;
  description?: string;
}

interface Attachment {
  id: string;
  name: string;
  /** Image attachments carry a data URI (sent to pi as ImageContent); text
   * attachments carry their decoded contents (folded into the prompt text). */
  kind: 'image' | 'text';
  dataUri?: string;
  text?: string;
}

/** Text files we accept + read into the prompt (by MIME or extension). */
const TEXT_EXTENSIONS = new Set([
  'txt',
  'text',
  'md',
  'markdown',
  'rst',
  'json',
  'jsonc',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'fish',
  'sql',
  'log',
  'gitignore',
  'dockerfile',
  'makefile',
  'gradle',
  'properties',
]);
/** Cap the per-file size we inline into a prompt (256 KB). */
const TEXT_MAX_BYTES = 256 * 1024;

function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  if (file.type === 'application/json' || file.type === 'application/xml') return true;
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : file.name.toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/** Built-in commands shown unconditionally — so `/` always offers something,
 * even before pi's session RPC is live enough to answer `get_commands`. */
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'Show help' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Compact the conversation' },
];

async function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** `foo.tar.gz` → `GZ`; `README` → `FILE`. */
function extLabel(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return (ext || 'file').toUpperCase().slice(0, 4);
}

/** A slight attachment preview (#A8c): image thumbnail, else a filename+ext chip. */
function AttachmentPreview({
  name,
  dataUri,
  onRemove,
}: {
  name: string;
  dataUri?: string;
  onRemove: () => void;
}) {
  const isImage = (dataUri ?? '').startsWith('data:image/');
  return (
    <div className="pd-attach" title={name}>
      {isImage ? (
        // biome-ignore lint/a11y/useAltText: decorative attachment thumbnail; name is in the title
        <img className="pd-attach-thumb" src={dataUri} />
      ) : (
        <span className="pd-attach-ext">{extLabel(name)}</span>
      )}
      <span className="pd-attach-name">{name}</span>
      <button
        type="button"
        className="pd-attach-remove pd-focusable"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
      >
        <IconClose size={12} />
      </button>
    </div>
  );
}

export function ChatComposer({
  piModels,
  onOpenModels,
  onCorpSubmit,
  onCorpFollowUp,
}: {
  piModels: Model[];
  onOpenModels?: () => void;
  /** EXPERIMENTAL: when the production-harness flag is on, a submitted prompt is
   * routed here (the CorpEngine + situation room) instead of the normal pi turn.
   * Absent / flag off ⇒ the composer behaves exactly as it does today. */
  onCorpSubmit?: (echo: string, imageUris: string[]) => void;
  /** A1/A4 — route a follow-up (a corp task already exists) to the CEO for an answer
   * instead of starting a fresh production. */
  onCorpFollowUp?: (question: string) => void;
}) {
  const flavor = useThemeStore((s) => s.flavor);
  const isStreaming = usePiStore((s) => s.agent.isStreaming);
  // A corp/hierarchy run is live from start to its terminal `done` — its Stop
  // halts every subagent (cooperative abort), distinct from a plain chat Stop.
  const corpRunning = useCorpStore((s) => s.corpRunning);
  const corpTaskId = useCorpStore((s) => s.taskId);
  const cwd = usePiStore((s) => s.session?.cwd ?? '');

  const apiRef = useRef<ComposerEditorApi | null>(null);
  const [text, setText] = useState('');
  const [token, setToken] = useState<AcToken>(EMPTY_TOKEN);
  const [items, setItems] = useState<AcItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>(BUILTIN_COMMANDS);
  const [webSearch, setWebSearch] = useState(false);
  // A composer "+" force-action (spec §3.2) pins the harness task class for the
  // NEXT send; consumed + cleared in submit(). Drives the renderer Auto-route
  // classify via `forcedClass` (the toolset preset is pinned eagerly on select,
  // over the `/harness preset` seam).
  const [forcedClass, setForcedClass] = useState<TaskClass | null>(null);
  // #19: whether the (empty-state) placeholder overflows the visible editor and
  // must fade at the bottom rather than hard-clip. Measured below.
  const [phClipped, setPhClipped] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorScrollRef = useRef<HTMLDivElement>(null);
  const skipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Composer overflow (round-5 #3/#8): the editor never shows a hard scrollbar
  // (hidden in CSS). When typed content overflows the max height and the caret
  // scrolls it, mark the scroll container so a top gradient MASK fades the text
  // sliding under the top edge instead of a harsh cut. At rest (scrollTop 0) the
  // mask is off, so the placeholder and first line never fade.
  const onEditorScroll = () => {
    const el = editorScrollRef.current;
    if (el !== null) el.dataset.scrolled = el.scrollTop > 1 ? 'true' : 'false';
  };

  // Apply composer text pushed from elsewhere: a message's Edit action and pi's
  // extension `setComposerText` both land in the store; drain it into the editor.
  const composerText = usePiStore((s) => s.composerText);
  useEffect(() => {
    if (composerText.length === 0) return;
    apiRef.current?.setText(composerText);
    apiRef.current?.focus();
    usePiStore.setState({ composerText: '' });
  }, [composerText]);

  const canSend = text.trim().length > 0 || attachments.length > 0;
  const bashMode = text.trim().startsWith('!');

  // Accept images (sent to pi as ImageContent) AND text files (read + folded
  // into the prompt text on send). Anything else — binary the prompt can't carry
  // (pdf, zip, …) — is NOT silently dropped: its name shows in an inline note.
  const addFiles = async (files: File[]) => {
    const added: Attachment[] = [];
    const rejected: string[] = [];
    for (const f of files) {
      if (f.type.startsWith('image/')) {
        added.push({
          id: crypto.randomUUID(),
          name: f.name,
          kind: 'image',
          dataUri: await fileToDataUri(f),
        });
      } else if (isTextFile(f) && f.size <= TEXT_MAX_BYTES) {
        added.push({ id: crypto.randomUUID(), name: f.name, kind: 'text', text: await f.text() });
      } else {
        rejected.push(f.name);
      }
    }
    if (added.length > 0) setAttachments((prev) => [...prev, ...added]);
    if (rejected.length > 0) {
      setSkipped(rejected);
      if (skipTimer.current !== null) clearTimeout(skipTimer.current);
      skipTimer.current = setTimeout(() => setSkipped([]), 6000);
    }
  };

  // Drain files dropped on the window-level fullscreen overlay (#A8b) into our
  // attachment list, then clear the hand-off store.
  const droppedFiles = useDropStore((s) => s.files);
  // biome-ignore lint/correctness/useExhaustiveDependencies: droppedFiles is the trigger; addFiles reads only setState
  useEffect(() => {
    if (droppedFiles.length === 0) return;
    void addFiles(droppedFiles);
    useDropStore.getState().clear();
  }, [droppedFiles]);

  // Fetch slash commands whenever the session becomes ready. get_commands
  // resolves `{success:false}` until pi's RPC is live, so the original
  // mount-only fetch silently lost the race and `/` showed nothing. Re-fetch on
  // model readiness, retry on failure, and always keep the built-ins so `/`
  // works from the first keystroke.
  const modelReady = usePiStore((s) => s.agent.model !== null || s.session !== null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: modelReady is a re-fetch trigger, not read in the effect
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const merge = (fetched: SlashCommand[]): void => {
      const seen = new Set(BUILTIN_COMMANDS.map((b) => b.name));
      setCommands([...BUILTIN_COMMANDS, ...fetched.filter((c) => !seen.has(c.name))]);
    };
    const scheduleRetry = (): void => {
      if (cancelled || attempts >= 6) return;
      attempts += 1;
      setTimeout(load, 400 * attempts);
    };
    const load = (): void => {
      getCommands()
        .then((res) => {
          if (cancelled) return;
          if (res.success) merge(res.commands);
          else scheduleRetry();
        })
        .catch(() => {
          if (!cancelled) scheduleRetry();
        });
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [modelReady]);

  // Resolve autocomplete suggestions for the active token.
  useEffect(() => {
    let cancelled = false;
    setSelectedIndex(0);
    if (token.mode === null) {
      setItems([]);
      return;
    }
    void (async () => {
      if (token.mode === 'mention') {
        const files = await window.piDesktop
          .invoke('fs:list-files', { cwd, query: token.query, limit: 12 })
          .catch(() => []);
        if (cancelled) return;
        setItems(
          files.map(
            (f): AcItem => ({
              id: `@${f.rel}`,
              label: f.rel.split('/').pop() ?? f.rel,
              subtitle: f.rel,
              section: 'Files',
              kind: 'file',
            }),
          ),
        );
      } else {
        const q = token.query.toLowerCase();
        setItems(
          commands
            .filter(
              (c) =>
                c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q),
            )
            .slice(0, 12)
            .map(
              (c): AcItem => ({
                id: `/${c.name} `,
                label: `/${c.name}`,
                subtitle: c.description,
                section: 'Commands',
                kind: 'command',
              }),
            ),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token.mode, token.query, cwd, commands]);

  // Stable keymap object: methods read the latest state through refs so the
  // editor never has to re-register its commands.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const selRef = useRef(selectedIndex);
  selRef.current = selectedIndex;

  const keymap = useRef<ComposerKeymap>({
    isAcOpen: () => tokenRef.current.mode !== null && itemsRef.current.length > 0,
    moveSelection: (delta) =>
      setSelectedIndex((i) => clamp(i + delta, 0, Math.max(0, itemsRef.current.length - 1))),
    acceptAc: () => {
      const item = itemsRef.current[selRef.current];
      if (item === undefined) return false;
      apiRef.current?.insertToken(tokenRef.current.tokenStart, item.id);
      setToken(EMPTY_TOKEN);
      return true;
    },
    // Suggestion overlay removed (#A7): these keymap hooks are inert no-ops so
    // arrow/Tab/Esc fall through to the editor's native behavior.
    moveSuggestion: () => false,
    acceptSuggestion: () => false,
    dismissSuggestions: () => false,
    close: () => setToken(EMPTY_TOKEN),
  }).current;

  // A composer "+" modality force-action: (a) prefill the tiny prompt scaffold
  // and focus, and (b) pin the harness class for the next send — eagerly over the
  // `/harness preset` seam (so the toolset preset loads and the active-class UI
  // reflects it now) AND by stashing the class for submit() to feed the Auto-route
  // classify. Deterministic: "+ → Generate video" ⇒ advanced-video regardless of
  // what the user then types.
  const onGenAction = (key: GenActionKey) => {
    const plan = GEN_ACTION_PLANS[key];
    apiRef.current?.setText(plan.scaffold);
    apiRef.current?.focus();
    setForcedClass(plan.forcedClass);
    void applyHarnessPreset(plan.forcedClass);
  };

  const submit = async () => {
    const raw = text.trim();
    if (raw === '' && attachments.length === 0) return;
    // One-shot: capture + clear the pinned class so only THIS send is forced.
    const pinnedClass = forcedClass;
    setForcedClass(null);
    const imageUris = attachments
      .filter((a) => a.kind === 'image')
      .map((a) => a.dataUri)
      .filter((uri): uri is string => uri !== undefined);
    const textFiles = attachments.filter((a) => a.kind === 'text');
    apiRef.current?.clear();
    setAttachments([]);
    setToken(EMPTY_TOKEN);
    // Keep focus in the editor after a send (adversarial finding): with the
    // composer now mounted across the empty→thread transition, this refocus makes
    // the caret sticky even if the browser blurred on submit.
    apiRef.current?.focus();
    if (raw.startsWith('!')) {
      await runBash(raw.slice(1).trim());
      return;
    }
    // Fold attached text-file contents into pi's copy of the message (the send
    // path is otherwise images-only); the visible bubble echoes only the typed
    // text (or the filenames when nothing was typed).
    const fileBlocks = textFiles
      .map((a) => `Attached file \`${a.name}\`:\n\`\`\`\n${a.text ?? ''}\n\`\`\``)
      .join('\n\n');
    const agentMessage =
      fileBlocks.length > 0 ? (raw.length > 0 ? `${fileBlocks}\n\n${raw}` : fileBlocks) : raw;
    const echo =
      raw.length > 0 ? raw : textFiles.length > 0 ? textFiles.map((a) => a.name).join(', ') : raw;

    // EXPERIMENTAL production harness (flag / env on): drive the CorpEngine +
    // situation room instead of the normal pi turn. Bash mode (`!`) still runs
    // locally. When off, this branch is never taken and the app is byte-for-byte
    // its current self.
    if (onCorpSubmit !== undefined && productionHarnessEnabled()) {
      // A1/A4 — once a production exists in this chat, a follow-up is ANSWERED by the
      // CEO (from its retained context) rather than starting a fresh vision ceremony.
      if (onCorpFollowUp !== undefined && useCorpStore.getState().taskId !== null) {
        onCorpFollowUp(echo);
      } else {
        onCorpSubmit(echo, imageUris);
      }
      return;
    }

    // While a turn is in-flight (streaming OR still in the dispatch→agent_start
    // gap), QUEUE this message rather than inject it into the running turn.
    // Appending a 2nd user echo mid-turn — as a steer OR a fresh send — lands it
    // ahead of the first turn's reply (the assistant row is created only at
    // turn_start and streams in at the end), which is the "response pushed below
    // my new message" reorder. Queued messages drain as their own sequential
    // turns once the current one ends → [msg1, reply1, msg2, reply2].
    const piState = usePiStore.getState();
    if (piState.agent.isStreaming || piState.promptInFlight) {
      piState.enqueueSend({
        text: echo,
        images: imageUris,
        agentMessage,
        taskClass: pinnedClass ?? undefined,
      });
      return;
    }
    await sendPrompt(echo, imageUris, agentMessage, pinnedClass ?? undefined);
  };

  // THEME 4 click-target fix: clicking any blank area of the composer focuses
  // the editor. Skip when the press lands on an interactive control (the send
  // button, add-menu, model picker) or on the editor itself (let Lexical place
  // the caret). preventDefault keeps focus from bouncing off the blank target.
  const focusEditorFromBlank = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.closest(
        'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="menu"], [role="menuitem"], [role="listbox"], [role="option"]',
      ) !== null
    ) {
      return;
    }
    e.preventDefault();
    apiRef.current?.focus();
  };

  const isBusy = isStreaming || corpRunning;
  const showSend = flavor === 'codex' || canSend || isBusy;
  // Stop routes to the right abort: a corp run cooperatively halts its subagents;
  // a plain chat aborts the pi turn.
  const stopBusy = (): void => {
    if (corpRunning && corpTaskId !== null) void abortCorpTask(corpTaskId);
    else void abortPi();
  };
  // jedd #12: the primary placeholder is friendly for a first-timer — the
  // developer-jargon @ / ! hints were demoted to the subtle helper line below
  // (home only), not baked into the placeholder. A single short line also stops
  // the empty composer from looking oversized (the old 3-line jargon overflowed
  // and faded, inflating the card).
  const placeholder = isStreaming
    ? 'Send — it goes right after this reply…'
    : bashMode
      ? 'Run a shell command…'
      : 'Ask Pi anything…';
  // Only the empty home screen (no messages yet) shows the shortcut helper line.
  const isHome = usePiStore((s) => s.messages.length === 0);

  // #19: fade the placeholder's bottom rather than slicing it. We flip the fade
  // ON only when the empty-state placeholder actually overflows the visible
  // editor box — a single-line placeholder stays crisp. Re-measured on composer
  // resize (window / canvas) and whenever the placeholder text changes, so the
  // now-1.18x-scaled text that wraps at narrow widths melts out cleanly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: placeholder is a re-measure trigger (its text drives wrap height), not read in the effect
  useEffect(() => {
    const container = editorScrollRef.current;
    if (container === null) return;
    // Only the empty composer shows the placeholder; typed content hides it (and
    // owns the scrolled top-mask instead), so never fade once the user types.
    if (text.trim().length > 0) {
      setPhClipped(false);
      return;
    }
    const measure = () => {
      const ph = container.querySelector<HTMLElement>('.pd-composer-placeholder');
      if (ph === null) {
        setPhClipped(false);
        return;
      }
      // Natural placeholder height vs the room below its top offset.
      const visible = container.clientHeight - ph.offsetTop;
      setPhClipped(ph.scrollHeight > visible + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, [text, placeholder]);

  return (
    // Round-12 W2: the input group reserves a little room at the bottom so the
    // sticking-out ComposerBar (mounted below the input card) protrudes cleanly
    // — the whole input bar reads as nudged up to make room for the thin ledge.
    <div className="mx-auto w-full max-w-[700px] pb-1.5">
      <div className="pd-composer-root relative">
        <Autocomplete
          items={token.mode !== null ? items : []}
          selectedIndex={selectedIndex}
          onPick={(item) => {
            apiRef.current?.insertToken(token.tokenStart, item.id);
            setToken(EMPTY_TOKEN);
            apiRef.current?.focus();
          }}
          onHover={setSelectedIndex}
        />

        {/* biome-ignore lint/a11y/noStaticElementInteractions: click-to-focus target; the editor owns keyboard entry */}
        <div
          className="pd-composer"
          data-bash={bashMode ? '' : undefined}
          onMouseDown={focusEditorFromBlank}
        >
          {attachments.length > 0 ? (
            <div className="pd-composer-attachments" data-testid="composer-attachments">
              {attachments.map((a) => (
                <AttachmentPreview
                  key={a.id}
                  name={a.name}
                  dataUri={a.dataUri}
                  onRemove={() => setAttachments((prev) => prev.filter((p) => p.id !== a.id))}
                />
              ))}
            </div>
          ) : null}

          {skipped.length > 0 ? (
            <div
              className="px-3 pt-2 text-footnote text-text-muted"
              data-testid="composer-skipped-note"
            >
              Only images and text files can be attached — skipped {skipped.join(', ')}.
            </div>
          ) : null}

          <div
            ref={editorScrollRef}
            className="pd-composer-editor pd-scroll"
            data-ph-clip={phClipped ? 'true' : undefined}
            onScroll={onEditorScroll}
          >
            <ComposerEditor
              placeholder={placeholder}
              onTextChange={setText}
              onTokenChange={setToken}
              onSubmit={() => void submit()}
              keymap={keymap}
              apiRef={apiRef}
            />
          </div>

          <div className="pd-composer-footer">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,text/*"
              multiple
              hidden
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
            <ComposerAddMenu
              variant="full"
              side="top"
              align="start"
              onAddFiles={() => fileInputRef.current?.click()}
              webSearch={webSearch}
              onWebSearchChange={setWebSearch}
              onGenerateImage={() => onGenAction('image')}
              onGenerateVideo={() => onGenAction('video')}
              onGenerateMotion={() => onGenAction('motion')}
              onPerception={() => onGenAction('perception')}
            />
            <div className="pd-composer-footer-spacer" />
            <ComposerFooter piModels={piModels} onOpenModels={onOpenModels} />
            {showSend ? (
              isBusy ? (
                <IconButton
                  aria-label={corpRunning ? 'Stop — halt all agents' : 'Stop'}
                  variant="primary"
                  circle
                  onClick={() => stopBusy()}
                  data-testid="composer-stop"
                >
                  <IconClose size={14} />
                </IconButton>
              ) : (
                <IconButton
                  aria-label="Send message"
                  variant="primary"
                  circle
                  disabled={!canSend}
                  onClick={() => void submit()}
                  data-testid="composer-send"
                >
                  <IconArrowUp size={14} />
                </IconButton>
              )
            ) : null}
          </div>
        </div>

        {/* Round-12 W2: the sticking-out bar — fused to the input card's bottom
            edge (the card, z-index 1, overlaps its tucked top) and protruding
            below it: project chip · active tier · effort slider. */}
        <ComposerBar />
      </div>

      {/* jedd #12: the @ / / ! shortcuts, demoted out of the placeholder to a
          subtle helper line under the composer — shown only on the empty home
          screen so a first-timer discovers them without jargon in the input. */}
      {isHome && !isStreaming ? (
        <div className="pd-composer-hints" data-testid="composer-hints">
          <span className="pd-composer-hint">
            <kbd>@</kbd> files
          </span>
          <span className="pd-composer-hint">
            <kbd>/</kbd> commands
          </span>
          <span className="pd-composer-hint">
            <kbd>!</kbd> bash
          </span>
        </div>
      ) : null}
    </div>
  );
}
