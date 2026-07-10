import type { ComponentType } from 'react';
import type { Artifact, ArtifactContent, ArtifactKind } from './model.ts';

/**
 * Props every surface component receives. A surface is a pure renderer of
 * `content`; `streaming` toggles progressive/live behavior; `onExport`/`onCopy`
 * are host-provided actions (the panel wires defaults).
 */
export interface SurfaceProps {
  content: ArtifactContent;
  streaming: boolean;
  onExport?: (content: ArtifactContent) => void;
  onCopy?: (text: string) => void;
}

/**
 * A registered surface. `match` decides whether this surface can render a given
 * artifact; when several match, the highest `priority` wins (ties broken by
 * registration order, last-registered first so app overrides beat built-ins).
 */
export interface SurfaceDefinition {
  kind: ArtifactKind;
  /** Whether this surface can render *while* content is still streaming in. */
  canStream: boolean;
  /** Resolution weight; higher wins. Defaults to 0. */
  priority?: number;
  /**
   * Routing hint: `true` (default) means this kind opens in the CANVAS; `false`
   * means it is inline-eligible in the chat when small (svg/html widgets). The
   * app consults `resolveSurface(artifact)?.opensInCanvas` (with `shouldGoToCanvas`)
   * to route a tool result inline vs. to `openTab`.
   */
  opensInCanvas?: boolean;
  match: (artifact: Artifact) => boolean;
  component: ComponentType<SurfaceProps>;
}

/** Convenience matcher: exact-kind predicate for the common case. */
export function matchKind(kind: ArtifactKind): (artifact: Artifact) => boolean {
  return (artifact) => artifact.content.kind === kind;
}

/**
 * An isolated surface registry. The package exposes a shared default instance
 * (see the module-level `registerSurface`/`resolveSurface` below), but tests and
 * embedders can create their own to avoid global state.
 */
export class SurfaceRegistry {
  #surfaces: SurfaceDefinition[] = [];

  /** Register a surface. Returns an unregister function. */
  register(definition: SurfaceDefinition): () => void {
    // Newest first so a later registration (e.g. an app override) outranks an
    // equal-priority built-in.
    this.#surfaces.unshift(definition);
    return () => {
      const index = this.#surfaces.indexOf(definition);
      if (index !== -1) this.#surfaces.splice(index, 1);
    };
  }

  /** The best surface for an artifact, or `undefined` if none match. */
  resolve(artifact: Artifact): SurfaceDefinition | undefined {
    let best: SurfaceDefinition | undefined;
    let bestPriority = Number.NEGATIVE_INFINITY;
    for (const surface of this.#surfaces) {
      if (!surface.match(artifact)) continue;
      const priority = surface.priority ?? 0;
      // Strictly greater keeps the newest among equals (array is newest-first).
      if (priority > bestPriority) {
        best = surface;
        bestPriority = priority;
      }
    }
    return best;
  }

  /** All registrations, newest-first. */
  list(): readonly SurfaceDefinition[] {
    return this.#surfaces.slice();
  }

  clear(): void {
    this.#surfaces = [];
  }
}

/** The process-wide default registry the built-in surfaces populate. */
export const defaultSurfaceRegistry = new SurfaceRegistry();

/** Register a surface on the default registry. Returns an unregister function. */
export function registerSurface(definition: SurfaceDefinition): () => void {
  return defaultSurfaceRegistry.register(definition);
}

/** Resolve a surface from the default registry. */
export function resolveSurface(artifact: Artifact): SurfaceDefinition | undefined {
  return defaultSurfaceRegistry.resolve(artifact);
}
