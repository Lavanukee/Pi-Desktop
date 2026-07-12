/**
 * Built-in ("preinstalled") connectors — pi's own bundled tool surfaces that
 * ship inside the app rather than launching an external MCP server. They are
 * always on (never installed, never removed, never spawned), so they carry
 * `kind:'builtin'` + a sentinel empty `command`; the connectors-main IPC no-ops
 * install/remove/enable for them, and the gallery renders a static "Preinstalled"
 * affordance instead of the "+" add button.
 *
 * The set spans two provenance tiers (this distinction drives the gallery
 * sections — see connector-sections.ts):
 *   - Video editing is genuinely OURS (`firstParty:true`) — the "By us" section.
 *   - HyperFrames is HeyGen's official tool (github.com/heygen-com/hyperframes),
 *     bundled/preinstalled but NOT authored by us. It is `firstParty:false` +
 *     `official:true`, so it lands under "Official / Verified", never "By us".
 *
 * Their static {@link KnownConnector.tools} lists are the "real content" the
 * detail view shows — no schema fetch / server spawn is needed to describe what
 * a builtin does. HyperFrames renders motion-graphics scenes to MP4 on-device
 * (its runtime tool is `motion_graphics_render`); Video editing is a typed
 * ffmpeg façade (`video_edit` / `extract_frames` / `probe`).
 *
 * Merged to the FRONT of {@link KNOWN_CONNECTORS} so they cross the connectors
 * IPC in `catalog` and land first in their sections.
 */
import type { KnownConnector } from './detect-apps';

const HYPERFRAMES_DESCRIPTION =
  'Motion-graphics video — the agent authors HTML/CSS/JS and renders it to MP4 ' +
  '(ffmpeg + headless Chrome). Deterministic, on-device, no model weights.';

const VIDEO_EDITING_DESCRIPTION =
  'A typed ffmpeg façade — trim, concat, overlay, extract frames, and probe ' +
  'video, with safe argv (no shell).';

/**
 * The built-in connectors. Each has an empty `template.command` sentinel (it
 * never runs as a server) and a static tool list for the detail view. Icons are
 * neutral line-art glyphs from `connector-icons` (film / cut).
 */
export const BUILTIN_CONNECTORS: KnownConnector[] = [
  {
    id: 'hyperframes',
    name: 'HyperFrames',
    kind: 'builtin',
    // HeyGen's tool — bundled/preinstalled, but NOT authored by us. Official
    // (Verified), never "By us".
    firstParty: false,
    official: true,
    category: 'creative',
    icon: '🎞️',
    homepage: 'https://github.com/heygen-com/hyperframes',
    description: HYPERFRAMES_DESCRIPTION,
    tools: [
      {
        name: 'motion_graphics_render',
        description: 'Render an HTML/CSS/JS motion-graphics scene to an MP4 clip.',
      },
    ],
    template: {
      id: 'hyperframes',
      name: 'HyperFrames',
      icon: '🎞️',
      description: HYPERFRAMES_DESCRIPTION,
      command: '',
    },
  },
  {
    id: 'video-editing',
    name: 'Video editing',
    kind: 'builtin',
    // Genuinely ours — the "By us" section.
    firstParty: true,
    official: true,
    category: 'media',
    icon: '✂️',
    description: VIDEO_EDITING_DESCRIPTION,
    tools: [
      {
        name: 'video_edit',
        description: 'Trim / concat / overlay / burn subtitles via a safe ffmpeg façade.',
      },
      { name: 'extract_frames', description: 'Extract still frames from a clip.' },
      { name: 'probe', description: 'Read a media file’s streams and metadata.' },
    ],
    template: {
      id: 'video-editing',
      name: 'Video editing',
      icon: '✂️',
      description: VIDEO_EDITING_DESCRIPTION,
      command: '',
    },
  },
];

/** Ids of the built-in connectors (stable set). */
export const BUILTIN_CONNECTOR_IDS: readonly string[] = BUILTIN_CONNECTORS.map((c) => c.id);
