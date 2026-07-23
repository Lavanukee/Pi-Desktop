import AppKit
import ApplicationServices
import Foundation

/// The index→element map from the last snapshot, NAMESPACED BY PID and kept
/// alive for the life of the serve process so `click/type` can resolve a [index]
/// the model saw. Mirrors the browser bridge's `data-pi-idx` stamp +
/// `resolveByIndex` contract; a missing index → `{ found: false }`, which the
/// Node tool turns into an auto re-snapshot + single retry.
///
/// Namespacing by pid is the concurrency guarantee: two sessions (e.g. two
/// subagents) driving DIFFERENT apps each snapshot into their own pid bucket, so
/// one session's snapshot never clobbers the other's indices. Each session passes
/// the app's `pid` (or `app`) on click/type; only the no-hint case falls back to
/// the most-recently-snapshotted pid.
private var elementsByPid: [pid_t: [Int: SnapEl]] = [:]
private var lastSnapshotPid: pid_t?

private let DEFAULT_CAP = 60

// ── param helpers ────────────────────────────────────────────────────────────

private func intOf(_ v: Any?) -> Int? {
  if let i = v as? Int { return i }
  if let n = v as? NSNumber { return n.intValue }
  if let s = v as? String { return Int(s) }
  return nil
}
private func doubleOf(_ v: Any?) -> Double? {
  if let d = v as? Double { return d }
  if let n = v as? NSNumber { return n.doubleValue }
  if let s = v as? String { return Double(s) }
  return nil
}
private func stringOf(_ v: Any?) -> String? { v as? String }
private func boolOf(_ v: Any?) -> Bool {
  if let b = v as? Bool { return b }
  if let n = v as? NSNumber { return n.boolValue }
  return false
}

private func targetFrom(_ params: [String: Any]) -> SnapshotTarget {
  if let pid = intOf(params["pid"]) { return .pid(pid_t(pid)) }
  if let app = stringOf(params["app"]), !app.isEmpty { return .app(app) }
  return .frontmost
}

// ── snapshot (shared by --serve and --snapshot) ──────────────────────────────

private func doSnapshot(_ params: [String: Any]) -> [String: Any]? {
  let cap = intOf(params["cap"]) ?? DEFAULT_CAP
  guard let snap = collectSnapshot(target: targetFrom(params), cap: cap) else { return nil }
  // Refresh this pid's resolve-by-index map (leaving other pids' maps intact so
  // concurrent sessions on other apps keep their indices).
  var map: [Int: SnapEl] = [:]
  for el in snap.elements { map[el.index] = el }
  elementsByPid[snap.pid] = map
  lastSnapshotPid = snap.pid
  // When a screenshot is requested, prefer a focus-free PER-WINDOW capture of
  // the snapshotted window (works occluded / non-frontmost); fall back to the
  // whole screen only if the window id / grant is unavailable.
  var shot: [String: Any]?
  if boolOf(params["screenshot"]) {
    if let wid = snap.windowId { shot = captureWindow(windowID: wid, withBase64: true) }
    if shot == nil { shot = captureScreenshot(withBase64: true) }
  }
  return snapshotResultDict(snap, screenshot: shot)
}

/// Resolve a snapshot element by index within the caller's app namespace: an
/// explicit `pid`/`app` (concurrency-safe across apps), else the most recent
/// snapshot's pid. Also returns WHICH pid owned the resolved element, so acts
/// can deliver their fallback events to exactly that app (postToPid).
private func resolveElement(_ params: [String: Any], _ index: Int) -> (el: SnapEl, pid: pid_t)? {
  if let pid = intOf(params["pid"]), let map = elementsByPid[pid_t(pid)] {
    return map[index].map { ($0, pid_t(pid)) }
  }
  if let appName = stringOf(params["app"]), !appName.isEmpty,
    let resolved = resolveTargetPid(.app(appName)), let map = elementsByPid[resolved.pid]
  {
    return map[index].map { ($0, resolved.pid) }
  }
  if let pid = lastSnapshotPid, let map = elementsByPid[pid] {
    return map[index].map { ($0, pid) }
  }
  return nil
}

