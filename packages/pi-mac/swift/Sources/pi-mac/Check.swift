import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// The two TCC grants that gate everything pi-mac does. Accessibility
/// (`kTCCServiceAccessibility`) is required to READ another app's AX tree AND to
/// POST synthetic CGEvents to it; Screen Recording (`kTCCServiceScreenCapture`)
/// is required to capture other apps' pixels on modern macOS. Both attribute to
/// the *signed bundle that spawns this helper* — which is why Electron main owns
/// the spawn (the TCC identity gotcha; see the bridge module).
struct TccStatus {
  let accessibility: Bool
  let screenRecording: Bool
}

/// Pure status read — cannot throw. `AXIsProcessTrusted()` reflects the
/// Accessibility grant for the process that owns this helper;
/// `CGPreflightScreenCaptureAccess()` reflects Screen Recording. We deliberately
/// do NOT call the prompting variants here (`--check` must be a silent probe the
/// capabilities UI can poll); the app drives the grant flow separately.
func readTccStatus() -> TccStatus {
  let ax = AXIsProcessTrusted()
  let screen = CGPreflightScreenCaptureAccess()
  return TccStatus(accessibility: ax, screenRecording: screen)
}

func tccStatusDict() -> [String: Any] {
  let s = readTccStatus()
  return ["accessibility": s.accessibility, "screenRecording": s.screenRecording]
}

/// `--check` one-shot: emit a bare `{ accessibility, screenRecording }` line and
/// exit 0. Total by construction so the Node capability gate always gets a clean
/// answer.
func runCheckCommand() {
  emit(tccStatusDict())
}

/// The PROMPTING probe (serve method `promptGrants`): asks macOS to surface the
/// system permission dialogs / register this identity in System Settings →
/// Privacy & Security, so granting becomes a one-click toggle instead of a
/// hunt for the right binary. Called at most once per session by the app when
/// a mac_* action runs without the grants. Returns the (post-prompt) status —
/// macOS may grant Screen Recording without relaunch; Accessibility applies to
/// the NEXT helper spawn.
func promptTccGrants() -> [String: Any] {
  let opts =
    [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  let ax = AXIsProcessTrustedWithOptions(opts)
  let screen = CGRequestScreenCaptureAccess()
  return ["accessibility": ax, "screenRecording": screen, "prompted": true]
}
