/**
 * Pinned llama.cpp release manifest.
 *
 * We pin an exact GitHub release tag (never "latest") so a given Pi Desktop
 * build always installs the same server binary. The macOS arm64 asset is a
 * TAR.GZ (not a zip) containing llama-server/llama-cli/llama plus the Metal
 * dylibs.
 *
 * sha256 + sizeBytes below were verified against GitHub's own per-asset
 * `digest` field (the releases API exposes `sha256:<hex>` per asset) on
 * 2026-07-08. `resolveRelease()` can still re-fetch the digest from the API at
 * download time as a fallback / cross-check.
 *
 * NOTE (catalog correction): the W4 research catalog pinned ~b9907, but that
 * file was absent from the scratchpad at build time. The live latest at build
 * time was b9934; it is pinned here with its published digest.
 */
export interface LlamaCppAsset {
  /** Asset file name within the release. */
  readonly name: string;
  /** Lowercase hex sha256 (from GitHub's asset digest). */
  readonly sha256: string;
  /** Asset size in bytes. */
  readonly sizeBytes: number;
}

export interface LlamaCppRelease {
  /** GitHub release tag, e.g. "b9934". */
  readonly tag: string;
  /** GitHub owner/repo. */
  readonly repo: string;
  /** macOS arm64 (Apple Silicon, Metal) asset. */
  readonly macosArm64: LlamaCppAsset;
}

export const PINNED_LLAMACPP: LlamaCppRelease = {
  tag: 'b9934',
  repo: 'ggml-org/llama.cpp',
  macosArm64: {
    name: 'llama-b9934-bin-macos-arm64.tar.gz',
    sha256: 'f9338784c562b91b48e3044aab29f7f2b7664da456f05e945bbc10f4b546b502',
    sizeBytes: 10721280,
  },
};

/** Browser download URL for a pinned release asset. */
export function assetDownloadUrl(release: LlamaCppRelease, assetName: string): string {
  return `https://github.com/${release.repo}/releases/download/${release.tag}/${assetName}`;
}

/** GitHub API URL for a pinned release (exposes per-asset `digest`). */
export function releaseApiUrl(release: LlamaCppRelease): string {
  return `https://api.github.com/repos/${release.repo}/releases/tags/${release.tag}`;
}
