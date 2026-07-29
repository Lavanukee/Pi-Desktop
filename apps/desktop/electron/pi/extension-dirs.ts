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

/**
 * The provider extensions — they wire a MODEL, not tools.
 *
 * A pi child needs them because it resolves its own model. A corp role does not:
 * it is handed an already-resolved model by the role pool, so loading a provider
 * into its session buys nothing and risks a second registration of the same
 * provider inside one process.
 */
const PROVIDER_PACKAGE_DIRS = ['provider-llamacpp', 'provider-afm', 'provider-mlx'];

/**
 * The TOOL extensions — everything a chat can reach that is not a provider:
 * the harness, web tools, the browser, the macOS connectors, computer-use, the
 * MCP surface, and (when enabled) generation.
 *
 * This exists so a SUBAGENT gets the same tools as the chat. jedd: "the original
 * model ... has the ability for its instance to have all the tools and wires, why
 * don't we treat each subagent as a new individual chat exactly the same". They
 * were two tool surfaces — the chat loaded these dirs, while a corp role got a
 * hand-picked pair of registrars injected by the corp seam — which is why a
 * specialist's `mcp_call` resolved to nothing and every parity bug had to be
 * fixed twice. One list now feeds both.
 */
export function toolExtensionPackageDirs(genEnabled: boolean): readonly string[] {
  return extensionPackageDirs(genEnabled).filter((d) => !PROVIDER_PACKAGE_DIRS.includes(d));
}
