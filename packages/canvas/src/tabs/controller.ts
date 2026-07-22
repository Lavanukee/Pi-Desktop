import {
  type CanvasState,
  type CanvasTab,
  type CanvasTabSpec,
  emptyCanvasState,
} from './tab-model.ts';

let autoCounter = 0;
function defaultIdFactory(): string {
  autoCounter += 1;
  return `pd-canvas-tab-${autoCounter}`;
}

export interface CanvasControllerOptions {
  /** Deterministic id generator (tests / SSR); defaults to a process counter. */
  idFactory?: () => string;
  /** Seed state (the app can restore tabs on launch). */
  initialState?: Partial<CanvasState>;
}

/**
 * CanvasController — the pure, framework-agnostic store the APP drives from its
 * tool-call handlers. It owns tab state and notifies subscribers on change; the
 * React layer (`useCanvasTabs`) is a thin `useSyncExternalStore` adapter over
 * it. Every mutation returns a *new* `CanvasState` object (referential equality
 * is the change signal) and no-ops when nothing changed.
 *
 * Method contract (the app calls these):
 *   openTab(spec)          → id      append a tab, focus it, un-collapse.
 *   upsertTab(key, spec)   → id      focus+update the tab with this key, else open one.
 *   focusTab(id)           → void    make `id` active + un-collapse (no-op if unknown).
 *   closeTab(id)           → void    remove `id`; active falls to a neighbour (or null).
 *   updateTab(id, patch)   → void    merge live state into a tab (browser url, media status…).
 *   setCollapsed(bool)     → void    minimize / restore the canvas.
 *   setFullscreen(bool)    → void    expand / restore.
 *   reset()                → void    clear all tabs.
 */
export class CanvasController {
  #state: CanvasState;
  readonly #idFactory: () => string;
  readonly #listeners = new Set<() => void>();

  constructor(options: CanvasControllerOptions = {}) {
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#state = { ...emptyCanvasState, ...options.initialState };
  }

  /** Current snapshot (stable reference until the next mutation). */
  getState(): CanvasState {
    return this.#state;
  }

  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #commit(next: CanvasState): void {
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  /** Append a tab, focus it, and un-collapse the canvas. Returns the new id. */
  openTab(spec: CanvasTabSpec): string {
    const id = spec.id ?? this.#idFactory();
    const tab: CanvasTab = { ...spec, id };
    this.#commit({
      ...this.#state,
      tabs: [...this.#state.tabs, tab],
      activeTabId: id,
      collapsed: false,
    });
    return id;
  }

  /**
   * Open-or-focus by stable key. If a tab already carries `key`, its spec is
   * merged in and it is focused (its id is preserved so native views survive);
   * otherwise a fresh tab is opened with that key. Returns the tab id either way.
   */
  upsertTab(key: string, spec: CanvasTabSpec): string {
    const existing = this.#state.tabs.find((tab) => tab.key === key);
    if (!existing) return this.openTab({ ...spec, key });
    const merged: CanvasTab = { ...existing, ...spec, id: existing.id, key };
    this.#commit({
      ...this.#state,
      tabs: this.#state.tabs.map((tab) => (tab.id === existing.id ? merged : tab)),
      activeTabId: existing.id,
      collapsed: false,
    });
    return existing.id;
  }

  /** Focus an existing tab and un-collapse. No-op if the id is unknown. */
  focusTab(id: string): void {
    if (!this.#state.tabs.some((tab) => tab.id === id)) return;
    this.#commit({ ...this.#state, activeTabId: id, collapsed: false });
  }

  /** Remove a tab; if it was active, focus falls to its left neighbour then right. */
  closeTab(id: string): void {
    const index = this.#state.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const tabs = this.#state.tabs.filter((tab) => tab.id !== id);
    let activeTabId = this.#state.activeTabId;
    if (activeTabId === id) {
      // After the filter, index-1 is the left neighbour and index is the tab
      // that used to sit to the right (elements shifted left).
      const neighbour = tabs[index - 1] ?? tabs[index];
      activeTabId = neighbour?.id ?? null;
    }
    this.#commit({ ...this.#state, tabs, activeTabId });
  }

  /** Merge live state into a tab (browser url/title, media status, subagents…). */
  updateTab(id: string, patch: Partial<Omit<CanvasTab, 'id'>>): void {
    if (!this.#state.tabs.some((tab) => tab.id === id)) return;
    this.#commit({
      ...this.#state,
      tabs: this.#state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch, id } : tab)),
    });
  }

  setCollapsed(collapsed: boolean): void {
    if (this.#state.collapsed === collapsed) return;
    this.#commit({ ...this.#state, collapsed });
  }

  setFullscreen(fullscreen: boolean): void {
    if (this.#state.fullscreen === fullscreen) return;
    this.#commit({ ...this.#state, fullscreen });
  }

  reset(): void {
    this.#commit({ ...emptyCanvasState });
  }

  /** Replace the entire tab set with a saved snapshot (per-session restore). A
   * partial snapshot is filled from the empty state, so it's always well-formed. */
  restore(state: CanvasState): void {
    this.#commit({ ...emptyCanvasState, ...state });
  }
}

/** Convenience factory mirroring the store idiom. */
export function createCanvasController(options?: CanvasControllerOptions): CanvasController {
  return new CanvasController(options);
}