/// The pid an index-less act should be DELIVERED to (postToPid — background):
/// an explicit `pid`, else a resolvable `app`. Deliberately no lastSnapshotPid
/// fallback — the tool layer stamps the controlled pid explicitly; an
/// unstamped act keeps the legacy foreground (frontmost) behavior.
private func actTargetPid(_ params: [String: Any]) -> pid_t? {
  if let pid = intOf(params["pid"]) { return pid_t(pid) }
  if let app = stringOf(params["app"]), !app.isEmpty, let r = resolveTargetPid(.app(app)) {
    return r.pid
  }
  return nil
}

// ── act dispatch (shared) ────────────────────────────────────────────────────

private func doClick(_ params: [String: Any]) -> [String: Any] {
  // Explicit coordinates (AX-opaque surfaces). With a target pid the click is
  // DELIVERED to that app only (postToPid — background, no focus steal); with
  // no pid it falls back to the legacy shared-cursor foreground click.
  if let x = doubleOf(params["x"]), let y = doubleOf(params["y"]) {
    if let pid = actTargetPid(params) {
      postClickToPid(pid, x: x, y: y)
      return ["found": true, "mode": "coordToPid", "background": true, "x": x, "y": y]
    }
    withCoordinateLock { postClick(x: x, y: y) }
    return ["found": true, "mode": "coord", "background": false, "x": x, "y": y]
  }
  guard let index = intOf(params["index"]) else {
    return ["found": false, "error": "click needs an index or x,y"]
  }
  guard let (el, pid) = resolveElement(params, index) else { return ["found": false] }
  let (mode, background) = performPress(
    el.element, x: Double(el.x), y: Double(el.y), targetPid: pid)
  // x,y echo the acted-on point (element centre, screen points) so the app can
  // animate the phantom cursor to where the click actually landed.
  return ["found": true, "mode": mode, "background": background, "x": el.x, "y": el.y]
}

private func doType(_ params: [String: Any]) -> [String: Any] {
  let text = stringOf(params["text"]) ?? ""
  let submit = boolOf(params["submit"])
  // Focused typing (no index) is the foreground path: synthetic keystrokes land
  // in whatever holds the SYSTEM focus.
  guard let index = intOf(params["index"]) else {
    withCoordinateLock {
      typeText(text)
      if submit { postKey(flags: [], key: 36) }
    }
    return ["found": true, "mode": "keystrokes", "background": false, "submitted": submit]
  }
  guard let (el, pid) = resolveElement(params, index) else { return ["found": false] }

  // AX-FIRST: set the field's value directly (background, no focus, no
  // keystrokes). If the element rejects a value set (or `append` asks for
  // keystrokes so text is added rather than replaced), focus the element
  // app-internally and deliver the keystrokes to ITS pid only — still no focus
  // steal from the user's app. Only a pid-less legacy call types foreground.
  var mode: String
  var background: Bool
  if !boolOf(params["append"]), setValue(el.element, text) {
    mode = "setValue"
    background = true
  } else {
    focusElement(el.element)
    typeTextToPid(pid, text)
    mode = "keystrokesToPid"
    background = true
  }

  if submit {
    // Prefer a background AX confirm (targets THIS element — safe for a
    // non-frontmost app); else a Return delivered to the app's own pid.
    if confirmElement(el.element) {
      mode += "+confirm"
    } else {
      focusElement(el.element)
      postKeyToPid(pid, flags: [], key: 36)
      mode += "+returnToPid"
    }
  }
  return [
    "found": true, "mode": mode, "background": background, "submitted": submit,
    "x": el.x, "y": el.y,
  ]
}

private func doKey(_ params: [String: Any]) -> [String: Any] {
  guard let combo = stringOf(params["combo"]) ?? stringOf(params["key"]) else {
    return ["ok": false, "error": "key needs a combo"]
  }
  guard let parsed = parseCombo(combo) else {
    return ["ok": false, "error": "unrecognized key combo: \(combo)"]
  }
  // With a target pid the chord is delivered to that app only (background —
  // the user's focus is untouched). Pid delivery also honors the event's own
  // modifier flags, so ⌘-chords land correctly.
  if let pid = actTargetPid(params) {
    postKeyToPid(pid, flags: parsed.flags, key: parsed.key)
    return ["ok": true, "background": true]
  }
  // Legacy pid-less path: chords hit the SYSTEM focus (foreground).
  withCoordinateLock { postKey(flags: parsed.flags, key: parsed.key) }
  return ["ok": true, "background": false]
}

