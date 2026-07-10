import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
} from 'react';
import { type CanvasController, createCanvasController } from './controller.ts';
import type { CanvasTab, CanvasTabSpec } from './tab-model.ts';

const CanvasControllerContext = createContext<CanvasController | null>(null);

export interface CanvasProviderProps {
  /** Bring your own controller (the app usually creates one and drives it). */
  controller?: CanvasController;
  children: ReactNode;
}

/** Provides a CanvasController to the tree; creates one if none is passed. */
export function CanvasProvider({ controller, children }: CanvasProviderProps) {
  const fallback = useRef<CanvasController | null>(null);
  if (!controller && fallback.current === null) fallback.current = createCanvasController();
  const value = controller ?? fallback.current;
  return (
    <CanvasControllerContext.Provider value={value}>{children}</CanvasControllerContext.Provider>
  );
}

/** The bound tab API returned by `useCanvasTabs`. */
export interface CanvasTabsApi {
  controller: CanvasController;
  tabs: CanvasTab[];
  activeTabId: string | null;
  activeTab: CanvasTab | null;
  collapsed: boolean;
  fullscreen: boolean;
  openTab: (spec: CanvasTabSpec) => string;
  upsertTab: (key: string, spec: CanvasTabSpec) => string;
  focusTab: (id: string) => void;
  closeTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<Omit<CanvasTab, 'id'>>) => void;
  setCollapsed: (collapsed: boolean) => void;
  setFullscreen: (fullscreen: boolean) => void;
}

/**
 * `useCanvasTabs` — subscribe a component to a CanvasController (passed in or
 * from `<CanvasProvider>`) via `useSyncExternalStore`, returning the current
 * state plus bound mutators. This is the hook the app's tool-call handlers use
 * to open/focus/close tabs.
 */
export function useCanvasTabs(controller?: CanvasController): CanvasTabsApi {
  const fromContext = useContext(CanvasControllerContext);
  const c = controller ?? fromContext;
  if (!c) {
    throw new Error('useCanvasTabs requires a CanvasController (argument or <CanvasProvider>).');
  }
  const subscribe = useCallback((listener: () => void) => c.subscribe(listener), [c]);
  const getSnapshot = useCallback(() => c.getState(), [c]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return {
    controller: c,
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeTab: state.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
    collapsed: state.collapsed,
    fullscreen: state.fullscreen,
    openTab: (spec) => c.openTab(spec),
    upsertTab: (key, spec) => c.upsertTab(key, spec),
    focusTab: (id) => c.focusTab(id),
    closeTab: (id) => c.closeTab(id),
    updateTab: (id, patch) => c.updateTab(id, patch),
    setCollapsed: (collapsed) => c.setCollapsed(collapsed),
    setFullscreen: (fullscreen) => c.setFullscreen(fullscreen),
  };
}
