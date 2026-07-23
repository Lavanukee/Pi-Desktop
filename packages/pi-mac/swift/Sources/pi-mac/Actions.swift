import ApplicationServices
import CoreGraphics
import Foundation

// ── virtual keycodes (US layout) ─────────────────────────────────────────────
// Enough of the map to drive real UIs: letters, digits, and the named keys that
// show up in combos + menus. Typing arbitrary text does NOT use this table — it
// injects unicode directly (see `typeText`), so this only needs the keys people
// actually chord on (⌘S, Tab, Escape, arrows, …).

private let CHAR_KEYCODES: [Character: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
  "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
  "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
  "m": 46, ".": 47, "`": 50, " ": 49,
]

private let NAMED_KEYCODES: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
  "escape": 53, "esc": 53, "forwarddelete": 117,
  "left": 123, "right": 124, "down": 125, "up": 126,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
  "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

// ── coordinate-op serialization (the exclusive, foreground fallback) ─────────
//
// The system cursor and the keyboard focus are ONE shared, global resource. An
// AX-by-PID op (AXPress / AXSetValue / AXConfirm) targets a specific element by
// reference and touches NONE of it — no cursor move, no focus change — so those
// ops are focus-free and safe to interleave across different apps. The CGEvent
// fallback (a synthetic click / keystroke / scroll posted at the shared cursor &
// system focus) is the opposite: foreground and EXCLUSIVE. This lock single-
// flights it so two coordinate ops can never interleave their mouse/key events.
//
// (The `--serve` loop is single-threaded, so within one helper process requests
// are already serialized; this lock also guards the one-shot `--act` path and
// documents the exclusivity the concurrency model promises. AX ops deliberately
// do NOT take it.)
let coordinateLock = NSLock()

@discardableResult
func withCoordinateLock<T>(_ body: () -> T) -> T {
  coordinateLock.lock()
  defer { coordinateLock.unlock() }
  return body()
}

private func modifierFlag(_ token: String) -> CGEventFlags? {
  switch token {
  case "cmd", "command", "⌘", "meta", "super", "win": return .maskCommand
  case "shift", "⇧": return .maskShift
  case "alt", "option", "opt", "⌥": return .maskAlternate
  case "ctrl", "control", "⌃": return .maskControl
  case "fn", "function": return .maskSecondaryFn
  default: return nil
  }
}

/// Parse a combo like `cmd+s`, `⌘⇧z`, `ctrl+alt+delete` into (flags, keycode).
func parseCombo(_ combo: String) -> (flags: CGEventFlags, key: CGKeyCode)? {
  let normalized =
    combo
    .replacingOccurrences(of: "⌘", with: "cmd+")
    .replacingOccurrences(of: "⇧", with: "shift+")
    .replacingOccurrences(of: "⌥", with: "alt+")
    .replacingOccurrences(of: "⌃", with: "ctrl+")
    .lowercased()
  let parts = normalized.split(whereSeparator: { $0 == "+" || $0 == "-" && normalized.count > 1 })
    .map { String($0).trimmingCharacters(in: .whitespaces) }
    .filter { !$0.isEmpty }
  guard !parts.isEmpty else { return nil }

  var flags: CGEventFlags = []
  var keyToken: String? = nil
  for part in parts {
    if let f = modifierFlag(part) {
      flags.insert(f)
    } else {
      keyToken = part  // last non-modifier wins
    }
  }
  guard let token = keyToken else {
    // A pure modifier combo is not actionable as a keypress.
    return nil
  }
  if let named = NAMED_KEYCODES[token] { return (flags, named) }
  if token.count == 1, let code = CHAR_KEYCODES[Character(token)] { return (flags, code) }
  return nil
}

// ── CGEvent primitives ───────────────────────────────────────────────────────

private func eventSource() -> CGEventSource? {
  CGEventSource(stateID: .hidSystemState)
}

/// Synthetic left click at a SCREEN point (top-left origin points — same space
/// as AX positions). Move-then-down-then-up so apps that track hover fire.
func postClick(x: Double, y: Double) {
  let src = eventSource()
  let pt = CGPoint(x: x, y: y)
  CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)?
    .post(tap: .cghidEventTap)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)?
    .post(tap: .cghidEventTap)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)?
    .post(tap: .cghidEventTap)
}

/// Type a unicode string by injecting it on synthetic key events (per character,
/// so long strings and IME-sensitive fields behave). No keycode table needed.
func typeText(_ text: String) {
  let src = eventSource()
  for ch in text {
    let s = String(ch)
    var utf16 = Array(s.utf16)
    if let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) {
      down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
      down.post(tap: .cghidEventTap)
    }
    if let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
      up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
      up.post(tap: .cghidEventTap)
    }
  }
}