private func doScroll(_ params: [String: Any]) -> [String: Any] {
  var dx = 0
  var dy = 0
  // Prefer explicit signed pixel deltas from the tool layer (pure + unit-tested
  // sign/magnitude — see mac-computer-use/scroll.ts). Fall back to computing
  // them from direction/amount for legacy/one-shot callers.
  if let edx = intOf(params["dx"]), let edy = intOf(params["dy"]), edx != 0 || edy != 0 {
    dx = edx
    dy = edy
  } else {
    let amount = intOf(params["amount"]) ?? 600
    let dir = (stringOf(params["direction"]) ?? "down").lowercased()
    switch dir {
    case "down": dy = -amount
    case "up": dy = amount
    case "left": dx = amount
    case "right": dx = -amount
    default: dy = -amount
    }
  }
  // With a target pid: pin the event inside the target window and deliver to
  // that app only — background scrolling of a non-frontmost window — through
  // the VERIFIED fallback ladder (see doScrollLadder).
  if let pid = actTargetPid(params),
    let info = windowBoundsInfo(target: .pid(pid)),
    let x = info["x"] as? Int, let y = info["y"] as? Int,
    let w = info["w"] as? Int, let h = info["h"] as? Int
  {
    let rect = CGRect(x: Double(x), y: Double(y), width: Double(w), height: Double(h))
    let windowId = (info["windowId"] as? Int).map { CGWindowID($0) }
    return doScrollLadder(params, pid: pid, rect: rect, windowId: windowId, dx: dx, dy: dy)
  }
  // Legacy pid-less path: posts at the shared cursor position (foreground).
  withCoordinateLock { postScroll(dx: dx, dy: dy) }
  return ["ok": true, "background": false]
}

/// How long to let the target app apply a posted scroll before reading the
/// scroll bar back to VERIFY content actually moved (per ladder rung).
private let SCROLL_VERIFY_DELAY_US: UInt32 = 130_000
/// Heuristic pixels→scroll-bar-fraction mapping for the AX last resort (a
/// 600px ask moves ~20% of the document — coarse, but actually moves).
private let AX_SCROLL_PIXELS_PER_UNIT = 3000.0

