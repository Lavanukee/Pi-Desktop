/**
 * ComfyUI modular-download install manager — the Electron/install-layer that
 * fetches the "modality base" (ComfyUI runtime + per-model weight packs) from
 * UPSTREAM, post-install, into an app-controlled dir. This is the GPL-3.0
 * resolution from round-13 §4: ComfyUI is GPL-3.0 software, so it is NEVER
 * bundled in the signed .dmg — the app downloads it separately, talks to it only
 * over a localhost socket (see the ComfyUI backend / supervisor), and treats it
 * as an unmodified upstream runtime. The signed app therefore ships zero GPL code.
 *
 * DESIGN — pure + injected, like inference/download-cancellation.ts and
 * inference/supervisor.ts:
 *   - Everything here is Electron-FREE. All side effects (process spawn, network
 *     fetch, filesystem, persisted consent, progress emission) are injected via
 *     {@link ComfyInstallDeps}, so the whole state machine unit-tests in plain
 *     Node with fakes — NO multi-GB download and NO real install ever runs in a
 *     test (mirrors the gen-service vitest note).
 *   - Self-contained: it re-declares its own plain types instead of importing
 *     @pi-desktop/gen-service (which is not yet an apps/desktop dependency — the
 *     app-wiring lane adds that). Pack ids intentionally MATCH the gen-service
 *     catalog ids (`ltx-2`, `ace-step`, …) so the app maps a catalog entry to its
 *     download pack by id.
 *
 * THE FOUR-STEP FLOW (round-13 §4):
 *   1. one-time GPL-3.0 CONSENT gate (discloses ComfyUI is GPL-3.0 upstream
 *      software fetched separately);
 *   2. create a ComfyUI venv with the bundled `uv` (the app passes the SAME uv
 *      path worker-command.ts resolves) + install ComfyUI + drive the MPS-nightly
 *      torch install OURSELVES (`pip install --pre torch torchvision torchaudio`)
 *      for machine-readable progress (comfy-cli's installer progress is human-only);
 *   3. per-model/node downloads into an app-controlled SHARED models dir, each
 *      gated behind the weight's license-EULA + a progress event;
 *   4. point ComfyUI at the shared dir via an emitted extra_model_paths.yaml
 *      (`--extra-model-paths-config <root>/extra_model_paths.yaml`).
 *
 * ── One-line app wire-ups this module needs (NOT done here, to keep the
 *    round-12/keystone files untouched — mirrors gen-manager.ts's header) ───────
 *   1. Renderer→main: on the consent modal's Accept → invoke `gen:comfy-consent`;
 *      on a per-pack Install → invoke `gen:comfy-start` { packIds, acceptedLicenses }.
 *      Query current state with `gen:comfy-status`.
 *   2. Main→renderer: forward each {@link ComfyInstallEvent} the manager emits over
 *      the `gen:comfy-install` event channel (see gen-ipc-contract.ts) so the UI
 *      renders per-pack progress bars (same style as llm:download-progress).
 *   3. The app constructs {@link ComfyInstallManager} with the bundled uv path
 *      (web-tools `ensureUv`, the same one GenServiceClient uses), an app-data
 *      install root, a settings-backed {@link ConsentStore}, and node fs/spawn/fetch.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Plain types (self-contained; License mirrors the gen-service catalog union)
// ─────────────────────────────────────────────────────────────────────────────

/** The weight-license ids the ComfyUI packs actually use (subset of the
 * gen-service catalog `License` union, re-declared locally to stay dep-free). */
export type ComfyPackLicense =
  | 'apache-2.0'
  | 'mit'
  | 'ltx-2-community'
  | 'stability-community'
  | 'cc-by-nc-4.0';

/** Honesty label for a size figure — `measured` on real hw/repo vs `projected`. */
export type Honesty = 'measured' | 'projected';

/** What a pack installs. `runtime` = the shared ComfyUI+torch base (fetched once);
 * `model` = weights into the shared models dir; `custom-node` = an upstream node
 * pack (git). We author NO custom nodes ourselves (that would be GPL-derivative,
 * §4) — behaviour is injected only via workflow-JSON templates. */
export type ComfyPackKind = 'runtime' | 'model' | 'custom-node';

