/**
 * What the model has presented this conversation, and how it reaches the canvas.
 *
 * `present` is the top-level model's last act: main raises `present:show`, this
 * records the artefact so the thread can render its card, and opens the right
 * canvas surface so the thing is actually THERE beside the conversation — a page
 * rendered, an image shown, a project's tree open.
 *
 * The canvas kind is chosen from the path here rather than in the tool, because
 * the tool must stay electron-free and the canvas surfaces live on this side.
 */

import type { CanvasTabKind } from '@pi-desktop/canvas';
import type { PresentKind } from '@pi-desktop/ui';
import { create } from 'zustand';
import { getCanvasController } from './canvas-store';

export interface PresentedRecord {
  path: string;
  note?: string;
  kind: PresentKind;
  /** Monotonic, so a re-present of the same path moves it to the end. */
  at: number;
}

/** Extension → how we label it and which canvas surface opens it. */
const BY_EXT: Record<string, { kind: PresentKind; tab: CanvasTabKind }> = {
  png: { kind: 'image', tab: 'image' },
  jpg: { kind: 'image', tab: 'image' },
  jpeg: { kind: 'image', tab: 'image' },
  gif: { kind: 'image', tab: 'image' },
  webp: { kind: 'image', tab: 'image' },
  svg: { kind: 'image', tab: 'svg' },
  html: { kind: 'page', tab: 'html' },
  htm: { kind: 'page', tab: 'html' },
  mp4: { kind: 'media', tab: 'video' },
  mov: { kind: 'media', tab: 'video' },
  webm: { kind: 'media', tab: 'video' },
  md: { kind: 'document', tab: 'file' },
  txt: { kind: 'document', tab: 'file' },
  pdf: { kind: 'document', tab: 'file' },
  py: { kind: 'code', tab: 'file' },
  ts: { kind: 'code', tab: 'file' },
  js: { kind: 'code', tab: 'file' },
  gd: { kind: 'code', tab: 'file' },
  json: { kind: 'code', tab: 'file' },
};

/** Lowercase extension without the dot, or '' when there is none. */
export function extOf(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * Classify a presented path.
 *
 * A path with no extension is treated as a PROJECT and opened as a file tree —
 * that is the case the Godot run got wrong (14 files, none opened), and a tree
 * is the surface that makes "does this actually contain a game?" answerable at a
 * glance.
 */
export function classifyPresented(p: string): { kind: PresentKind; tab: CanvasTabKind } {
  const ext = extOf(p);
  if (ext === '') return { kind: 'project', tab: 'filetree' };
  return BY_EXT[ext] ?? { kind: 'file', tab: 'file' };
}

interface PresentState {
  items: PresentedRecord[];
  add: (item: { path: string; note?: string }) => PresentedRecord;
  clear: () => void;
}

export const usePresentStore = create<PresentState>((set, get) => ({
  items: [],
  add: ({ path, note }) => {
    const { kind } = classifyPresented(path);
    const record: PresentedRecord = {
      path,
      kind,
      at: get().items.length + 1,
      ...(note !== undefined ? { note } : {}),
    };
    // Re-presenting the same artefact REPLACES its row rather than stacking a
    // duplicate — the model iterating on one file is the normal case.
    set((s) => ({ items: [...s.items.filter((i) => i.path !== path), record] }));
    return record;
  },
  clear: () => set({ items: [] }),
}));

/**
 * Wire `present:show` → record it, and OPEN it in the canvas.
 *
 * Opening is the half that makes the card mean something: jedd asked for the
 * artefact "open or running in canvas, if it's a godot game or whatever". The
 * tab is upserted by path, so the model iterating on one file re-uses its tab
 * rather than stacking a new one each pass.
 *
 * Returns the unsubscribe.
 */
/** Open (or focus) a presented artefact's canvas tab. Shared by the event
 * wiring and the card's Open button, so both land on the same tab. */
export async function openPresented(
  controller: { upsertTab: (key: string, spec: never) => string } | null,
  item: { path: string; note?: string },
): Promise<void> {
  if (controller === null) return;
  const { tab } = classifyPresented(item.path);
  const title = item.path.split(/[\\/]/).pop() ?? item.path;
  /*
   * A CANVAS ARTIFACT IS `content: { kind, text }` — the file's TEXT, not a path.
   *
   * This used to pass `artifact: { kind, path, title }`, so every surface that
   * reads `artifact.content.text` threw on `undefined`. React has no error
   * boundary above the thread, so the throw unmounted the entire tree: calling
   * `present` BLANKED THE WHOLE APP. jedd saw it happen — "complete blankscreen
   * after asked for the present tool to be called, I briefly saw the actual UI".
   *
   * It also explains a run of readings I could not make sense of: a document with
   * twelve nodes and no sidebar, blank screenshots, and yet a live, correctly
   * populated present store — React was gone while the module singletons and the
   * window handle survived.
   */
  let text = '';
  try {
    const read = await window.piDesktop.invoke('fs:read-file', { path: item.path });
    text = typeof read?.text === 'string' ? read.text : '';
  } catch {
    // An unreadable file still opens a tab — an empty surface the user can see
    // beats no tab and no explanation.
  }
  controller.upsertTab(`present:${item.path}`, {
    kind: tab,
    title,
    key: `present:${item.path}`,
    artifact: {
      id: `present:${item.path}`,
      title,
      filename: title,
      content: { kind: artifactKindFor(tab), text },
    },
    ...(item.note !== undefined ? { subtitle: item.note } : {}),
  } as never);
}

export function connectPresent(): () => void {
  /*
   * E2E handle, deliberately installed HERE rather than at module scope (same
   * opt-in as `__pi_store`). Its presence proves this wiring ran: presenting a
   * file showed no card and opened no canvas tab, and every link in the chain
   * read as correct — main logged the send, the channel is in the IPC contract,
   * ChatApp calls this, and the card renders unconditionally on a non-empty
   * store. Reading the store from a probe is the only way to tell "the event
   * never arrived" from "it arrived and nothing rendered".
   */
  if (new URLSearchParams(window.location.search).has('piE2E')) {
    (window as unknown as { __present_store?: unknown }).__present_store = () => usePresentStore;
  }
  return window.piDesktop.onEvent('present:show', ({ path, note }) => {
    const record = usePresentStore
      .getState()
      .add({ path, ...(note !== undefined ? { note } : {}) });
    void openPresented(getCanvasController() as never, record);
  });
}

/** Canvas tab kind → the artifact kind its surface expects. */
function artifactKindFor(tab: CanvasTabKind): string {
  switch (tab) {
    case 'image':
      return 'image';
    case 'svg':
      return 'svg';
    case 'html':
      return 'html';
    case 'filetree':
      return 'file';
    default:
      return 'file';
  }
}