/// Background scroll with a VERIFIED fallback ladder. A wheel burst posted to
/// a pid is dropped by some apps — and by AppKit itself when the event's
/// location hit-tests to ANOTHER app's window covering ours (the System
/// Settings "scroll did nothing" field failure). So: pin the location to an
/// UNOBSTRUCTED point of the target window, then try the stepped pixel burst
/// → phased gesture → line wheel, verifying each against the scroll bar's AX
/// value when one exists, and finally set the scroll bar value directly.
private func doScrollLadder(
  _ params: [String: Any], pid: pid_t, rect: CGRect, windowId: CGWindowID?, dx: Int, dy: Int
) -> [String: Any] {
  // Preferred location: a snapshot element's centre when given, else centre.
  var preferred = CGPoint(x: rect.midX, y: rect.midY)
  if let index = intOf(params["index"]), let (el, _) = resolveElement(params, index) {
    preferred = CGPoint(x: Double(el.x), y: Double(el.y))
  }
  let pt = unobstructedPoint(windowId: windowId, pid: pid, preferred: preferred, rect: rect)
  let fullyCovered = pt == nil
  let at = pt ?? preferred

  // The verification signal: the targeted scroll area's scroll bar value.
  let axApp = AXUIElementCreateApplication(pid)
  let root = rootFor(app: axApp)
  let scrollArea = findScrollArea(in: root, containing: at)
  let bar = scrollArea.flatMap { scrollBarOf($0, horizontal: dx != 0) }
  func barValue() -> Double? { bar.flatMap { scrollBarValue($0) } }

  func result(_ mode: String, moved: Bool?) -> [String: Any] {
    var d: [String: Any] = [
      "ok": true, "background": true, "mode": mode,
      "x": Int(at.x.rounded()), "y": Int(at.y.rounded()),
    ]
    if let moved = moved { d["moved"] = moved }
    if fullyCovered { d["coveredByOtherWindows"] = true }
    return d
  }

  let rungs: [(name: String, fire: () -> Void)] = [
    ("pixelBurstToPid", { postScrollToPid(pid, dx: dx, dy: dy, at: at) }),
    ("gestureToPid", { postScrollGestureToPid(pid, dx: dx, dy: dy, at: at) }),
    ("lineToPid", { postLineScrollToPid(pid, dx: dx, dy: dy, at: at) }),
  ]

  // A forced mode (live-tuning seam for the probes) fires exactly one rung.
  let forced = stringOf(params["mode"])
  if let forced = forced, forced != "axValue" {
    guard let rung = rungs.first(where: { $0.name == forced }) else {
      return ["ok": false, "error": "unknown scroll mode: \(forced)"]
    }
    let v0 = barValue()
    rung.fire()
    guard let v0 = v0 else { return result(rung.name, moved: nil) }
    usleep(SCROLL_VERIFY_DELAY_US)
    return result(rung.name, moved: barValue().map { abs($0 - v0) > 1e-6 })
  }

  if let v0 = barValue() {
    // Verified ladder: stop at the first rung that actually moves content.
    for rung in rungs {
      rung.fire()
      usleep(SCROLL_VERIFY_DELAY_US)
      if let v1 = barValue(), abs(v1 - v0) > 1e-6 {
        return result(rung.name, moved: true)
      }
    }
  } else if forced != "axValue" {
    // No scroll bar to verify against: fire the burst blind (stacking rungs
    // unverified would multi-scroll a working app).
    rungs[0].fire()
    return result(rungs[0].name, moved: nil)
  }

  // Last resort (or forced axValue): drive the scroll bar's value directly.
  if let bar = bar, let v0 = scrollBarValue(bar) {
    let sign = (dy < 0 || dx < 0) ? 1.0 : -1.0
    let delta = Double(max(abs(dx), abs(dy))) / AX_SCROLL_PIXELS_PER_UNIT
    if setScrollBarValue(bar, v0 + sign * delta) {
      usleep(SCROLL_VERIFY_DELAY_US)
      return result("axValue", moved: barValue().map { abs($0 - v0) > 1e-6 })
    }
  }
  return result("exhausted", moved: false)
}

/// Activate a running app (bring to front) by name — a lightweight focus that
/// doesn't need osascript. Launching a NOT-running app stays the bridge's job
/// (osascript `open -a`), so this only focuses.
private func doFocus(_ params: [String: Any]) -> [String: Any] {
  guard let name = stringOf(params["app"]), !name.isEmpty else {
    return ["ok": false, "error": "focus needs an app name"]
  }
  let q = name.lowercased()
  for app in NSWorkspace.shared.runningApplications {
    let ln = (app.localizedName ?? "").lowercased()
    let bid = (app.bundleIdentifier ?? "").lowercased()
    if ln == q || bid == q || ln.contains(q) {
      app.activate()
      return ["ok": true, "app": app.localizedName ?? name]
    }
  }
  return ["ok": false, "error": "app not running: \(name)"]
}

// ── serve loop ───────────────────────────────────────────────────────────────

private func dispatch(method: String, params: [String: Any]) -> [String: Any]? {
  switch method {
  case "check": return tccStatusDict()
  case "promptGrants": return promptTccGrants()
  case "snapshot": return doSnapshot(params)  // nil → target unresolved
  case "click": return doClick(params)
  case "type": return doType(params)
  case "key": return doKey(params)
  case "scroll": return doScroll(params)
  case "focus": return doFocus(params)
  case "screenshot": return doScreenshot(params)
  case "bounds": return doBounds(params)
  case "frontmost": return doFrontmost()
  case "moveWindow": return doMoveWindow(params)
  default: return nil
  }
}

/// `moveWindow` method: AX-reposition the target's window. The deterministic
/// "drag" the live probes use to measure overlay tracking latency.
private func doMoveWindow(_ params: [String: Any]) -> [String: Any] {
  guard let x = doubleOf(params["x"]), let y = doubleOf(params["y"]) else {
    return ["ok": false, "error": "moveWindow needs x,y"]
  }
  let moved = moveWindowTo(target: targetFrom(params), x: x, y: y)
  return moved ? ["ok": true] : ["ok": false, "error": "could not move the target window"]
}