/** One downloadable unit of the modality base. */
export interface ComfyPack {
  /** Stable id — MATCHES the gen-service catalog id for model packs. */
  readonly id: string;
  readonly label: string;
  readonly kind: ComfyPackKind;
  /** Approx on-disk footprint (GB) — the §4 disk-footprint table, as data. */
  readonly sizeGB: number;
  /** Whether `sizeGB` is measured or projected (§4 "Basis" column). */
  readonly honesty: Honesty;
  /** License of the WEIGHTS (the runtime pack is app-side permissive glue). */
  readonly license: ComfyPackLicense;
  /** commercialUse=false → an EULA gate must be cleared before download. */
  readonly commercialUse: boolean;
  /** gen-service catalog id(s) this pack unlocks (empty for the shared runtime). */
  readonly unlocks: readonly string[];
  /** Where the files land, relative to the shared models dir (e.g. `unet`,
   * `checkpoints`, `audio_encoders`) — undefined for the runtime pack. */
  readonly targetSubdir?: string;
  /** Fetch source: an HF repo id (direct-HF / `comfy model download`) or a git
   * url for a custom-node pack. Undefined for the runtime pack. */
  readonly source?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The pack catalog + the §4 disk-footprint table (as data)
// ─────────────────────────────────────────────────────────────────────────────

/** The shared ComfyUI runtime pack (venv + ComfyUI + MPS-nightly torch). Fetched
 * ONCE; unlocks every comfyui-backed catalog entry. ~5–7GB is a PROJECTION (torch
 * wheel + the Windows-portable measurement), not a measured Mac number — verify on
 * the first real install (§6). */
export const COMFY_RUNTIME_PACK: ComfyPack = {
  id: 'comfyui-runtime',
  label: 'ComfyUI runtime (venv + MPS torch)',
  kind: 'runtime',
  sizeGB: 6,
  honesty: 'projected',
  license: 'apache-2.0',
  commercialUse: true,
  unlocks: [],
};

/** The installable ComfyUI model packs. Ids match the gen-service catalog. Each
 * `commercialUse:false` pack is EULA-gated (LTX-2 Community, Stability-Community).
 * `ltx-2-22b` is intentionally ABSENT — it is `runsLocally:false` and routes to a
 * remote ComfyUI, so it is not a local download pack. */
export const COMFY_MODEL_PACKS: readonly ComfyPack[] = [
  {
    id: 'flux1-dev-gguf',
    label: 'FLUX.1-dev GGUF Q6_K (advanced image)',
    kind: 'model',
    sizeGB: 10,
    honesty: 'measured',
    license: 'apache-2.0',
    commercialUse: true,
    unlocks: ['flux1-dev-gguf'],
    targetSubdir: 'unet',
    source: 'city96/FLUX.1-dev-gguf',
  },
  {
    id: 'ltx-video-2b-distilled',
    label: 'LTX-Video 2B distilled GGUF (fast video)',
    kind: 'model',
    sizeGB: 8,
    honesty: 'measured',
    license: 'ltx-2-community',
    commercialUse: false,
    unlocks: ['ltx-video-2b-distilled'],
    targetSubdir: 'checkpoints',
    source: 'Lightricks/LTX-Video',
  },
  {
    id: 'ltx-2',
    label: 'LTX-2 distilled GGUF stack (default video)',
    kind: 'model',
    sizeGB: 24,
    honesty: 'projected',
    license: 'ltx-2-community',
    commercialUse: false,
    unlocks: ['ltx-2'],
    targetSubdir: 'checkpoints',
    source: 'Lightricks/LTX-2',
  },
  {
    id: 'ace-step',
    label: 'ACE-Step (music/SFX)',
    kind: 'model',
    sizeGB: 7,
    honesty: 'measured',
    license: 'apache-2.0',
    commercialUse: true,
    unlocks: ['ace-step'],
    targetSubdir: 'checkpoints',
    source: 'ACE-Step/ACE-Step',
  },
  {
    id: 'stable-audio-open',
    label: 'Stable Audio Open 1.0 (SFX)',
    kind: 'model',
    sizeGB: 5,
    honesty: 'measured',
    license: 'stability-community',
    commercialUse: false,
    unlocks: ['stable-audio-open'],
    targetSubdir: 'checkpoints',
    source: 'stabilityai/stable-audio-open-1.0',
  },
];

/** Runtime + all model packs, keyed for O(1) lookup. */
export const COMFY_PACKS: readonly ComfyPack[] = [COMFY_RUNTIME_PACK, ...COMFY_MODEL_PACKS];
const PACK_BY_ID: ReadonlyMap<string, ComfyPack> = new Map(COMFY_PACKS.map((p) => [p.id, p]));

/** Look up a pack by id. */
export function getPack(id: string): ComfyPack | undefined {
  return PACK_BY_ID.get(id);
}

/**
 * The full round-13 §4 disk-footprint table, as data — includes rows the ComfyUI
 * manager does NOT install (trellis2-mlx is an MLX worker, the mflux image weights
 * are uv-worker), flagged `viaComfy:false`, so the UI can show a single honest
 * "how much disk will this cost" table across backends.
 */
export interface DiskFootprintRow {
  readonly component: string;
  readonly sizeGB: number;
  readonly honesty: Honesty;
  /** True → fetched by THIS manager; false → a different backend (MLX/uv worker). */
  readonly viaComfy: boolean;
}

export const DISK_FOOTPRINT: readonly DiskFootprintRow[] = [
  {
    component: 'ComfyUI base runtime (venv + torch MPS wheel)',
    sizeGB: 6,
    honesty: 'projected',
    viaComfy: true,
  },
  { component: 'FLUX GGUF Q6 (advanced image)', sizeGB: 10, honesty: 'measured', viaComfy: true },
  {
    component: 'LTX distilled stack (default video)',
    sizeGB: 24,
    honesty: 'projected',
    viaComfy: true,
  },
  {
    component: 'LTX-Video 2B distilled (fast video)',
    sizeGB: 8,
    honesty: 'measured',
    viaComfy: true,
  },
  { component: 'ACE-Step (music)', sizeGB: 7, honesty: 'measured', viaComfy: true },
  { component: 'Stable Audio Open (SFX)', sizeGB: 5, honesty: 'measured', viaComfy: true },
  {
    component: 'trellis2-mlx weights (3D — MLX worker, NOT ComfyUI)',
    sizeGB: 15,
    honesty: 'measured',
    viaComfy: false,
  },
  {
    component: 'mflux image · Qwen-Image (uv worker, NOT ComfyUI)',
    sizeGB: 24,
    honesty: 'measured',
    viaComfy: false,
  },
  {
    component: 'mflux image · FLUX.2 klein (uv worker, NOT ComfyUI)',
    sizeGB: 4.3,
    honesty: 'measured',
    viaComfy: false,
  },
  {
    component: 'mflux image · Z-Image (uv worker, NOT ComfyUI)',
    sizeGB: 3.5,
    honesty: 'measured',
    viaComfy: false,
  },
];

/** Sum the on-disk footprint (GB) of a set of packs (the UI's "this download will
 * use ~N GB" figure). Unknown ids are ignored. */
export function totalInstallGB(packIds: readonly string[]): number {
  return packIds.reduce((sum, id) => sum + (PACK_BY_ID.get(id)?.sizeGB ?? 0), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// GPL-3.0 consent disclosure (the one-time gate copy the renderer shows)
// ─────────────────────────────────────────────────────────────────────────────

/** The one-time disclosure the consent modal MUST show before any ComfyUI fetch.
 * Keeps the GPL-3.0 relationship explicit and honest (§4). */
export const GPL_CONSENT_DISCLOSURE =
  'To generate video, music, and advanced-image outputs, this app can download ' +
  'ComfyUI — separate, third-party software licensed under the GNU GPL-3.0 — from ' +
  'its upstream source. ComfyUI is NOT part of this application: it is installed ' +
  'alongside it and runs as its own local program that the app communicates with ' +
  'over a private localhost connection. Model weights are downloaded under their ' +
  "own licenses, shown per model before each download. You'll only be asked once.";

// ─────────────────────────────────────────────────────────────────────────────
// On-disk layout (pure) — where each piece lives under the app install root
// ─────────────────────────────────────────────────────────────────────────────

/** The resolved absolute paths for a ComfyUI install rooted at `root`. Uses `/`
 * joins (posix) — the app passes an absolute root and these are the canonical
 * sub-paths; `join` is injected in {@link ComfyInstallDeps} for real fs work. */
export interface ComfyLayout {
  readonly root: string;
  /** venv dir the bundled uv creates. */
  readonly venvDir: string;
  /** venv python interpreter (`--python` target for uv pip installs). */
  readonly venvPython: string;
  /** Cloned/installed upstream ComfyUI dir (contains main.py). */
  readonly comfyDir: string;
  /** ComfyUI entrypoint — its presence marks the runtime "installed". */
  readonly comfyMain: string;
  /** App-controlled SHARED models dir (base_path in extra_model_paths.yaml). */
  readonly sharedModelsDir: string;
  /** App-controlled custom_nodes dir. */
  readonly customNodesDir: string;
  /** The emitted extra_model_paths.yaml (passed via --extra-model-paths-config). */
  readonly extraModelPathsYaml: string;
  /** Per-pack install-manifest dir — a marker here records a verified download,
   * decoupling "installed?" from the (forward-dated) weight filenames and from
   * the fact that several packs share the `checkpoints` subdir. */
  readonly packStateDir: string;
}

/** Derive the canonical layout under an absolute install `root`. Pure. */
export function comfyLayout(root: string): ComfyLayout {
  const j = (...parts: string[]): string => [root, ...parts].join('/');
  return {
    root,
    venvDir: j('venv'),
    venvPython: j('venv', 'bin', 'python'),
    comfyDir: j('ComfyUI'),
    comfyMain: j('ComfyUI', 'main.py'),
    sharedModelsDir: j('shared-models'),
    customNodesDir: j('shared-custom-nodes'),
    extraModelPathsYaml: j('extra_model_paths.yaml'),
    packStateDir: j('.pi-packs'),
  };
}

/** The install-manifest marker path for one pack (present ⇒ downloaded). Pure. */
export function packMarkerPath(layout: ComfyLayout, packId: string): string {
  return [layout.packStateDir, `${packId}.installed`].join('/');
}

// ─────────────────────────────────────────────────────────────────────────────
// extra_model_paths.yaml emission (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** The model subdirs ComfyUI expects under the shared base_path. Every model pack
 * `targetSubdir` must be one of these so downloads are discoverable. */
export const COMFY_MODEL_SUBDIRS = [
  'checkpoints',
  'unet',
  'diffusion_models',
  'clip',
  'clip_vision',
  'text_encoders',
  'audio_encoders',
  'vae',
  'loras',
  'controlnet',
  'upscale_models',
] as const;

/**
 * Emit the `extra_model_paths.yaml` that points an UNMODIFIED upstream ComfyUI at
 * our app-controlled shared dirs (so we never write into ComfyUI's own tree —
 * keeping it a clean, replaceable upstream install). Hand-rolled (no yaml dep) so
 * the output is deterministic and exactly testable. Mirrors ComfyUI's documented
 * `extra_model_paths.yaml` schema (a named root with `base_path` + per-type
 * subdirs + `custom_nodes`).
 */
export function emitExtraModelPathsYaml(layout: ComfyLayout): string {
  const lines: string[] = [
    '# Generated by Bobble — points ComfyUI at the app-controlled shared dirs.',
    '# Do not edit by hand; regenerated on each install.',
    'pi_desktop:',
    `  base_path: ${layout.sharedModelsDir}`,
    '  is_default: true',
  ];
  for (const subdir of COMFY_MODEL_SUBDIRS) {
    lines.push(`  ${subdir}: ${subdir}`);
  }
  lines.push(`  custom_nodes: ${layout.customNodesDir}`);
  return `${lines.join('\n')}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Install-state detection (pure) — installed vs needs-download
// ─────────────────────────────────────────────────────────────────────────────

/** Runtime readiness derived from the probe. */
export type ComfyRuntimeState =
  /** GPL consent not yet given — nothing may be fetched. */
  | 'consent-required'
  /** Consent given, but the venv/ComfyUI/torch base is not present. */
  | 'runtime-missing'
  /** The shared runtime is installed and ready to serve. */
  | 'runtime-ready';

/** Per-pack install + gate status. */
export interface ComfyPackStatus {
  readonly id: string;
  /** Files present in the shared models dir. */
  readonly installed: boolean;
  /** commercialUse=false → needs an EULA accepted before download. */
  readonly gated: boolean;
  /** Whether the EULA gate is cleared (always true for un-gated packs). */
  readonly cleared: boolean;
}

/** The full derived install state (what `gen:comfy-status` returns to the UI). */
export interface ComfyInstallState {
  readonly runtime: ComfyRuntimeState;
  readonly packs: readonly ComfyPackStatus[];
  /** Whether extra_model_paths.yaml has been written. */
  readonly configWritten: boolean;
}

/** Raw filesystem/consent facts the manager gathers before deriving state. */
export interface ComfyInstallProbe {
  readonly consentGiven: boolean;
  readonly comfyMainExists: boolean;
  readonly venvPythonExists: boolean;
  readonly configExists: boolean;
  /** Ids of model packs whose shared-models target dir is non-empty. */
  readonly installedPackIds: readonly string[];
}

/** True when the pack needs no gate, or its license is in `acceptedLicenses`. */
export function packGateCleared(
  pack: ComfyPack,
  acceptedLicenses: readonly ComfyPackLicense[],
): boolean {
  if (pack.commercialUse) return true;
  return acceptedLicenses.includes(pack.license);
}

/**
 * Derive the install state from raw probe facts + which weight EULAs the user has
 * accepted. Pure — the single source of truth for "installed vs needs-download"
 * and the gate status per pack.
 */
export function detectInstallState(
  probe: ComfyInstallProbe,
  acceptedLicenses: readonly ComfyPackLicense[] = [],
): ComfyInstallState {
  const runtime: ComfyRuntimeState = !probe.consentGiven
    ? 'consent-required'
    : probe.comfyMainExists && probe.venvPythonExists
      ? 'runtime-ready'
      : 'runtime-missing';

  const packs: ComfyPackStatus[] = COMFY_MODEL_PACKS.map((pack) => ({
    id: pack.id,
    installed: probe.installedPackIds.includes(pack.id),
    gated: !pack.commercialUse,
    cleared: packGateCleared(pack, acceptedLicenses),
  }));

  return { runtime, packs, configWritten: probe.configExists };
}

// ─────────────────────────────────────────────────────────────────────────────
// The install step machine (pure) — step sequencing
// ─────────────────────────────────────────────────────────────────────────────

/** The ordered kinds of work the installer performs. */
export type ComfyInstallStepKind =
  /** One-time GPL-3.0 disclosure gate. */
  | 'consent'
  /** `uv venv` — create the ComfyUI venv with the bundled uv. */
  | 'create-venv'
  /** Install ComfyUI into the venv (via comfy-cli). */
  | 'install-comfyui'
  /** Drive the MPS-nightly torch install ourselves (machine-readable progress). */
  | 'install-torch'
  /** Download one model/node pack into the shared dir (gated). */
  | 'download-pack'
  /** Write extra_model_paths.yaml pointing ComfyUI at the shared dir. */
  | 'write-config';

/** One planned step. `download-pack` carries the pack it fetches. */
export interface ComfyInstallStep {
  readonly kind: ComfyInstallStepKind;
  readonly label: string;
  /** For `download-pack` — the pack id + whether it is EULA-gated. */
  readonly packId?: string;
  readonly gated?: boolean;
}

/**
 * Plan the ordered steps to reach "runtime-ready + requested packs installed +
 * config written", given the current derived state. Pure — the heart of the step
 * machine, independently testable:
 *   - consent first (only when required);
 *   - the shared runtime (venv → ComfyUI → torch) only when not already ready;
 *   - one download-pack per requested pack that is not already installed;
 *   - write-config whenever any runtime/download work happens OR the yaml is
 *     missing (so an already-installed base still (re)points at the shared dir).
 * Returns `[]` when nothing needs doing → the "fully installed" signal.
 */
export function planInstall(
  state: ComfyInstallState,
  requestedPackIds: readonly string[] = [],
): ComfyInstallStep[] {
  const steps: ComfyInstallStep[] = [];

  if (state.runtime === 'consent-required') {
    steps.push({ kind: 'consent', label: 'Review the ComfyUI (GPL-3.0) disclosure' });
  }
  if (state.runtime !== 'runtime-ready') {
    steps.push(
      { kind: 'create-venv', label: 'Create the ComfyUI Python environment' },
      { kind: 'install-comfyui', label: 'Install ComfyUI' },
      { kind: 'install-torch', label: 'Install PyTorch (Metal / MPS nightly)' },
    );
  }

  const statusById = new Map(state.packs.map((p) => [p.id, p]));
  for (const id of requestedPackIds) {
    const pack = PACK_BY_ID.get(id);
    if (pack === undefined || pack.kind === 'runtime') continue;
    const status = statusById.get(id);
    if (status?.installed === true) continue;
    steps.push({
      kind: 'download-pack',
      packId: id,
      gated: !pack.commercialUse,
      label: `Download ${pack.label}`,
    });
  }

  const didRuntimeWork = state.runtime !== 'runtime-ready';
  const didDownload = steps.some((s) => s.kind === 'download-pack');
  if (didRuntimeWork || didDownload || !state.configWritten) {
    steps.push({ kind: 'write-config', label: 'Point ComfyUI at the shared models folder' });
  }
  return steps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress events (reuse the gen:* IPC shape — a small typed union)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A typed install-progress event — the same STYLE as the gen:* / llm:download-
 * progress IPC payloads (a small discriminated union). The app forwards each of
 * these over the `gen:comfy-install` event channel; the renderer drives per-pack
 * progress bars + the consent modal from them.
 */
export type ComfyInstallEvent =
  /** The GPL consent gate must be shown before anything is fetched. */
  | { readonly kind: 'consent-required'; readonly disclosure: string }
  /** A step began. `index`/`total` drive an overall step counter. */
  | {
      readonly kind: 'step-start';
      readonly step: ComfyInstallStepKind;
      readonly label: string;
      readonly index: number;
      readonly total: number;
      readonly packId?: string;
    }
  /** Progress within a step. `ratio` in [0,1] when a byte total is known. */
  | {
      readonly kind: 'progress';
      readonly step: ComfyInstallStepKind;
      readonly packId?: string;
      readonly ratio?: number;
      readonly receivedBytes?: number;
      readonly totalBytes?: number;
      readonly detail?: string;
    }
  /** A step finished successfully. */
  | { readonly kind: 'step-done'; readonly step: ComfyInstallStepKind; readonly packId?: string }
  /** A gated pack was requested without its EULA accepted — blocked, not fetched. */
  | {
      readonly kind: 'blocked';
      readonly packId: string;
      readonly license: ComfyPackLicense;
      readonly reason: 'license-not-accepted';
    }
  /** Terminal success: the requested install completed. */
  | { readonly kind: 'done'; readonly installedPackIds: readonly string[] }
  /** Terminal failure. */
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly step?: ComfyInstallStepKind;
      readonly packId?: string;
    };

/**
 * Map a raw byte-progress reading (from a streaming HF/direct download) into a
 * `progress` event, computing a clamped [0,1] ratio when a total is known. Pure —
 * the "progress-event mapping" unit under test.
 */
export function downloadProgressEvent(
  step: ComfyInstallStepKind,
  packId: string,
  receivedBytes: number,
  totalBytes: number | null,
): Extract<ComfyInstallEvent, { kind: 'progress' }> {
  const ratio =
    totalBytes !== null && totalBytes > 0
      ? Math.max(0, Math.min(1, receivedBytes / totalBytes))
      : undefined;
  return {
    kind: 'progress',
    step,
    packId,
    receivedBytes,
    totalBytes: totalBytes ?? undefined,
    ratio,
  };
}

/**
 * Map a machine-readable uv/pip stdout line into an advisory `progress` event
 * (coarse, `detail`-only — pip/uv give lifecycle lines, not byte totals, which is
 * exactly why §4 says drive torch ourselves for progress at all). Returns null for
 * a line that carries no signal. Pure.
 */
export function uvProgressEvent(
  step: ComfyInstallStepKind,
  line: string,
): Extract<ComfyInstallEvent, { kind: 'progress' }> | null {
  const trimmed = line.trim();
  // uv/pip resolver + installer lifecycle markers worth surfacing.
  const m = /^(Resolved|Prepared|Installed|Downloading|Building|Collecting|Installing)\b.*/i.exec(
    trimmed,
  );
  if (m === null) return null;
  return { kind: 'progress', step, detail: trimmed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Injected side-effect ports (so the manager unit-tests with fakes)
// ─────────────────────────────────────────────────────────────────────────────

/** Structural slice of a spawned child process (mirrors supervisor's fake seam). */
export interface ComfyChildProcess {
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void;
}

export type ComfySpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
) => ComfyChildProcess;

/** Injected filesystem ops (node:fs/promises in production). */
export interface ComfyFsOps {
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
}

/** Persisted one-time GPL consent (settings-backed in production). */
export interface ConsentStore {
  hasConsent(): Promise<boolean>;
  setConsent(): Promise<void>;
}

/** Streaming byte download (direct-HF). Reports received/total; must honour the
 * signal. In production a fetch-based streamer; a fake in tests. */
export type ComfyDownloadFn = (
  source: string,
  destDir: string,
  onBytes: (received: number, total: number | null) => void,
) => Promise<void>;

// ─────────────────────────────────────────────────────────────────────────────
// uv / pip argv builders (pure) — "reuse worker-command's uv resolution"
// ─────────────────────────────────────────────────────────────────────────────

/** Default uv-provisioned Python — MATCHES worker-command.ts DEFAULT_PYTHON_VERSION
 * (kept in sync deliberately; re-declared to avoid the gen-service import). */
export const COMFY_PYTHON_VERSION = '3.12';

/** PyTorch nightly index for the MPS wheels. [projected] verify at pin time (§6). */
export const TORCH_NIGHTLY_INDEX = 'https://download.pytorch.org/whl/nightly/cpu';

/** `uv venv --python <v> <venvDir>` — create the ComfyUI environment. Pure. */
export function venvArgs(pythonVersion: string, venvDir: string): string[] {
  return ['venv', '--python', pythonVersion, venvDir];
}

/** `uv pip install --python <venvPython> [--pre] <pkgs…> [--index-url <url>]`. Pure. */
export function uvPipInstallArgs(
  venvPython: string,
  packages: readonly string[],
  opts: { pre?: boolean; indexUrl?: string } = {},
): string[] {
  const args = ['pip', 'install', '--python', venvPython];
  if (opts.pre === true) args.push('--pre');
  args.push(...packages);
  if (opts.indexUrl !== undefined) args.push('--index-url', opts.indexUrl);
  return args;
}

/** Args to install ComfyUI itself (via comfy-cli, into the given ComfyUI dir).
 * `--skip-torch` because we drive the MPS-nightly torch install OURSELVES next
 * (§4 step 2). Pure. */
export function installComfyuiArgs(comfyDir: string): string[] {
  return ['run', 'comfy', '--here', 'install', '--skip-torch-or-directml', '--workspace', comfyDir];
}

/** Args for the MPS-nightly torch install we drive ourselves. Pure. */
export function torchInstallArgs(venvPython: string): string[] {
  return uvPipInstallArgs(venvPython, ['torch', 'torchvision', 'torchaudio'], {
    pre: true,
    indexUrl: TORCH_NIGHTLY_INDEX,
  });
}

/** Fallback repo download via comfy-cli when direct-HF streaming is not used
 * (`comfy model download` drives HF for a repo). Pure. */
export function modelDownloadArgs(source: string, destDir: string): string[] {
  return ['run', 'comfy', 'model', 'download', '--url', source, '--relative-path', destDir];
}

// ─────────────────────────────────────────────────────────────────────────────
// The install manager — orchestrates the step machine over the injected ports
// ─────────────────────────────────────────────────────────────────────────────

/** A step failed / a gate blocked — carries the step for the UI. */
export class ComfyInstallError extends Error {
  constructor(
    message: string,
    readonly step?: ComfyInstallStepKind,
    readonly packId?: string,
  ) {
    super(message);
    this.name = 'ComfyInstallError';
  }
}

export interface ComfyInstallDeps {
  /** Absolute app-data install root (e.g. <userData>/comfyui). */
  readonly root: string;
  /** Bundled `uv` binary path — the SAME one worker-command resolves (ensureUv). */
  readonly uvPath: string;
  /** uv-provisioned Python version (default {@link COMFY_PYTHON_VERSION}). */
  readonly pythonVersion?: string;
  readonly spawn: ComfySpawnFn;
  readonly fs: ComfyFsOps;
  readonly consentStore: ConsentStore;
  /** Streaming direct-HF download (byte progress). Optional — falls back to the
   * comfy-cli `model download` spawn when absent. */
  readonly download?: ComfyDownloadFn;
  /** Sink for progress events (the app forwards these over `gen:comfy-install`). */
  readonly emit: (event: ComfyInstallEvent) => void;
}

export class ComfyInstallManager {
  private readonly layout: ComfyLayout;
  private readonly pythonVersion: string;

  constructor(private readonly deps: ComfyInstallDeps) {
    this.layout = comfyLayout(deps.root);
    this.pythonVersion = deps.pythonVersion ?? COMFY_PYTHON_VERSION;
  }

  /** Where everything lives (exposed so the supervisor can pass
   * `--extra-model-paths-config <extraModelPathsYaml>`). */
  get paths(): ComfyLayout {
    return this.layout;
  }

  /** Gather raw facts from disk + the consent store. */
  async probe(): Promise<ComfyInstallProbe> {
    const [consentGiven, comfyMainExists, venvPythonExists, configExists] = await Promise.all([
      this.deps.consentStore.hasConsent(),
      this.deps.fs.exists(this.layout.comfyMain),
      this.deps.fs.exists(this.layout.venvPython),
      this.deps.fs.exists(this.layout.extraModelPathsYaml),
    ]);
    const installed: string[] = [];
    for (const pack of COMFY_MODEL_PACKS) {
      // A pack is "installed" when its manifest marker is present (written only
      // after a verified download) — robust to shared subdirs + [fwd] filenames.
      if (await this.deps.fs.exists(packMarkerPath(this.layout, pack.id))) installed.push(pack.id);
    }
    return {
      consentGiven,
      comfyMainExists,
      venvPythonExists,
      configExists,
      installedPackIds: installed,
    };
  }

  /** Current derived state (backs `gen:comfy-status`). */
  async status(acceptedLicenses: readonly ComfyPackLicense[] = []): Promise<ComfyInstallState> {
    return detectInstallState(await this.probe(), acceptedLicenses);
  }

  /** Persist the one-time GPL consent (the consent modal's Accept). */
  async recordConsent(): Promise<void> {
    await this.deps.consentStore.setConsent();
  }

  /**
   * Run the install to reach "runtime-ready + requested packs installed + config
   * written". Emits a {@link ComfyInstallEvent} for every step + progress reading.
   * Enforces the per-pack EULA gate: a requested gated pack whose license is not
   * in `acceptedLicenses` emits `blocked` and aborts (nothing is fetched). Returns
   * the final derived state. Idempotent: a fully-installed base plans `[]` steps
   * and completes immediately.
   */
  async run(
    requestedPackIds: readonly string[] = [],
    acceptedLicenses: readonly ComfyPackLicense[] = [],
  ): Promise<ComfyInstallState> {
    const state = await this.status(acceptedLicenses);
    if (state.runtime === 'consent-required') {
      this.deps.emit({ kind: 'consent-required', disclosure: GPL_CONSENT_DISCLOSURE });
      throw new ComfyInstallError('GPL-3.0 consent required before install', 'consent');
    }

    // Gate check BEFORE any work: a requested gated pack without its EULA blocks.
    for (const id of requestedPackIds) {
      const pack = PACK_BY_ID.get(id);
      if (pack === undefined || pack.commercialUse) continue;
      if (!packGateCleared(pack, acceptedLicenses)) {
        this.deps.emit({
          kind: 'blocked',
          packId: id,
          license: pack.license,
          reason: 'license-not-accepted',
        });
        throw new ComfyInstallError(`license not accepted for "${id}"`, 'download-pack', id);
      }
    }

    const steps = planInstall(state, requestedPackIds);
    const total = steps.length;
    try {
      for (const [i, step] of steps.entries()) {
        this.deps.emit({
          kind: 'step-start',
          step: step.kind,
          label: step.label,
          index: i,
          total,
          packId: step.packId,
        });
        await this.runStep(step);
        this.deps.emit({ kind: 'step-done', step: step.kind, packId: step.packId });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.emit({ kind: 'error', message });
      throw err;
    }

    const final = await this.status(acceptedLicenses);
    this.deps.emit({
      kind: 'done',
      installedPackIds: final.packs.filter((p) => p.installed).map((p) => p.id),
    });
    return final;
  }

  private async runStep(step: ComfyInstallStep): Promise<void> {
    switch (step.kind) {
      case 'consent':
        // Consent was already recorded (run() refuses to proceed otherwise); this
        // step is a no-op marker so the UI shows the gate was cleared.
        return;
      case 'create-venv':
        await this.deps.fs.mkdirp(this.layout.root);
        await this.spawnStep(
          step,
          this.deps.uvPath,
          venvArgs(this.pythonVersion, this.layout.venvDir),
        );
        return;
      case 'install-comfyui':
        await this.spawnStep(step, this.deps.uvPath, installComfyuiArgs(this.layout.comfyDir));
        return;
      case 'install-torch':
        await this.spawnStep(step, this.deps.uvPath, torchInstallArgs(this.layout.venvPython));
        return;
      case 'download-pack':
        await this.downloadPack(step);
        return;
      case 'write-config':
        await this.deps.fs.mkdirp(this.layout.sharedModelsDir);
        await this.deps.fs.mkdirp(this.layout.customNodesDir);
        await this.deps.fs.writeFile(
          this.layout.extraModelPathsYaml,
          emitExtraModelPathsYaml(this.layout),
        );
        return;
    }
  }

  /** Spawn a uv command, streaming stdout lines → advisory progress, and resolve
   * on exit(0) / reject on a non-zero exit. */
  private spawnStep(
    step: ComfyInstallStep,
    command: string,
    args: readonly string[],
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let child: ComfyChildProcess;
      try {
        child = this.deps.spawn(command, args, { cwd: this.layout.root });
      } catch (err) {
        reject(new ComfyInstallError(err instanceof Error ? err.message : String(err), step.kind));
        return;
      }
      const onLine = (chunk: Buffer | string): void => {
        for (const line of String(chunk).split('\n')) {
          const ev = uvProgressEvent(step.kind, line);
          if (ev !== null) this.deps.emit(ev);
        }
      };
      child.stdout?.on('data', onLine);
      child.stderr?.on('data', onLine);
      child.on('error', (err) =>
        reject(new ComfyInstallError(String(err), step.kind, step.packId)),
      );
      child.on('exit', (code) => {
        if (code === 0 || code === null) resolve();
        else
          reject(
            new ComfyInstallError(`step "${step.kind}" exited ${code}`, step.kind, step.packId),
          );
      });
    });
  }

  /** Download one model pack: prefer the injected byte-accurate direct-HF streamer;
   * otherwise drive `comfy model download` and surface coarse lifecycle progress. */
  private async downloadPack(step: ComfyInstallStep): Promise<void> {
    const pack = step.packId !== undefined ? PACK_BY_ID.get(step.packId) : undefined;
    if (pack === undefined || pack.source === undefined || pack.targetSubdir === undefined) {
      throw new ComfyInstallError(
        `unknown or non-downloadable pack "${step.packId ?? ''}"`,
        step.kind,
        step.packId,
      );
    }
    const destDir = [this.layout.sharedModelsDir, pack.targetSubdir].join('/');
    await this.deps.fs.mkdirp(destDir);

    if (this.deps.download !== undefined) {
      await this.deps.download(pack.source, destDir, (received, totalBytes) => {
        this.deps.emit(downloadProgressEvent(step.kind, pack.id, received, totalBytes));
      });
    } else {
      await this.spawnStep(step, this.deps.uvPath, modelDownloadArgs(pack.source, destDir));
    }
    // Record the verified download in the manifest so a re-probe sees it installed.
    await this.deps.fs.mkdirp(this.layout.packStateDir);
    await this.deps.fs.writeFile(packMarkerPath(this.layout, pack.id), `${pack.source}\n`);
  }
}
