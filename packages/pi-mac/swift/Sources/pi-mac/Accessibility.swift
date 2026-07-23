import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// ── AX attribute readers (all total: a failed copy → nil) ────────────────────

func axCopy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
  var ref: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(el, attr as CFString, &ref)
  return err == .success ? ref : nil
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
  guard let v = axCopy(el, attr) else { return nil }
  return v as? String
}

func axBool(_ el: AXUIElement, _ attr: String) -> Bool? {
  guard let v = axCopy(el, attr) else { return nil }
  return v as? Bool
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
  guard let v = axCopy(el, kAXChildrenAttribute) else { return [] }
  return (v as? [AXUIElement]) ?? []
}

func axActions(_ el: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(el, &names) == .success, let arr = names else { return [] }
  return (arr as? [String]) ?? []
}

func axPoint(_ el: AXUIElement, _ attr: String) -> CGPoint? {
  guard let v = axCopy(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  // swiftlint:disable:next force_cast
  let axv = v as! AXValue
  var pt = CGPoint.zero
  guard AXValueGetValue(axv, .cgPoint, &pt) else { return nil }
  return pt
}

func axSize(_ el: AXUIElement, _ attr: String) -> CGSize? {
  guard let v = axCopy(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  // swiftlint:disable:next force_cast
  let axv = v as! AXValue
  var sz = CGSize.zero
  guard AXValueGetValue(axv, .cgSize, &sz) else { return nil }
  return sz
}

func axSettable(_ el: AXUIElement, _ attr: String) -> Bool {
  var settable: DarwinBoolean = false
  let err = AXUIElementIsAttributeSettable(el, attr as CFString, &settable)
  return err == .success && settable.boolValue
}

// Private (but decades-stable) CoreGraphics↔AX bridge: map an AXUIElement WINDOW
// to its CGWindowID. That id lets us screenshot exactly that window
// (`screencapture -l <id>`) even when it is occluded or NOT frontmost — the
// focus-free perception surface for a background app. Declared via its C symbol.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ windowID: UnsafeMutablePointer<CGWindowID>)
  -> AXError

/// The CGWindowID for an AX window element, or nil if it isn't a window / the
/// bridge fails.
func axWindowID(_ el: AXUIElement) -> CGWindowID? {
  var wid: CGWindowID = 0
  return _AXUIElementGetWindow(el, &wid) == .success && wid != 0 ? wid : nil
}

// ── target resolution ────────────────────────────────────────────────────────

/// A snapshot target the caller can name: the frontmost app, a specific pid, or
/// an app matched by (case-insensitive) localized name / bundle id.
enum SnapshotTarget {
  case frontmost
  case pid(pid_t)
  case app(String)
}

func resolveTargetPid(_ target: SnapshotTarget) -> (pid: pid_t, name: String)? {
  switch target {
  case .frontmost:
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    return (app.processIdentifier, app.localizedName ?? "frontmost")
  case .pid(let pid):
    let running = NSRunningApplication(processIdentifier: pid)
    return (pid, running?.localizedName ?? "pid \(pid)")
  case .app(let query):
    let q = query.lowercased()
    for app in NSWorkspace.shared.runningApplications {
      let name = (app.localizedName ?? "").lowercased()
      let bundle = (app.bundleIdentifier ?? "").lowercased()
      if name == q || bundle == q || name.contains(q) {
        return (app.processIdentifier, app.localizedName ?? query)
      }
    }
    return nil
  }
}

// ── snapshot ─────────────────────────────────────────────────────────────────

/// One indexed AX element as the model sees it (mirror of browser-use's
/// SnapshotElement). Coordinates are SCREEN points (top-left origin) — the same
/// space CGEvent mouse posts use — so an index resolves to a click with no
/// coordinate math on the Node side.
struct SnapEl {
  let index: Int
  let role: String
  let name: String
  let x: Int
  let y: Int
  let w: Int
  let h: Int
  let editable: Bool
  let enabled: Bool
  let focused: Bool
  let value: String
  let actions: [String]
  let element: AXUIElement
}

/// Roles worth surfacing even when they expose no AX action (so a text area the
/// model must type into is never dropped). Mirrors browser perception's
/// interactive-selector set.
private let INTERACTIVE_ROLES: Set<String> = [
  "AXButton", "AXTextField", "AXTextArea", "AXComboBox", "AXPopUpButton", "AXMenuButton",
  "AXCheckBox", "AXRadioButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXSlider",
  "AXIncrementor", "AXTab", "AXTabGroup", "AXDisclosureTriangle", "AXSearchField", "AXCell",
  "AXRow", "AXColorWell", "AXStepper", "AXSegmentedControl", "AXToolbarButton",
]

/// Chrome/decoration roles that are never useful action targets — dropping them
/// keeps the indexed list focused on things the model can meaningfully click or
/// type into (TextEdit alone exposes ~30 ruler markers otherwise).
private let NOISE_ROLES: Set<String> = [
  "AXRuler", "AXRulerMarker", "AXScrollBar", "AXGrowArea", "AXSplitter", "AXValueIndicator",
  "AXIncrementorArrow", "AXLayoutItem", "AXLayoutArea", "AXUnknown",
]

private let NAME_MAX = 120
private let MAX_NODES = 4000

func cleanText(_ s: String) -> String {
  let collapsed = s.replacingOccurrences(
    of: "\\s+", with: " ", options: .regularExpression)
  return collapsed.trimmingCharacters(in: .whitespacesAndNewlines)
}

func truncate(_ s: String, _ max: Int) -> String {
  if s.count <= max { return s }
  return String(s.prefix(max - 1)) + "…"
}

private func accessibleName(_ el: AXUIElement, role: String) -> String {
  if let t = axString(el, kAXTitleAttribute), !cleanText(t).isEmpty { return cleanText(t) }
  if let d = axString(el, kAXDescriptionAttribute), !cleanText(d).isEmpty { return cleanText(d) }
  // A value is a decent name for buttons/links whose title is empty.
  if let v = axString(el, kAXValueAttribute), !cleanText(v).isEmpty {
    return cleanText(v)
  }
  if let placeholder = axString(el, kAXPlaceholderValueAttribute), !cleanText(placeholder).isEmpty {
    return cleanText(placeholder)
  }
  if let rd = axString(el, kAXRoleDescriptionAttribute), !cleanText(rd).isEmpty {
    return cleanText(rd)
  }
  return ""
}

private func isEditable(_ el: AXUIElement, role: String) -> Bool {
  if role == "AXTextField" || role == "AXTextArea" || role == "AXComboBox"
    || role == "AXSearchField"
  {
    return true
  }
  return axSettable(el, kAXValueAttribute)
}

/// Whole main-display bounds, used only to prefer on-screen elements first.
private func mainDisplayBounds() -> CGRect {
  if let screen = NSScreen.main { return screen.frame }
  return CGRect(x: 0, y: 0, width: 100_000, height: 100_000)
}

/// Pick the window subtree to walk: focused window, else main window, else the
/// first window, else the whole app element (menus, sheets).
func rootFor(app: AXUIElement) -> AXUIElement {
  if let w = axCopy(app, kAXFocusedWindowAttribute) { return (w as! AXUIElement) }  // swiftlint:disable:this force_cast
  if let w = axCopy(app, kAXMainWindowAttribute) { return (w as! AXUIElement) }  // swiftlint:disable:this force_cast
  let windows = axChildren(app)
  return windows.first ?? app
}

struct SnapshotResult {
  let elements: [SnapEl]
  let appName: String
  let windowTitle: String
  let truncated: Bool
  let total: Int
  /// PID of the resolved target app. The serve loop namespaces its index→element
  /// map by this so concurrent sessions driving DIFFERENT apps never clobber each
  /// other's indices (concurrency-safe across apps).
  let pid: pid_t
  /// CGWindowID of the snapshotted window (when the root is a window), so a
  /// focus-free per-window screenshot can target exactly it.
  let windowId: CGWindowID?
  /// The snapshotted window's frame in GLOBAL screen points (top-left origin),
  /// when the root is a real window — the cursor overlay positions itself over
  /// exactly this rect. Nil when the root fell back to the app element.
  let windowBounds: CGRect?
}

/// Walk the AX tree of `target` and return a COMPACT, INDEXED element list
/// (default cap 60). Deterministic document-order traversal; on-screen elements
/// sort first. Returns nil only when the target app cannot be resolved; an empty
/// list (AX not granted → every copy fails) is a valid, non-nil result.
func collectSnapshot(target: SnapshotTarget, cap: Int) -> SnapshotResult? {
  guard let resolved = resolveTargetPid(target) else { return nil }
  let app = AXUIElementCreateApplication(resolved.pid)
  let root = rootFor(app: app)
  let windowTitle = axString(root, kAXTitleAttribute) ?? ""
  let windowId = axWindowID(root)
  let windowBounds = windowFrame(root)
  let bounds = mainDisplayBounds()

  struct Cand {
    let el: AXUIElement
    let role: String
    let name: String
    let rect: CGRect
    let editable: Bool
    let enabled: Bool
    let focused: Bool
    let value: String
    let actions: [String]
    let onScreen: Bool
  }

  var cands: [Cand] = []
  var visited = 0
  var stack: [AXUIElement] = [root]

  while let el = stack.popLast() {
    if visited >= MAX_NODES { break }
    visited += 1
    // Push children (reversed so pop order == document order).
    let kids = axChildren(el)
    for kid in kids.reversed() { stack.append(kid) }

    let role = axString(el, kAXRoleAttribute) ?? ""
    if role.isEmpty || NOISE_ROLES.contains(role) { continue }
    let actions = axActions(el)
    let editable = isEditable(el, role: role)
    let pressable = actions.contains("AXPress") || actions.contains("AXConfirm")
    let interactive = INTERACTIVE_ROLES.contains(role)
    if !editable && !pressable && !interactive { continue }

    let name = accessibleName(el, role: role)
    if name.isEmpty && !editable { continue }  // nameless non-field control → skip

    let pos = axPoint(el, kAXPositionAttribute) ?? CGPoint(x: -1, y: -1)
    let size = axSize(el, kAXSizeAttribute) ?? CGSize(width: 0, height: 0)
    if size.width <= 1 || size.height <= 1 { continue }
    let rect = CGRect(origin: pos, size: size)
    let value = editable ? (axString(el, kAXValueAttribute) ?? "") : ""
    let enabled = axBool(el, kAXEnabledAttribute) ?? true
    let focused = axBool(el, kAXFocusedAttribute) ?? false
    let onScreen = rect.intersects(bounds)

    cands.append(
      Cand(
        el: el, role: role, name: truncate(name, NAME_MAX), rect: rect, editable: editable,
        enabled: enabled, focused: focused, value: truncate(cleanText(value), NAME_MAX),
        actions: actions, onScreen: onScreen))
  }

  // On-screen first, then document order (traversal already document order, so a
  // stable partition preserves it).
  let onScreenCands = cands.filter { $0.onScreen }
  let offScreenCands = cands.filter { !$0.onScreen }
  let ordered = onScreenCands + offScreenCands

  let limit = cap > 0 ? cap : ordered.count
  var elements: [SnapEl] = []
  var i = 0
  for c in ordered {
    if i >= limit { break }
    i += 1
    elements.append(
      SnapEl(
        index: i, role: c.role, name: c.name,
        x: Int(c.rect.midX.rounded()), y: Int(c.rect.midY.rounded()),
        w: Int(c.rect.width.rounded()), h: Int(c.rect.height.rounded()),
        editable: c.editable, enabled: c.enabled, focused: c.focused, value: c.value,
        actions: c.actions, element: c.el))
  }

  return SnapshotResult(
    elements: elements, appName: resolved.name, windowTitle: windowTitle,
    truncated: ordered.count > elements.count, total: ordered.count,
    pid: resolved.pid, windowId: windowId, windowBounds: windowBounds)
}

/// Frame of an AX window element in global screen points, or nil when the
/// element has no position/size (an app element with no window yet).
func windowFrame(_ el: AXUIElement) -> CGRect? {
  guard let pos = axPoint(el, kAXPositionAttribute), let size = axSize(el, kAXSizeAttribute),
    size.width > 1, size.height > 1
  else { return nil }
  return CGRect(origin: pos, size: size)
}

/// Live window-geometry probe for one target: frame + windowId + whether the
/// app is frontmost. This is what the app's overlay polls to TRACK the
/// controlled window (moves/resizes) and what the no-focus-steal probe asserts
/// on. Returns nil when the target has no resolvable window (not running / no
/// window yet — the launch poller treats that as "keep waiting").
func windowBoundsInfo(target: SnapshotTarget) -> [String: Any]? {
  guard let resolved = resolveTargetPid(target) else { return nil }
  let app = AXUIElementCreateApplication(resolved.pid)
  let root = rootFor(app: app)
  guard let frame = windowFrame(root) else { return nil }
  var d: [String: Any] = [
    "ok": true,
    "app": resolved.name,
    "pid": Int(resolved.pid),
    "x": Int(frame.origin.x.rounded()),
    "y": Int(frame.origin.y.rounded()),
    "w": Int(frame.width.rounded()),
    "h": Int(frame.height.rounded()),
    "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == resolved.pid,
    "windowTitle": axString(root, kAXTitleAttribute) ?? "",
  ]
  if let wid = axWindowID(root) {
    d["windowId"] = Int(wid)
    // Z-order truth for the overlay's app-scoping (one cheap window-server
    // read): is the window on the CURRENT space, and how much of it is covered
    // by OTHER apps' windows above it? The overlay hides while occluded — the
    // phantom must never paint on top of whatever covers the controlled app.
    let z = zOrderInfo(windowId: wid, pid: resolved.pid, fallbackFrame: frame)
    d["onScreen"] = z.onScreen
    d["occluded"] = z.onScreen && z.coveredFraction >= OCCLUSION_FRACTION
    d["covered"] = (z.coveredFraction * 100).rounded() / 100
  }
  return d
}

/// Find the scroll area to target for a scroll at `pt`: the DEEPEST
/// AXScrollArea whose frame contains the point (DFS visits descendants after
/// ancestors, so the last hit is the innermost), else the largest scroll area
/// in the window. Nil when the window exposes none (AX-opaque surface).
func findScrollArea(in root: AXUIElement, containing pt: CGPoint) -> AXUIElement? {
  var bestContaining: AXUIElement?
  var largest: AXUIElement?
  var largestArea: CGFloat = 0
  var stack: [AXUIElement] = [root]
  var visited = 0
  while let el = stack.popLast() {
    visited += 1
    if visited > 1500 { break }
    if (axString(el, kAXRoleAttribute) ?? "") == "AXScrollArea",
      let pos = axPoint(el, kAXPositionAttribute), let size = axSize(el, kAXSizeAttribute)
    {
      let rect = CGRect(origin: pos, size: size)
      if rect.contains(pt) { bestContaining = el }
      let area = rect.width * rect.height
      if area > largestArea {
        largestArea = area
        largest = el
      }
    }
    for kid in axChildren(el) { stack.append(kid) }
  }
  return bestContaining ?? largest
}

/// The scroll area's scroll bar for the given axis, when it exposes one.
func scrollBarOf(_ scrollArea: AXUIElement, horizontal: Bool) -> AXUIElement? {
  let attr = horizontal ? kAXHorizontalScrollBarAttribute : kAXVerticalScrollBarAttribute
  guard let ref = axCopy(scrollArea, attr) else { return nil }
  return (ref as! AXUIElement)  // swiftlint:disable:this force_cast
}

/// A scroll bar's normalized 0…1 value — the scroll ladder's VERIFICATION
/// signal ("did content actually move?") and its last-resort actuator.
func scrollBarValue(_ bar: AXUIElement) -> Double? {
  guard let ref = axCopy(bar, kAXValueAttribute) else { return nil }
  return (ref as? NSNumber)?.doubleValue
}

/// Set a scroll bar's normalized value directly (background, focus-free) —
/// the ladder's final rung when no synthetic wheel event moves the content.
func setScrollBarValue(_ bar: AXUIElement, _ value: Double) -> Bool {
  let clamped = min(1.0, max(0.0, value))
  return AXUIElementSetAttributeValue(
    bar, kAXValueAttribute as CFString, NSNumber(value: clamped) as CFTypeRef) == .success
}

/// Move the target's window to a new top-left position (AX position write).
/// Powers the `moveWindow` serve method — the deterministic "drag" the live
/// probes use to measure overlay tracking latency.
func moveWindowTo(target: SnapshotTarget, x: Double, y: Double) -> Bool {
  guard let resolved = resolveTargetPid(target) else { return false }
  let app = AXUIElementCreateApplication(resolved.pid)
  let root = rootFor(app: app)
  var pt = CGPoint(x: x, y: y)
  guard let value = AXValueCreate(.cgPoint, &pt) else { return false }
  return AXUIElementSetAttributeValue(root, kAXPositionAttribute as CFString, value) == .success
}

/// Serialize a snapshot element (minus the live AXUIElement) for the wire.
func elementDict(_ el: SnapEl) -> [String: Any] {
  var d: [String: Any] = [
    "index": el.index,
    "role": el.role,
    "name": el.name,
    "bbox": ["x": el.x, "y": el.y, "w": el.w, "h": el.h],
    "enabled": el.enabled,
  ]
  if el.editable { d["editable"] = true }
  if el.focused { d["focused"] = true }
  if !el.value.isEmpty { d["value"] = el.value }
  if !el.actions.isEmpty { d["actions"] = el.actions }
  return d
}

func snapshotResultDict(_ snap: SnapshotResult, screenshot: [String: Any]?) -> [String: Any] {
  var result: [String: Any] = [
    "app": snap.appName,
    "pid": Int(snap.pid),
    "window": snap.windowTitle,
    "elements": snap.elements.map(elementDict),
    "summary": [
      "app": snap.appName,
      "window": snap.windowTitle,
      "elementCount": snap.total,
      "truncated": snap.truncated,
    ],
  ]
  if let wid = snap.windowId { result["windowId"] = Int(wid) }
  if let wb = snap.windowBounds {
    result["windowBounds"] = [
      "x": Int(wb.origin.x.rounded()), "y": Int(wb.origin.y.rounded()),
      "w": Int(wb.width.rounded()), "h": Int(wb.height.rounded()),
    ]
  }
  if let shot = screenshot { result["screenshot"] = shot }
  return result
}
