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
/// snapshot's pid.
private func resolveElement(_ params: [String: Any], _ index: Int) -> SnapEl? {
  if let pid = intOf(params["pid"]), let map = elementsByPid[pid_t(pid)] {
    return map[index]
  }
  if let appName = stringOf(params["app"]), !appName.isEmpty,
    let resolved = resolveTargetPid(.app(appName)), let map = elementsByPid[resolved.pid]
  {
    return map[index]
  }
  if let pid = lastSnapshotPid, let map = elementsByPid[pid] {
    return map[index]
  }
  return nil
}

// ── act dispatch (shared) ────────────────────────────────────────────────────

private func doClick(_ params: [String: Any]) -> [String: Any] {
  // Explicit coordinates are always the foreground fallback (AX-opaque surfaces).
  if let x = doubleOf(params["x"]), let y = doubleOf(params["y"]) {
    withCoordinateLock { postClick(x: x, y: y) }
    return ["found": true, "mode": "coord", "background": false]
  }
  guard let index = intOf(params["index"]) else {
    return ["found": false, "error": "click needs an index or x,y"]
  }
  guard let el = resolveElement(params, index) else { return ["found": false] }
  let (mode, background) = performPress(el.element, x: Double(el.x), y: Double(el.y))
  return ["found": true, "mode": mode, "background": background]
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
  guard let el = resolveElement(params, index) else { return ["found": false] }

  // AX-FIRST: set the field's value directly (background, no focus, no
  // keystrokes). Fall back to focus + synthetic typing only if the element
  // rejects a value set (foreground). `append` forces the keystroke path so text
  // is added rather than replacing the field.
  var mode: String
  var background: Bool
  if !boolOf(params["append"]), setValue(el.element, text) {
    mode = "setValue"
    background = true
  } else {
    focusElement(el.element)
    withCoordinateLock { typeText(text) }
    mode = "keystrokes"
    background = false
  }

  if submit {
    // Prefer a background AX confirm (targets THIS element — safe for a
    // non-frontmost app); else a focused Return (foreground, hits system focus).
    if confirmElement(el.element) {
      mode += "+confirm"
    } else {
      focusElement(el.element)
      withCoordinateLock { postKey(flags: [], key: 36) }
      mode += "+return"
      background = false
    }
  }
  return ["found": true, "mode": mode, "background": background, "submitted": submit]
}

private func doKey(_ params: [String: Any]) -> [String: Any] {
  guard let combo = stringOf(params["combo"]) ?? stringOf(params["key"]) else {
    return ["ok": false, "error": "key needs a combo"]
  }
  guard let parsed = parseCombo(combo) else {
    return ["ok": false, "error": "unrecognized key combo: \(combo)"]
  }
  // Key chords hit the SYSTEM focus (foreground) — serialize + flag them.
  withCoordinateLock { postKey(flags: parsed.flags, key: parsed.key) }
  return ["ok": true, "background": false]
}

private func doScroll(_ params: [String: Any]) -> [String: Any] {
  let amount = intOf(params["amount"]) ?? 300
  let dir = (stringOf(params["direction"]) ?? "down").lowercased()
  var dx = 0
  var dy = 0
  switch dir {
  case "down": dy = -amount
  case "up": dy = amount
  case "left": dx = amount
  case "right": dx = -amount
  default: dy = -amount
  }
  // Scroll posts at the shared cursor position (foreground) — serialize + flag.
  withCoordinateLock { postScroll(dx: dx, dy: dy) }
  return ["ok": true, "background": false]
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
  case "snapshot": return doSnapshot(params)  // nil → target unresolved
  case "click": return doClick(params)
  case "type": return doType(params)
  case "key": return doKey(params)
  case "scroll": return doScroll(params)
  case "focus": return doFocus(params)
  case "screenshot": return doScreenshot(params)
  default: return nil
  }
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