/// Post a key combo (modifiers + one key) as a keyDown/keyUp pair with the
/// modifier flags set on the event.
///
/// Load-bearing tap choice: `.cgSessionEventTap` (NOT `.cghidEventTap`). The HID
/// tap sits below the point where a synthetic event's own flags are honored — it
/// recomputes modifiers from the physical keyboard state and drops the ones we
/// set, so a chord like ⌘A arrives as a bare "a" (verified against TextEdit). The
/// session tap honors the event's `.flags`, so the chord lands. Plain unicode
/// typing + clicks stay on the HID tap, where they already work.
func postKey(flags: CGEventFlags, key: CGKeyCode) {
  let src = eventSource()
  if let down = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: true) {
    down.flags = flags
    down.post(tap: .cgSessionEventTap)
  }
  if let up = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: false) {
    up.flags = flags
    up.post(tap: .cgSessionEventTap)
  }
}

/// How many continuous pixel events one scroll request is broken into. A short
/// burst of small CONTINUOUS (trackpad-style) events is honored by momentum
/// scroll views that swallow a single large discrete wheel notch — which is
/// exactly the background no-op seen in System Settings. Cumulative rounding
/// keeps the posted total equal to the requested delta.
private let SCROLL_STEPS = 10

/// Emit `dx,dy` as `SCROLL_STEPS` continuous pixel scroll events through `sink`
/// (the caller posts each to the HID tap or to a pid). Each event carries the
/// incremental delta and the `.scrollWheelEventIsContinuous` flag.
private func emitScrollSteps(
  _ src: CGEventSource?, dx: Int, dy: Int, at location: CGPoint?, _ sink: (CGEvent) -> Void
) {
  guard dx != 0 || dy != 0 else { return }
  var postedX = 0
  var postedY = 0
  for i in 1...SCROLL_STEPS {
    let targetX = Int((Double(dx) * Double(i) / Double(SCROLL_STEPS)).rounded())
    let targetY = Int((Double(dy) * Double(i) / Double(SCROLL_STEPS)).rounded())
    let stepX = targetX - postedX
    let stepY = targetY - postedY
    postedX = targetX
    postedY = targetY
    guard
      let ev = CGEvent(
        scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: Int32(stepY),
        wheel2: Int32(stepX), wheel3: 0)
    else { continue }
    ev.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    if let loc = location { ev.location = loc }
    sink(ev)
  }
}

/// Scroll wheel by pixel deltas at the current cursor (positive dy scrolls up on
/// macOS natural direction; the tool normalizes direction).
func postScroll(dx: Int, dy: Int) {
  let src = eventSource()
  emitScrollSteps(src, dx: dx, dy: dy, at: nil) { $0.post(tap: .cghidEventTap) }
}

// ── pid-targeted posting (the BACKGROUND input path) ─────────────────────────
//
// `CGEvent.postToPid` delivers an event DIRECTLY into one process's event queue,
// bypassing the window server's frontmost routing entirely: the target app
// receives the click/keystroke while the USER's app keeps the real focus and the
// real cursor never moves. This is what lets a controlled app stay in the
// background for its whole session. These functions deliberately do NOT take the
// coordinate lock — they touch neither the shared cursor nor the system focus,
// so they are safe to interleave with the user's own input and with each other.
// (Same TCC gate as posting to the HID tap: the Accessibility grant.)

/// Synthetic left click delivered to `pid` only. Coordinates stay GLOBAL screen
/// points — the receiving app hit-tests them against its own windows.
func postClickToPid(_ pid: pid_t, x: Double, y: Double) {
  let src = eventSource()
  let pt = CGPoint(x: x, y: y)
  CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)?
    .postToPid(pid)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)?
    .postToPid(pid)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)?
    .postToPid(pid)
}

/// Type a unicode string into `pid`'s key window without the app being
/// frontmost (unicode injection per character, like `typeText`).
func typeTextToPid(_ pid: pid_t, _ text: String) {
  let src = eventSource()
  for ch in text {
    let s = String(ch)
    var utf16 = Array(s.utf16)
    if let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) {
      down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
      down.postToPid(pid)
    }
    if let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
      up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
      up.postToPid(pid)
    }
  }
}

/// Post a key chord (modifiers + one key) to `pid` only. Unlike the HID tap,
/// pid delivery honors the event's own `.flags`, so chords land correctly.
func postKeyToPid(_ pid: pid_t, flags: CGEventFlags, key: CGKeyCode) {
  let src = eventSource()
  if let down = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: true) {
    down.flags = flags
    down.postToPid(pid)
  }
  if let up = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: false) {
    up.flags = flags
    up.postToPid(pid)
  }
}

/// Scroll `pid`'s content without focus: every event's location is pinned to a
/// point INSIDE the target window (its centre) so the app's hit-test finds a
/// scrollable view even though the real cursor is elsewhere. Delivered as a
/// burst of continuous pixel events (see emitScrollSteps) — a single background
/// wheel notch is easy for a momentum scroll view to ignore.
func postScrollToPid(_ pid: pid_t, dx: Int, dy: Int, at pt: CGPoint) {
  let src = eventSource()
  // Align the target's hit-test to the scroll point first (background move,
  // delivered only to this pid — the real cursor never moves).
  CGEvent(
    mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)?
    .postToPid(pid)
  emitScrollSteps(src, dx: dx, dy: dy, at: pt) { $0.postToPid(pid) }
}

