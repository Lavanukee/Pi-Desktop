/**
 * @pi-desktop/gen-canvas — the generation IMAGE canvas surface (candidate grid +
 * live progress + model footnote), registered ADDITIVELY on the canvas surface
 * registry. Electron-free React; the app calls `registerGenImageSurface()` once
 * and routes gen job progress into `genImageContent(...)` artifacts.
 */
export type {
  GenCandidate,
  GenCandidateStatus,
  GenImageSurfaceData,
  GenImageSurfaceProps,
  GenModelInfo,
} from './gen-image-surface.tsx';
export { GenImageSurface, modelFootnote } from './gen-image-surface.tsx';
export {
  GEN_IMAGE_KIND,
  genImageContent,
  parseGenImageData,
  registerGenImageSurface,
  registerGenSurfacesDefault,
} from './register.tsx';
