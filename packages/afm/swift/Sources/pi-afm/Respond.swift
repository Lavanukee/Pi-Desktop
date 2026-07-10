import Foundation
import FoundationModels

// --- wire types ------------------------------------------------------------

struct RequestMessage: Decodable {
  let role: String
  let content: String
}

struct RespondRequest: Decodable {
  let prompt: String
  let instructions: String?
  let messages: [RequestMessage]?
  let temperature: Double?
  let maxTokens: Int?
}

struct DeltaLine: Encodable {
  let type = "delta"
  let text: String
}

struct DoneUsage: Encodable {
  let inputTokens: Int?
  let outputTokens: Int?
}

struct DoneLine: Encodable {
  let type = "done"
  let usage: DoneUsage?
}

struct ErrorLine: Encodable {
  let type = "error"
  let message: String
  let recoverable: Bool
}

// --- error mapping ---------------------------------------------------------

/// Map a Foundation Models error to a human message + whether a retry (after
/// the caller trims history / rephrases) could plausibly succeed.
func classify(_ error: Error) -> (message: String, recoverable: Bool) {
  if let generation = error as? LanguageModelSession.GenerationError {
    switch generation {
    case .exceededContextWindowSize:
      return (
        "Context window exceeded (the on-device model shares a 4096-token budget "
          + "across instructions, history, and output). Trim the conversation and retry.",
        true
      )
    case .guardrailViolation:
      return (
        "The request was blocked by the on-device safety guardrails, which cannot "
          + "be disabled. Rephrase and try again.",
        false
      )
    default:
      return (generation.localizedDescription, false)
    }
  }
  return (error.localizedDescription, false)
}

// --- session assembly ------------------------------------------------------

/// Fold optional `instructions` + prior `messages` into a single instructions
/// string. The CLI is stateless per invocation, so any conversation history the
/// caller wants carried is rendered as a transcript preamble; `prompt` is the
/// live user turn passed to `streamResponse`.
func buildInstructions(_ request: RespondRequest) -> String {
  var text = request.instructions ?? ""
  if let messages = request.messages, !messages.isEmpty {
    let history = messages.map { "\($0.role): \($0.content)" }.joined(separator: "\n")
    if text.isEmpty {
      text = "Conversation so far:\n\(history)"
    } else {
      text += "\n\nConversation so far:\n\(history)"
    }
  }
  return text
}

// --- entry -----------------------------------------------------------------

/// Read one JSON request from stdin, stream NDJSON deltas to stdout, then a
/// terminal `done` (or an in-band `error` line). Process exit stays 0 for
/// model/guardrail/context errors — those are protocol-level, not crashes.
func runRespond() async {
  let inputData = FileHandle.standardInput.readDataToEndOfFile()

  let request: RespondRequest
  do {
    request = try JSONDecoder().decode(RespondRequest.self, from: inputData)
  } catch {
    writeJSONLine(
      ErrorLine(
        message: "Invalid request JSON: \(error.localizedDescription)",
        recoverable: false
      )
    )
    return
  }

  // Fail fast (and clearly) if the model can't serve this request.
  let model = SystemLanguageModel.default
  if case .unavailable(let unavailableReason) = model.availability {
    let reason = reasonString(unavailableReason)
    writeJSONLine(
      ErrorLine(
        message: "Apple on-device model is unavailable (\(reason)).",
        // Only "still downloading" is worth retrying automatically.
        recoverable: reason == "modelNotReady"
      )
    )
    return
  }

  let instructions = buildInstructions(request)
  let session: LanguageModelSession
  if instructions.isEmpty {
    session = LanguageModelSession()
  } else {
    session = LanguageModelSession(instructions: { instructions })
  }

  var options = GenerationOptions()
  if request.temperature != nil || request.maxTokens != nil {
    options = GenerationOptions(
      temperature: request.temperature,
      maximumResponseTokens: request.maxTokens
    )
  }

  do {
    let stream = session.streamResponse(to: request.prompt, options: options)
    // The stream yields CUMULATIVE snapshots of the full text so far, so we
    // diff against the previous snapshot to emit true token deltas.
    var previous = ""
    for try await snapshot in stream {
      let text = snapshot.content
      let delta: String
      if text.hasPrefix(previous) {
        delta = String(text.dropFirst(previous.count))
      } else {
        // Defensive: a non-monotonic snapshot (shouldn't happen) — emit whole.
        delta = text
      }
      previous = text
      if !delta.isEmpty {
        writeJSONLine(DeltaLine(text: delta))
      }
    }
    writeJSONLine(DoneLine(usage: nil))
  } catch {
    let result = classify(error)
    writeJSONLine(ErrorLine(message: result.message, recoverable: result.recoverable))
  }
}
