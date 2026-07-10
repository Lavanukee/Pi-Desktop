import Foundation

/// Unbuffered stdout: one compact JSON object per line (NDJSON). We go through
/// `FileHandle` (not `print`) so each line is flushed the moment it is produced
/// — Node reads the stream line-by-line and must see a response as soon as it is
/// ready, not when a libc buffer fills. `JSONSerialization` handles the
/// heterogeneous result shapes (snapshot vs check vs ack) without Codable
/// gymnastics, and leaves "/" unescaped so paths stay readable.
private let stdoutHandle = FileHandle.standardOutput
private let newline = Data([0x0A])

func emit(_ object: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(object),
    let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  else { return }
  stdoutHandle.write(data)
  stdoutHandle.write(newline)
}

/// A `{ id?, ok: true, result }` response line (serve loop). `id` is omitted for
/// one-shot subcommands that write a bare result object.
func emitResult(id: Int?, result: [String: Any]) {
  var obj: [String: Any] = ["ok": true, "result": result]
  if let id = id { obj["id"] = id }
  emit(obj)
}

/// A `{ id?, ok: false, error }` response line. Never throws across the boundary
/// — every failure becomes one of these so the Node side can degrade.
func emitError(id: Int?, message: String) {
  var obj: [String: Any] = ["ok": false, "error": message]
  if let id = id { obj["id"] = id }
  emit(obj)
}

func writeStderr(_ text: String) {
  FileHandle.standardError.write(Data(text.utf8))
}
