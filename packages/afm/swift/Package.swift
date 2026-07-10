// swift-tools-version:6.0
import PackageDescription

// pi-afm — a headless Swift CLI that bridges Apple's on-device Foundation
// Models framework to Node over stdio. arm64 + macOS 26 only (the framework
// never runs on Intel and requires Apple Intelligence). Built with SwiftPM
// (`swift build -c release`) because this box has CommandLineTools only — no
// full Xcode / xcodebuild. Language mode is pinned to v5 so the top-level
// async entry + FileHandle line writes don't trip Swift 6 strict-concurrency
// diagnostics; the FoundationModels calls are still fully async.
let package = Package(
  name: "pi-afm",
  platforms: [
    .macOS("26.0")
  ],
  targets: [
    .executableTarget(
      name: "pi-afm",
      path: "Sources/pi-afm",
      swiftSettings: [.swiftLanguageMode(.v5)]
    )
  ]
)