/// Trackpad-style scroll GESTURE delivered to `pid`: a began/changed/ended
/// phase sequence of continuous pixel events. Some scroll views (SwiftUI /
/// System Settings panes) ignore phase-less wheel events but track a phased
/// gesture — the second rung of the verified scroll ladder in doScroll.
func postScrollGestureToPid(_ pid: pid_t, dx: Int, dy: Int, at pt: CGPoint) {
  let src = eventSource()
  func phased(_ d1: Int32, _ d2: Int32, phase: Int64) -> CGEvent? {
    guard
      let ev = CGEvent(
        scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: d1, wheel2: d2,
        wheel3: 0)
    else { return nil }
    ev.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    ev.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
    ev.location = pt
    return ev
  }
  // kCGScrollPhaseBegan = 1, Changed = 2, Ended = 4. Split the delta over a
  // few changed-events so views that integrate velocity see a real gesture.
  phased(0, 0, phase: 1)?.postToPid(pid)
  let steps: Int32 = 3
  for _ in 0..<steps {
    phased(Int32(dy) / steps, Int32(dx) / steps, phase: 2)?.postToPid(pid)
  }
  phased(0, 0, phase: 4)?.postToPid(pid)
}

/// Legacy LINE-unit wheel scroll delivered to `pid` — the third rung: some AX
/// hosts only honor discrete wheel lines.
func postLineScrollToPid(_ pid: pid_t, dx: Int, dy: Int, at pt: CGPoint) {
  let src = eventSource()
  func lines(_ v: Int) -> Int32 {
    if v == 0 { return 0 }
    return Int32(max(1, abs(v) / 40)) * (v < 0 ? -1 : 1)
  }
  guard
    let ev = CGEvent(
      scrollWheelEvent2Source: src, units: .line, wheelCount: 2, wheel1: lines(dy),
      wheel2: lines(dx), wheel3: 0)
  else { return }
  ev.location = pt
  ev.postToPid(pid)
}

/// AX-FIRST press. Try the element's own focus-free AX actions in preference
/// order (AXPress → AXConfirm → AXPick) — these fire the control WITHOUT moving
/// the cursor or changing which app is frontmost, so the user can keep working
/// and a background app can be driven. If the element exposes no usable AX
/// action, fall back to a synthetic coordinate click: delivered to `targetPid`
/// (still background, via postToPid) when the caller knows which app owns the
/// element, else posted at the shared cursor (foreground — serialized under the
/// coordinate lock).
///
/// Returns the mode that ran and whether it stayed in the BACKGROUND (true = no
/// focus steal; false = the shared-cursor fallback, foreground).
func performPress(_ el: AXUIElement, x: Double, y: Double, targetPid: pid_t?) -> (
  mode: String, background: Bool
) {
  let available = Set(axActions(el))
  // (reported name as axActions lists it, CFString the perform call needs)
  let axChain: [(name: String, action: CFString)] = [
    ("AXPress", kAXPressAction as CFString),
    ("AXConfirm", kAXConfirmAction as CFString),
    ("AXPick", kAXPickAction as CFString),
  ]
  for step in axChain where available.contains(step.name) {
    if AXUIElementPerformAction(el, step.action) == .success {
      return (step.name, true)
    }
  }
  if let pid = targetPid {
    postClickToPid(pid, x: x, y: y)
    return ("coordToPid", true)
  }
  withCoordinateLock { postClick(x: x, y: y) }
  return ("coord", false)
}

/// Set an editable element's AX value directly (crisp for text fields, and
/// focus-free: it does NOT bring the app frontmost or move the caret with
/// keystrokes). Returns false if the element rejects a value set, so the caller
/// can fall back to focusing + synthetic typing.
func setValue(_ el: AXUIElement, _ text: String) -> Bool {
  guard axSettable(el, kAXValueAttribute) else { return false }
  return AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFTypeRef)
    == .success
}

/// Try a BACKGROUND AX confirm/submit on `el` (e.g. commit a search field)
/// without a keystroke. Returns true only if the element exposed & accepted an
/// AXConfirm action — otherwise the caller must fall back to a focused Return.
func confirmElement(_ el: AXUIElement) -> Bool {
  guard Set(axActions(el)).contains("AXConfirm") else { return false }
  return AXUIElementPerformAction(el, kAXConfirmAction as CFString) == .success
}

/// Raise + focus an element so subsequent typing lands in it. (Setting AXFocused
/// can bring the app frontmost — this is the foreground bridge used only when AX
/// value-set / confirm are unavailable.)
func focusElement(_ el: AXUIElement) {
  _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
}

/// Foreground fallback submit: a synthetic Return (keycode 36), serialized under
/// the coordinate lock. Goes to whatever holds the SYSTEM focus, so callers must
/// focus the target element first.
func pressReturn() {
  withCoordinateLock { postKey(flags: [], key: 36) }
}
