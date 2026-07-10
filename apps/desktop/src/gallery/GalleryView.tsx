/**
 * Dev-only component gallery (W1R): every @pi-desktop/ui component in a
 * labeled, scrollable grid so real builds allow click-through review of the
 * spec-book components under all four themes (toggles live in App.tsx).
 * No engine/store coupling — presentational demo data only.
 */

import { type Artifact, Canvas } from '@pi-desktop/canvas';
import {
  ActivityGroupCard,
  ActivityRow,
  ArtifactPanel,
  AttachmentPill,
  Badge,
  Button,
  Checkbox,
  Chip,
  CodeBlock,
  Composer,
  ComposerAddMenu,
  ComposerDivider,
  ContextGauge,
  ContextGaugeTooltip,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DiffStat,
  DiffView,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FileDropZone,
  FloatingPill,
  IconButton,
  IconChat,
  IconConnector,
  IconCopy,
  IconDiff,
  IconMic,
  IconPencil,
  IconPlus,
  IconSearch,
  IconSidebar,
  IconTerminal,
  Input,
  Kbd,
  MessageActions,
  MessageRow,
  ModelFootnote,
  ModelPicker,
  ProgressBar,
  Prose,
  QuestionCard,
  ResponseSpeed,
  SegmentedControl,
  ShimmerText,
  Sidebar,
  SidebarFooter,
  SidebarRow,
  SidebarScroll,
  SidebarSection,
  Spinner,
  Switch,
  TaskChecklist,
  TextArea,
  ThinkingBlock,
  Thread,
  Toast,
  ToastProvider,
  ToastViewport,
  Tooltip,
  TooltipProvider,
  TopBar,
  TopBarTitle,
} from '@pi-desktop/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-caption uppercase tracking-wider text-text-muted">{title}</h2>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

const MODELS = [
  { id: 'qwen', label: 'Qwen3.6 27B', description: 'MTP · Q4_K_M · 16.4 GB' },
  { id: 'gemma', label: 'Gemma4 E2B', description: 'Utility · Q8_0 · 2.1 GB' },
];

const EFFORTS = [
  { id: 'light', label: 'Light' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

const DIFF = [
  {
    path: 'packages/engine/src/pi-bridge.ts',
    added: 2,
    deleted: 1,
    lines: [
      { kind: 'hunk' as const, text: '@@ -12,4 +12,5 @@' },
      { kind: 'context' as const, text: 'constructor(opts: BridgeOptions) {', newNumber: 12 },
      { kind: 'del' as const, text: '  this.timeout = 5000;', oldNumber: 13 },
      { kind: 'add' as const, text: '  this.timeout = opts.timeout ?? 5000;', newNumber: 13 },
      { kind: 'add' as const, text: '  this.retries = opts.retries ?? 2;', newNumber: 14 },
      { kind: 'context' as const, text: '}', newNumber: 15 },
    ],
  },
];

const SAMPLE_SVG = `<svg viewBox="0 0 220 160" xmlns="http://www.w3.org/2000/svg">
  <rect width="220" height="160" rx="12" fill="#1f1e1d"/>
  <circle cx="110" cy="80" r="52" fill="none" stroke="#d97757" stroke-width="8"/>
  <circle cx="110" cy="80" r="30" fill="#d97757" opacity="0.55"/>
  <path d="M110 28 L110 132 M58 80 L162 80" stroke="#8a8781" stroke-width="3"/>
  <text x="110" y="86" font-size="20" font-family="sans-serif" text-anchor="middle" fill="#faf9f5">Pi</text>
</svg>`;

/** Streams a canned SVG in char-by-char (the "draw as code streams" behavior)
 * and demos the inline↔side placement toggle. */
function CanvasGalleryDemo() {
  const [placement, setPlacement] = useState<'inline' | 'side'>('inline');
  const [len, setLen] = useState(SAMPLE_SVG.length);
  const [streaming, setStreaming] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearInterval(timer.current);
    },
    [],
  );

  const streamIn = () => {
    if (timer.current !== null) clearInterval(timer.current);
    setLen(0);
    setStreaming(true);
    timer.current = setInterval(() => {
      setLen((n) => {
        const next = n + 14;
        if (next >= SAMPLE_SVG.length) {
          if (timer.current !== null) clearInterval(timer.current);
          timer.current = null;
          setStreaming(false);
          return SAMPLE_SVG.length;
        }
        return next;
      });
    }, 45);
  };

  const artifact: Artifact = {
    id: 'gallery-svg',
    title: 'Reaction wheel',
    filename: 'reaction-wheel.svg',
    content: { kind: 'svg', text: SAMPLE_SVG.slice(0, len) },
  };

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={streamIn}>
          Draw as code streams
        </Button>
        <SegmentedControl
          aria-label="Placement"
          value={placement}
          onValueChange={(v) => setPlacement(v as 'inline' | 'side')}
          options={[
            { value: 'inline', label: 'Inline' },
            { value: 'side', label: 'Side' },
          ]}
        />
      </div>
      <div className={placement === 'side' ? 'ml-auto h-80 w-[380px]' : 'h-80 w-full'}>
        <Canvas
          artifact={artifact}
          streaming={streaming}
          placement={placement}
          onPlacementChange={setPlacement}
        />
      </div>
    </div>
  );
}

