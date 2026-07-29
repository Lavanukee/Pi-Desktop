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

  /**
   * Append a tab, focus it, and un-collapse the canvas. Returns the new id.
   *
   * `focus: false` opens it in the BACKGROUND — the tab appears in the bar, the
   * canvas opens if closed, and whatever the user was reading stays in front.
   * That is what a surface which updates on its own (an agent's live work) needs:
   * without it, every write and every command yanks the user off the page they
   * were on, which is precisely what makes a live run impossible to follow.
   */
  openTab(spec: CanvasTabSpec, opts: { focus?: boolean } = {}): string {
    const id = spec.id ?? this.#idFactory();
    const tab: CanvasTab = { ...spec, id };
    const focus = opts.focus !== false;
    this.#commit({
      ...this.#state,
      tabs: [...this.#state.tabs, tab],
      activeTabId: focus ? id : (this.#state.activeTabId ?? id),
      collapsed: false,
    });
    return id;
  }

  /**
   * Open-or-focus by stable key. If a tab already carries `key`, its spec is
   * merged in and it is focused (its id is preserved so native views survive);
   * otherwise a fresh tab is opened with that key. Returns the tab id either way.
   *
   * `focus: false` merges/opens WITHOUT taking focus — see {@link openTab}.
   */
  upsertTab(key: string, spec: CanvasTabSpec, opts: { focus?: boolean } = {}): string {
    const existing = this.#state.tabs.find((tab) => tab.key === key);
    const focus = opts.focus !== false;
    if (!existing) return this.openTab({ ...spec, key }, opts);
    const merged: CanvasTab = { ...existing, ...spec, id: existing.id, key };
    this.#commit({
      ...this.#state,
      tabs: this.#state.tabs.map((tab) => (tab.id === existing.id ? merged : tab)),
      activeTabId: focus ? existing.id : this.#state.activeTabId,
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
