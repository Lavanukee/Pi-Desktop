import { createContext } from 'react';
import { PD_PREVIEW_HARNESS_URL } from './harness/protocol.ts';

export interface CanvasConfig {
  /**
   * URL the HTML surface's sandboxed iframe loads. Defaults to the
   * `pd-preview://` harness URL the app serves; injectable (a blob/data URL) so
   * the surface is testable without the custom protocol registered.
   */
  harnessUrl: string;
}

export const defaultCanvasConfig: CanvasConfig = {
  harnessUrl: PD_PREVIEW_HARNESS_URL,
};

/** Provided by `<Canvas>`; consumed by the HTML surface. */
export const CanvasConfigContext = createContext<CanvasConfig>(defaultCanvasConfig);
