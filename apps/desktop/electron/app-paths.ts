/**
 * App-relative path resolution for runtime assets that ship BOTH in the dev
 * workspace and inside the packaged .app bundle.
 *
 * Two families of asset are resolved off the workspace root in dev but must be
 * resolved off the packaged bundle in a shipped app:
 *   - the pi extension entry points (packages/<pkg>/src/index.ts), loaded by
 *     the spawned pi child via `-e` (see pi/pi-main.ts), and
 *   - the canvas pd-preview harness dir (packages/canvas/harness), served by
 *     the main process over pd-preview:// (see canvas/canvas-main.ts + main.ts).
 *
 * Why `app.getAppPath()` is the right base in packaged mode
 * --------------------------------------------------------
 * electron-builder collects the app's *production* dependency tree into the
 * asar, so every workspace package listed under "dependencies" in
 * apps/desktop/package.json (provider-llamacpp, harness, web-tools, canvas, …)
 * lands at `<appPath>/node_modules/@pi-desktop/<pkg>/…`, where
 * `app.getAppPath()` === the `app.asar` root (…/Contents/Resources/app.asar).
 *
 * The Electron fs shim reads those asar-internal paths transparently — and,
 * verified on Electron 43, that shim is ALSO present in the pi child spawned
 * with ELECTRON_RUN_AS_NODE=1. So a `-e` path pointing inside the asar both (a)
 * lets the main process readFileSync it for the export-default probe and (b)
 * lets pi's jiti loader read + compile the .ts and resolve its transitive
 * imports (@mariozechner/*, @sinclair/typebox, …) from the SAME asar
 * node_modules. Keeping the whole tree inside the asar is deliberate: unpacking
 * only the extension would strand its still-packed deps, because Node's
 * module-resolution walk from an app.asar.unpacked path never re-enters the
 * archive. Native deps that genuinely need unpacking (koffi) are handled by
 * electron-builder's automatic .node unpacking + the @mariozechner/** asarUnpack
 * rule in electron-builder.yml.
 *
 * Dev/E2E behavior is unchanged: `app.getAppPath()` is apps/desktop, whose
 * grandparent is the repo root, and assets resolve to packages/<pkg>/…exactly
 * as before.
 *
 * NOTE for later electron work (Phase-2 tabbed-canvas WebContentsView): treat
 * this module as the single seam for bundle-relative asset paths — add new
 * packaged assets here rather than re-deriving `app.getAppPath()` at each call
 * site.
 */
import path from 'node:path';
import { app } from 'electron';

/**
 * Resolve an asset that lives inside a `@pi-desktop/<pkgDir>` workspace package.
 *
 * @param pkgDir       the package directory under packages/ (dev) === the
 *                     scoped package name suffix under node_modules/@pi-desktop
 *                     (packaged), e.g. `provider-llamacpp` or `canvas`.
 * @param relInsidePkg path of the asset relative to the package root, e.g.
 *                     `src/index.ts` or `harness`.
 */
export function resolveBundledPackageAsset(pkgDir: string, relInsidePkg: string): string {
  if (app.isPackaged) {
    return path.join(app.getAppPath(), 'node_modules', '@pi-desktop', pkgDir, relInsidePkg);
  }
  // Dev/E2E: app.getAppPath() is apps/desktop; the repo root is its grandparent.
  const repoRoot = path.resolve(app.getAppPath(), '../..');
  return path.join(repoRoot, 'packages', pkgDir, relInsidePkg);
}
