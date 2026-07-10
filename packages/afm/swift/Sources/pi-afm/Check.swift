import Foundation
import FoundationModels

/// `--check` output line. `reason` is a stable string enum the Node side gates
/// on. `contextWindow` is the on-device model's shared per-session token
/// ceiling (input + instructions + history + output all share it).
struct CheckOutput: Encodable {
  let available: Bool
  let reason: String
  let contextWindow: Int
  let model: String
}

/// Normalize a `SystemLanguageModel.UnavailableReason` to our wire string.
func reasonString(_ reason: SystemLanguageModel.Availability.UnavailableReason) -> String {
  switch reason {
  case .deviceNotEligible: return "deviceNotEligible"
  case .appleIntelligenceNotEnabled: return "appleIntelligenceNotEnabled"
  case .modelNotReady: return "modelNotReady"
  @unknown default: return "modelNotReady"
  }
}

/// Emit exactly one availability JSON line and never crash. Availability is a
/// pure property read, so this cannot throw — but we still keep it total so the
/// Node capability gate always gets a clean line + exit 0.
func runCheck() {
  let model = SystemLanguageModel.default
  var available = false
  var reason = "unsupportedOS"

  switch model.availability {
  case .available:
    available = true
    reason = "available"
  case .unavailable(let unavailableReason):
    available = false
    reason = reasonString(unavailableReason)
  }

  writeJSONLine(
    CheckOutput(
      available: available,
      reason: reason,
      // The on-device base model exposes a 4096-token shared context window.
      contextWindow: 4096,
      model: "apple-on-device"
    )
  )
}
