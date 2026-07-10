import Foundation

// pi-afm: a tiny argv dispatcher over the Foundation Models framework.
//
//   pi-afm --check     → one availability JSON line on stdout, exit 0.
//   pi-afm --respond   → read one JSON request on stdin, stream NDJSON deltas.
//
// Deliberately no arg-parsing dependency: two subcommands, positional only.
let arguments = Array(CommandLine.arguments.dropFirst())

switch arguments.first {
case "--check":
  runCheck()
case "--respond":
  await runRespond()
default:
  writeStderr("usage: pi-afm [--check | --respond]\n")
  exit(2)
}
