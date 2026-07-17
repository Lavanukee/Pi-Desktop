/**
 * The bundled pi extension package dirs, loaded via repeated `-e` flags. Kept
 * PURE (electron-free) so the gen-tools flag gating is unit-testable without a
 * running app. pi-main resolves each dir to its `<pkg>/src/index.ts` and only
 * loads the ones that actually `export default` an activate.
 */

/**
 * The always-on extensions. provider-llamacpp routes local models through its
 * streamSimple provider; provider-afm / provider-mlx do the same for the Apple
 * on-device + MLX models; harness + web-tools add tools/commands; browser-use,
 * mac-connectors, mac-computer-use and mcp-lite add their respective surfaces.
 * An absent/placeholder extension is tolerated by pi-main's export-default probe.
 */
export const BASE_EXTENSION_PACKAGE_DIRS = [
  'provider-llamacpp',
  'provider-afm',
  'provider-mlx',
  'harness',
  'web-tools',
  'browser-use',
  'mac-connectors',
  'mac-computer-use',
  'mcp-lite',
] as const;

/**
 * The extension dirs for this launch. The `gen-tools` extension (the
 * `generate_image` / `generate_video` tools that enqueue over the gen socket
 * bridge) is included ONLY when the EXPERIMENTAL generation flag is on, so a
 * default build never exposes the generation tools to the model and stays clean.
 * The bridge env (PI_GEN_SOCK/_TOKEN) is published by main.ts's `registerGenIpc`
 * under the same gate, so the tool always finds its bridge when loaded.
 */
export function extensionPackageDirs(genEnabled: boolean): readonly string[] {
  return genEnabled ? [...BASE_EXTENSION_PACKAGE_DIRS, 'gen-tools'] : BASE_EXTENSION_PACKAGE_DIRS;
}
