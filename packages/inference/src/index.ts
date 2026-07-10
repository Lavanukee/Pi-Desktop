/**
 * @pi-desktop/inference — electron-free llama.cpp backend: binary manager, GGUF
 * catalog, hardware detection, model downloader, llama-server supervisor, and
 * the pi models.json writer. Consumed by the desktop app's inference-supervisor
 * utility process (wired in a later workstream).
 */
export const packageName = '@pi-desktop/inference';

export * from './catalog.js';
export * from './download.js';
export * from './hardware.js';
export * from './llamacpp-manager.js';
export * from './llamacpp-manifest.js';
export * from './model-downloader.js';
export * from './models-json.js';
export * from './paths.js';
export * from './recommender.js';
export * from './supervisor.js';
