import Foundation

/// Unbuffered stdout writer: one compact JSON object per line (NDJSON). We go
/// through `FileHandle` rather than `print` so every line is flushed the moment
/// it is produced — Node reads the stream line-by-line and must see deltas as
/// they arrive, not when a libc buffer happens to fill.
private let stdoutHandle = FileHandle.standardOutput
private let newline = Data([0x0A])

func writeJSONLine<T: Encodable>(_ value: T) {
  let encoder = JSONEncoder()
  // Keep "/" un-escaped so paths/URLs in messages stay readable; the output is
  // still valid JSON either way.
  encoder.outputFormatting = [.withoutEscapingSlashes]
  guard let data = try? encoder.encode(value) else { return }
  stdoutHandle.write(data)
  stdoutHandle.write(newline)
}

func writeStderr(_ text: String) {
  FileHandle.standardError.write(Data(text.utf8))
}
