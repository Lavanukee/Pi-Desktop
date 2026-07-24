export {
  AUTOREMESHER_DMG_BYTES,
  AUTOREMESHER_DMG_URL,
  detectInstalled,
  engineCacheDir,
  GATED_MIRRORS,
  GEN3D_MODEL_SPECS,
  type Gen3dModelId,
  type Gen3dModelSpec,
  type Gen3dRepoSpec,
  type Gen3dResolution,
  type Gen3dRole,
  gen3dSandboxDir,
  installStampPath,
  specTotalBytes,
  TRELLIS_PIPELINE_TYPES,
  TRELLIS_RESOLUTIONS,
  toSidecarRegistry,
} from './catalog';
export {
  consumeNdjsonStream,
  createNdjsonSplitter,
} from './ndjson';
export {
  type Gen3dStage,
  type JobUpdate,
  mapJobEvent,
  planGenerate,
  planStageOp,
  type SidecarJobEvent,
  type StagePlan,
} from './progress';
export {
  assembleSidecarArgs,
  Gen3dSidecar,
  type Gen3dSidecarOptions,
  pickFreePort,
  resolveUv,
  SIDECAR_HF_HUB_PIN,
  SIDECAR_PYTHON,
  type SidecarArgsConfig,
} from './sidecar';
