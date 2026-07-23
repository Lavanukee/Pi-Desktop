import AppKit
import CoreGraphics
import Foundation

// ── z-order / occlusion probe ────────────────────────────────────────────────
//
// One z-ordered CGWindowListCopyWindowInfo read answers the two questions the
// cursor overlay's app-scoping and the scroll ladder both need:
//
//   1. Is the controlled window MEANINGFULLY COVERED by other apps' windows
//      above it in z? (The phantom cursor must never paint on top of whatever
//      the user dragged over the controlled app — jedd's field report.)
//   2. Where inside the controlled window is a point NOT covered by anyone
//      else? (A scroll event's location must hit-test to OUR window; a point
//      under another app's window routes the event nowhere.)
//
// This costs one window-server round trip (~a fraction of a ms) per call and
// piggybacks on the overlay's existing bounds-poll cadence.

/// Fraction of the controlled window that must be covered by OTHER apps'
/// normal windows (above it in z) before we call it occluded.
let OCCLUSION_FRACTION = 0.15

struct ZOrderInfo {
  /// Live frame from the window server (nil when the window is not on the
  /// current space / minimized — CGWindowList onScreenOnly drops it).
  let frame: CGRect?
  /// The window is on the CURRENT space and not minimized.
  let onScreen: Bool
  /// 0…1 fraction of the window covered by other apps' windows above it.
  let coveredFraction: Double
  /// The occluders' rects (screen points) — the scroll point picker dodges
  /// them so a pinned CGEvent location hit-tests OUR window, not theirs.
  let occluders: [CGRect]
}

/// Windows above `windowId` in z that can visually cover it: normal layer,
/// other pids, actually painted. (The phantom overlay itself floats at an
/// elevated window level → filtered out by the layer check; Pi Desktop's own
/// normal windows DO count — if the user drags our app over the controlled one
/// the cursor must hide like for any other window.)
func zOrderInfo(windowId: CGWindowID?, pid: pid_t, fallbackFrame: CGRect?) -> ZOrderInfo {
  guard
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
      as? [[String: Any]]
  else {
    return ZOrderInfo(frame: nil, onScreen: false, coveredFraction: 0, occluders: [])
  }
  var above: [CGRect] = []
  var ourFrame: CGRect?
  var sawOurWindow = false
  for w in list {
    let num = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value
    if let wid = windowId, num == wid {
      sawOurWindow = true
      if let b = w[kCGWindowBounds as String] as? NSDictionary,
        let r = CGRect(dictionaryRepresentation: b)
      {
        ourFrame = r
      }
      break
    }
    guard (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 else { continue }
    guard let owner = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
      pid_t(owner) != pid
    else { continue }
    if let alpha = (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue, alpha < 0.05 {
      continue
    }
    if let b = w[kCGWindowBounds as String] as? NSDictionary,
      let r = CGRect(dictionaryRepresentation: b)
    {
      above.append(r)
    }
  }
  guard let target = ourFrame ?? fallbackFrame else {
    return ZOrderInfo(frame: nil, onScreen: false, coveredFraction: 0, occluders: above)
  }
  let overlaps = above.map { $0.intersection(target) }.filter { !$0.isEmpty && $0.width > 0 }
  let covered = unionArea(overlaps)
  let area = target.width * target.height
  let fraction = area > 0 ? Double(covered / area) : 0
  return ZOrderInfo(
    frame: ourFrame, onScreen: sawOurWindow, coveredFraction: min(1, max(0, fraction)),
    occluders: above)
}

/// Exact area of a union of rects (coordinate-compression sweep — the rect
/// count here is tiny, a handful of windows at most).
func unionArea(_ rects: [CGRect]) -> CGFloat {
  let rs = rects.filter { $0.width > 0 && $0.height > 0 }
  if rs.isEmpty { return 0 }
  var xs: Set<CGFloat> = []
  for r in rs {
    xs.insert(r.minX)
    xs.insert(r.maxX)
  }
  let sx = xs.sorted()
  var total: CGFloat = 0
  for i in 0..<(sx.count - 1) {
    let x0 = sx[i]
    let x1 = sx[i + 1]
    let mid = (x0 + x1) / 2
    let spans = rs.filter { $0.minX <= mid && mid < $0.maxX }
      .map { (lo: $0.minY, hi: $0.maxY) }
      .sorted { $0.lo < $1.lo }
    var covered: CGFloat = 0
    var curLo: CGFloat = 0
    var curHi: CGFloat = 0
    var open = false
    for s in spans {
      if !open {
        curLo = s.lo
        curHi = s.hi
        open = true
      } else if s.lo > curHi {
        covered += curHi - curLo
        curLo = s.lo
        curHi = s.hi
      } else {
        curHi = max(curHi, s.hi)
      }
    }
    if open { covered += curHi - curLo }
    total += covered * (x1 - x0)
  }
  return total
}

/// A point INSIDE `rect` not covered by any other app's window above ours —
/// where a pinned CGEvent location will hit-test to OUR window. Prefers the
/// given point; else grid-searches the window (skipping the title-bar strip),
/// nearest-to-preferred first. Nil when the window is completely covered.
func unobstructedPoint(
  windowId: CGWindowID?, pid: pid_t, preferred: CGPoint, rect: CGRect
) -> CGPoint? {
  let z = zOrderInfo(windowId: windowId, pid: pid, fallbackFrame: rect)
  let occluders = z.occluders
  func clear(_ p: CGPoint) -> Bool {
    rect.contains(p) && !occluders.contains { $0.contains(p) }
  }
  if clear(preferred) { return preferred }
  var best: CGPoint?
  var bestD = CGFloat.greatestFiniteMagnitude
  for fy in stride(from: 0.2, through: 0.9, by: 0.1) {
    for fx in stride(from: 0.08, through: 0.92, by: 0.07) {
      let p = CGPoint(
        x: rect.minX + rect.width * CGFloat(fx), y: rect.minY + rect.height * CGFloat(fy))
      guard clear(p) else { continue }
      let d = hypot(p.x - preferred.x, p.y - preferred.y)
      if d < bestD {
        bestD = d
        best = p
      }
    }
  }
  return best
}
