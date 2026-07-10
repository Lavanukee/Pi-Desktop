import CoreGraphics
import Foundation

/// Capture the screen to a temp PNG via `/usr/sbin/screencapture` (the fallback
/// perception surface for AX-opaque apps). Returns the file path and, when
/// `withBase64` is set, the base64 PNG so the model can see it inline. Best-
/// effort: any failure returns nil rather than throwing. Capturing OTHER apps'
/// pixels requires the Screen Recording grant; without it macOS yields a
/// desktop-only image (still a valid, non-crashing result).
func captureScreenshot(withBase64: Bool) -> [String: Any]? {
  let dir = NSTemporaryDirectory()
  let path = (dir as NSString).appendingPathComponent(
    "pi-mac-\(ProcessInfo.processInfo.processIdentifier)-\(Int(Date().timeIntervalSince1970 * 1000)).png"
  )

  let proc = Process()
  proc.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  // -x: no sound. -o: no window shadow. Whole main display to `path`.
  proc.arguments = ["-x", "-o", path]
  do {
    try proc.run()
    proc.waitUntilExit()
  } catch {
    return nil
  }
  guard proc.terminationStatus == 0, FileManager.default.fileExists(atPath: path) else {
    return nil
  }

  var result: [String: Any] = ["path": path]
  if withBase64, let data = try? Data(contentsOf: URL(fileURLWithPath: path)) {
    result["base64"] = data.base64EncodedString()
    result["mimeType"] = "image/png"
  }
  return result
}

/// Capture ONE window by its CGWindowID via `screencapture -l <id>`. This
/// composites just that window even when it is occluded or NOT frontmost, and
/// needs no focus — the focus-free perception surface for a background app.
/// Requires the Screen Recording grant. Best-effort → nil on any failure so the
/// caller can fall back to a full-screen capture.
func captureWindow(windowID: CGWindowID, withBase64: Bool) -> [String: Any]? {
  let dir = NSTemporaryDirectory()
  let path = (dir as NSString).appendingPathComponent(
    "pi-mac-win\(windowID)-\(Int(Date().timeIntervalSince1970 * 1000)).png")

  let proc = Process()
  proc.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  // -x: silent. -o: no shadow. -l <id>: only this window (occluded/background OK).
  proc.arguments = ["-x", "-o", "-l", String(windowID), path]
  do {
    try proc.run()
    proc.waitUntilExit()
  } catch {
    return nil
  }
  guard proc.terminationStatus == 0, FileManager.default.fileExists(atPath: path) else {
    return nil
  }

  var result: [String: Any] = ["path": path, "windowId": Int(windowID)]
  if withBase64, let data = try? Data(contentsOf: URL(fileURLWithPath: path)) {
    result["base64"] = data.base64EncodedString()
    result["mimeType"] = "image/png"
  }
  return result
}