/** QuestionCard in all three modes (choice / free / slider). */
function QuestionCardDemos() {
  const [answer, setAnswer] = useState<string>('—');
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="grid gap-4 md:grid-cols-3">
        <QuestionCard
          question="Which model should Pi default to?"
          mode="choice"
          options={[
            { value: '8b', label: 'Local 8B', info: 'Fast, on-device' },
            { value: '27b', label: 'Local 27B', info: 'Higher quality, more RAM' },
          ]}
          onSubmit={(a) => setAnswer(JSON.stringify(a))}
          onCancel={() => setAnswer('cancelled')}
        />
        <QuestionCard
          question="Describe the bug you hit."
          mode="free"
          placeholder="Type a short description…"
          onSubmit={(a) => setAnswer(JSON.stringify(a))}
          onCancel={() => setAnswer('cancelled')}
        />
        <QuestionCard
          question="Context window (k tokens)?"
          mode="slider"
          min={8}
          max={128}
          step={8}
          defaultValue={32}
          onSubmit={(a) => setAnswer(JSON.stringify(a))}
          onCancel={() => setAnswer('cancelled')}
        />
      </div>
      <div className="text-footnote text-text-muted">Last answer: {answer}</div>
    </div>
  );
}

export function GalleryView() {
  const [composerValue, setComposerValue] = useState('');
  const [webSearch, setWebSearch] = useState(false);
  const [mode, setMode] = useState('chat');
  const [model, setModel] = useState('qwen');
  const [effort, setEffort] = useState('medium');

  return (
    <TooltipProvider delayDuration={200}>
      <ToastProvider duration={Number.POSITIVE_INFINITY}>
        <div className="pd-scroll h-full overflow-y-auto">
          <div className="mx-auto flex max-w-[860px] flex-col gap-8 px-8 py-6 pb-24">
            <Section title="Buttons">
              <Button variant="primary">Primary</Button>
              <Button variant="accent">Accent</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="ghostMuted">Ghost muted</Button>
              <Button variant="danger">Danger</Button>
              <Button variant="primary" loading>
                Loading
              </Button>
              <Button variant="primary" disabled>
                Disabled
              </Button>
              <IconButton aria-label="Sidebar">
                <IconSidebar />
              </IconButton>
              <IconButton aria-label="Send" variant="primary" circle>
                <IconPlus />
              </IconButton>
            </Section>

            <Section title="Inputs">
              <Input placeholder="Search sessions…" style={{ maxWidth: 260 }} />
              <TextArea autoGrow placeholder="System prompt…" style={{ maxWidth: 320 }} rows={2} />
            </Section>

            <Section title="Menus / model picker / tooltip">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost">Session actions</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>Session</DropdownMenuLabel>
                  <DropdownMenuItem icon={<IconPencil size={14} />} hint="⌘R">
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={<IconTerminal size={14} />}
                    description="Runs commands without confirmation prompts"
                  >
                    Full access
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled>Archive (soon)</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem danger>Delete session</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <ModelPicker
                models={MODELS}
                model={model}
                onModelChange={setModel}
                efforts={EFFORTS}
                effort={effort}
                onEffortChange={setEffort}
              />
              <Tooltip label="Add files and more" kbd="⌘U">
                <IconButton aria-label="Attach">
                  <IconPlus />
                </IconButton>
              </Tooltip>
            </Section>

            <Section title="Dialog / toasts">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline">Open dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <div>
                      <DialogTitle>Download model?</DialogTitle>
                      <DialogDescription>
                        Qwen3.6-27B (Q4_K_M) is 16.4 GB. Pi verifies the checksum after download.
                      </DialogDescription>
                    </div>
                  </DialogHeader>
                  <DialogBody>
                    <ProgressBar value={0.42} />
                  </DialogBody>
                  <DialogFooter>
                    <Button variant="ghost">Cancel</Button>
                    <Button variant="primary">Download</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <div className="relative min-h-32 flex-1">
                <Toast
                  open
                  tone="success"
                  title="Model ready"
                  description="Qwen3.6-27B loaded in 3.2s."
                />
                <ToastViewport style={{ position: 'absolute' }} />
              </div>
            </Section>

            <Section title="Controls">
              <Switch aria-label="Toggle" defaultChecked />
              <Switch aria-label="Toggle off" />
              <Checkbox aria-label="Check" defaultChecked />
              <Checkbox aria-label="Uncheck" />
              <SegmentedControl
                aria-label="Mode"
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: 'chat', label: 'Chat' },
                  { value: 'cowork', label: 'Cowork' },
                ]}
              />
            </Section>

            <Section title="Indicators">
              <div style={{ width: 220 }}>
                <ProgressBar value={0.65} />
              </div>
              <div style={{ width: 220 }}>
                <ProgressBar />
              </div>
              <Spinner />
              <ContextGauge value={0.34} />
              <ContextGauge value={0.85} tone="warn" size={20} />
            </Section>

            <Section title="Chips / badges / kbd">
              <Chip icon={<IconPencil size={14} />}>Write</Chip>
              <Chip icon={<IconSearch size={14} />}>Research</Chip>
              <Badge>3</Badge>
              <Badge tone="success">ready</Badge>
              <Badge tone="danger">error</Badge>
              <Kbd keys="⌘K" />
              <Kbd keys="⌘⇧P" appearance="chip" />
              <AttachmentPill name="pi-bridge.ts" meta="12 KB" onRemove={() => {}} />
              <FloatingPill
                title="Continue setup"
                description="2 of 3 steps"
                onDismiss={() => {}}
              />
            </Section>

            <Section title="Shimmer / thinking">
              <ShimmerText>Thinking…</ShimmerText>
              <div className="w-full">
                <ThinkingBlock streaming label="Thinking…">
                  Considering quantization trade-offs for a 24GB machine: Q4_K_M leaves headroom for
                  a 32k context window while MTP adds roughly 40% throughput, so the 27B is the
                  right default rather than the 14B.
                </ThinkingBlock>
              </div>
            </Section>

            <Section title="Thread">
              <Thread style={{ padding: 0 }}>
                <MessageRow
                  kind="user"
                  actions={
                    <IconButton aria-label="Copy" size="sm" variant="ghostMuted">
                      <IconCopy size={14} />
                    </IconButton>
                  }
                >
                  What local model should I run for coding?
                </MessageRow>
                <MessageRow kind="assistant">
                  <Prose>
                    <p>
                      <strong>Qwen3.6-27B at Q4_K_M</strong> — it fits in <code>16.4 GB</code> and
                      MTP decoding adds roughly 40% throughput.
                    </p>
                  </Prose>
                </MessageRow>
              </Thread>
            </Section>

            <Section title="Tool calls / diff">
              <div className="flex w-full flex-col gap-3">
                <ActivityRow icon={<IconTerminal size={14} />} label="Ran pnpm test" />
                <ActivityRow running label="Editing pi-bridge.ts…" />
                <ActivityGroupCard
                  icon={<IconDiff />}
                  title="Edited 2 files"
                  added={78}
                  deleted={6}
                  hoverSubtitle="Review changes"
                  files={[
                    { path: 'packages/engine/src/pi-bridge.ts', added: 76, deleted: 5 },
                    { path: 'packages/shared/src/ipc.ts', added: 2, deleted: 1 },
                  ]}
                  actions={
                    <Button size="sm" variant="outline">
                      Review
                    </Button>
                  }
                />
                <DiffStat added={466} deleted={15} rolling />
                <DiffView files={DIFF} />
              </div>
            </Section>

            <Section title="Markdown / code block">
              <div className="w-full max-w-[560px]">
                <CodeBlock
                  language="bash"
                  showLineNumbers
                  code={
                    'llama-server --model qwen3.6-27b-q4_k_m.gguf \\\n  --spec-type draft-mtp --spec-draft-n-max 2'
                  }
                />
              </div>
            </Section>

            <Section title="Sidebar / top bar shell">
              <div
                className="flex w-full flex-col overflow-hidden rounded-lg"
                style={{ height: 360, background: 'var(--pd-bg-sidebar)' }}
              >
                <TopBar
                  left={
                    <IconButton aria-label="Toggle sidebar">
                      <IconSidebar />
                    </IconButton>
                  }
                  center={<TopBarTitle>Fixing the event router backlog</TopBarTitle>}
                  right={
                    <IconButton aria-label="New chat">
                      <IconChat />
                    </IconButton>
                  }
                />
                <div className="flex min-h-0 flex-1">
                  <Sidebar style={{ width: 220 }}>
                    <SidebarScroll>
                      <SidebarRow
                        icon={<IconPencil size={16} />}
                        label="New chat"
                        meta={<Kbd keys="⌘N" />}
                      />
                      <SidebarSection label="Recents">
                        <SidebarRow icon={<IconChat size={16} />} label="Event router" selected />
                        <SidebarRow icon={<IconChat size={16} />} label="MTP flags" meta="1d" />
                      </SidebarSection>
                    </SidebarScroll>
                    <SidebarFooter avatar="J" name="Jedd" plan="Local" />
                  </Sidebar>
                  <div className="pd-main-surface grid flex-1 place-items-center">
                    <span className="text-text-muted">main surface</span>
                  </div>
                </div>
              </div>
            </Section>

            <Section title="Artifact panel">
              <div className="w-full" style={{ height: 220 }}>
                <ArtifactPanel
                  title="Retro dashboard"
                  byline="Content is user-generated and may contain errors."
                  logo={<IconDiff size={14} />}
                  controls={
                    <IconButton aria-label="Copy" size="sm" variant="ghostMuted">
                      <IconCopy size={14} />
                    </IconButton>
                  }
                >
                  <div className="grid h-full place-items-center text-text-muted">
                    hosted content
                  </div>
                </ArtifactPanel>
              </div>
            </Section>

            <Section title="Canvas — live SVG (draw as code streams) + inline↔side">
              <CanvasGalleryDemo />
            </Section>

            <Section title="Context hover tooltip">
              <ContextGaugeTooltip
                percent={18}
                usedTokens={73_000}
                totalTokens={400_000}
                note="Pi automatically compacts its context."
              />
              <ContextGaugeTooltip
                percent={88}
                usedTokens={352_000}
                totalTokens={400_000}
                note="Pi automatically compacts its context."
              >
                <ContextGauge value={0.88} tone="warn" />
              </ContextGaugeTooltip>
            </Section>

            <Section title="Task progress checklist">
              <div className="w-full max-w-[420px]">
                <TaskChecklist
                  title="Task progress"
                  items={[
                    { label: 'Read the feedback spec', state: 'done' },
                    { label: 'Mount the canvas', state: 'done' },
                    { label: 'Wire the context tooltip', state: 'in-progress' },
                    { label: 'Showcase the gallery', state: 'pending' },
                    { label: 'Package to /Applications', state: 'roadmap' },
                  ]}
                  subagents={{
                    title: 'Subagents',
                    defaultOpen: false,
                    items: [
                      { label: 'canvas-integration', state: 'done' },
                      { label: 'ui-exports', state: 'done' },
                    ],
                  }}
                />
              </div>
            </Section>

            <Section title="Message actions / response speed / model footnote">
              <div className="flex w-full flex-col gap-3">
                <MessageActions
                  onCopy={() => {}}
                  onThumbsUp={() => {}}
                  onThumbsDown={() => {}}
                  onRetry={() => {}}
                  tokenCount={1240}
                  onContext={() => {}}
                />
                <MessageActions onCopy={() => {}} onEdit={() => {}} />
                <div className="flex items-center gap-3">
                  <ResponseSpeed tokensPerSecond={182} />
                  <ModelFootnote model="gemma-4-e2b-it" />
                </div>
              </div>
            </Section>

            <Section title="File input / drop zone">
              <div className="w-full max-w-[420px]">
                <FileDropZone
                  label="Add files or photos"
                  hint="⌘U"
                  accept="image/*"
                  multiple
                  onFiles={() => {}}
                  attachments={
                    <>
                      <AttachmentPill name="diagram.svg" meta="4 KB" onRemove={() => {}} />
                      <AttachmentPill name="screenshot.png" meta="182 KB" onRemove={() => {}} />
                    </>
                  }
                />
              </div>
            </Section>

            <Section title="Add / connectors menu">
              <ComposerAddMenu
                variant="full"
                onAddFiles={() => {}}
                onTakeScreenshot={() => {}}
                onAddConnector={() => {}}
                onAddPlugins={() => {}}
                webSearch={webSearch}
                onWebSearchChange={setWebSearch}
              />
              <ComposerAddMenu variant="attach" onAddFiles={() => {}} onTakeScreenshot={() => {}} />
              <IconConnector size={18} />
            </Section>

            <Section title="Question cards (choice · free · slider)">
              <QuestionCardDemos />
            </Section>

            <Section title="Composer">
              <Composer
                value={composerValue}
                onValueChange={setComposerValue}
                placeholder="How can I help you today?"
                leading={
                  <IconButton aria-label="Add files">
                    <IconPlus />
                  </IconButton>
                }
                trailing={
                  <>
                    <ModelPicker
                      models={MODELS}
                      model={model}
                      onModelChange={setModel}
                      efforts={EFFORTS}
                      effort={effort}
                      onEffortChange={setEffort}
                    />
                    <ContextGauge value={0.34} />
                    <ComposerDivider />
                    <IconButton aria-label="Dictate">
                      <IconMic />
                    </IconButton>
                  </>
                }
              />
            </Section>
          </div>
        </div>
      </ToastProvider>
    </TooltipProvider>
  );
}
