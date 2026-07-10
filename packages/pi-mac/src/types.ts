/** The two TCC grants pi-mac needs. Both attribute to the signed bundle that
 * SPAWNS the helper (Electron main), never the pi child. */
export interface TccStatus {
  /** kTCCServiceAccessibility — read other apps' AX tree + post CGEvents. */
  readonly accessibility: boolean;
  /** kTCCServiceScreenCapture — capture other apps' pixels (screenshots). */
  readonly screenRecording: boolean;
}