/// `bounds` method: the target window's live frame (+ windowId + whether its
/// app is frontmost). The launch poller spins on this until the window exists;
/// the cursor overlay polls it to track moves/resizes; the no-focus-steal
/// probe asserts on `frontmost`.
private func doBounds(_ params: [String: Any]) -> [String: Any] {
  if let info = windowBoundsInfo(target: targetFrom(params)) { return info }
  return ["ok": false, "error": "no resolvable window for target"]
}

/// `frontmost` method: which app currently owns the user's focus.
private func doFrontmost() -> [String: Any] {
  guard let app = NSWorkspace.shared.frontmostApplication else {
    return ["ok": false, "error": "no frontmost application"]
  }
  return [
    "ok": true,
    "app": app.localizedName ?? "",
    "pid": Int(app.processIdentifier),
    "bundleId": app.bundleIdentifier ?? "",
  ]
}

/// `screenshot` method: a focus-free per-window capture when a `windowId` (or a
/// resolvable `app`/`pid` whose window id we can look up) is given, else the
/// whole screen. Never nil — a failure returns a structured error.
private func doScreenshot(_ params: [String: Any]) -> [String: Any] {
  var windowId = intOf(params["windowId"]).map { CGWindowID($0) }
  if windowId == nil, (params["app"] != nil || params["pid"] != nil) {
    if let resolved = resolveTargetPid(targetFrom(params)) {
      let root = rootFor(app: AXUIElementCreateApplication(resolved.pid))
      windowId = axWindowID(root)
    }
  }
  if let wid = windowId, let shot = captureWindow(windowID: wid, withBase64: true) {
    return shot
  }
  return captureScreenshot(withBase64: true) ?? ["path": "", "error": "capture failed"]
}

/// Persistent NDJSON pump: one `{ id, method, params }` request per stdin line,
/// one `{ id, ok, result|error }` response per line. Single-threaded, so the
/// index map needs no locking. EOF (bridge closed) ends the loop → clean exit.
func runServe() {
  while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
    guard let data = line.data(using: .utf8),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      emitError(id: nil, message: "malformed request")
      continue
    }
    let id = intOf(obj["id"])
    guard let method = obj["method"] as? String else {
      emitError(id: id, message: "missing method")
      continue
    }
    let params = (obj["params"] as? [String: Any]) ?? [:]
    if let result = dispatch(method: method, params: params) {
      emitResult(id: id, result: result)
    } else if method == "snapshot" {
      emitError(id: id, message: "could not resolve target app for snapshot")
    } else {
      emitError(id: id, message: "unknown method: \(method)")
    }
  }
}

// ── one-shot subcommands (CLI testing / capability probe) ─────────────────────

/// `--snapshot [--frontmost|--pid N|--app NAME] [--screenshot]` → bare result.
func runSnapshotCommand(_ argv: [String]) {
  var params: [String: Any] = [:]
  var i = 0
  while i < argv.count {
    switch argv[i] {
    case "--frontmost": break
    case "--pid":
      i += 1
      if i < argv.count, let pid = Int(argv[i]) { params["pid"] = pid }
    case "--app":
      i += 1
      if i < argv.count { params["app"] = argv[i] }
    case "--screenshot": params["screenshot"] = true
    default: break
    }
    i += 1
  }
  if let result = doSnapshot(params) {
    emit(result)
  } else {
    emitError(id: nil, message: "could not resolve target app for snapshot")
  }
}

/// `--act '<json>'` → perform one raw act (no index map in one-shot mode; use
/// x,y / type / key / scroll). Emits a bare ack.
func runActCommand(_ argv: [String]) {
  guard let json = argv.first, let data = json.data(using: .utf8),
    let params = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else {
    emitError(id: nil, message: "usage: pi-mac --act '{\"kind\":\"click\",\"x\":10,\"y\":20}'")
    return
  }
  let kind = (params["kind"] as? String) ?? "click"
  var result: [String: Any]
  switch kind {
  case "click": result = doClick(params)
  case "type": result = doType(params)
  case "key": result = doKey(params)
  case "scroll": result = doScroll(params)
  case "focus": result = doFocus(params)
  default: result = ["ok": false, "error": "unknown act kind: \(kind)"]
  }
  emit(result)
}
