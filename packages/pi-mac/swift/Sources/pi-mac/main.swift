import Foundation

// pi-mac: a tiny argv dispatcher for Mac computer-use.
//
//   pi-mac --check                      → one TCC-status JSON line, exit 0.
//   pi-mac --snapshot [target] [--screenshot]
//                                       → one INDEXED AX-tree JSON line, exit 0.
//   pi-mac --act <json>                 → perform one raw act (x,y/type/key/
//                                          scroll), print an ack line, exit 0.
//   pi-mac --serve                      → persistent NDJSON request/response
//                                          loop on stdin/stdout. Keeps the
//                                          index→AXUIElement map alive across a
//                                          snapshot and the acts that follow, so
//                                          the bridge can act by [index]. This is
//                                          the mode Electron main drives.
//
// Deliberately no arg-parsing dependency: positional subcommands only.
let arguments = Array(CommandLine.arguments.dropFirst())

switch arguments.first {
case "--check":
  runCheckCommand()
case "--snapshot":
  runSnapshotCommand(Array(arguments.dropFirst()))
case "--act":
  runActCommand(Array(arguments.dropFirst()))
case "--serve":
  runServe()
default:
  writeStderr(
    "usage: pi-mac [--check | --snapshot [--frontmost|--pid N|--app NAME] [--screenshot]"
      + " | --act <json> | --serve]\n")
  exit(2)
}
