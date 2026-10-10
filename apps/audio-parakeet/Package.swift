//swift-tools-version: 6.0
import PackageDescription

// Apple Silicon build: npm run build:parakeet (wraps swift build -c release and
// falls back to plain swiftc when SwiftPM is unusable). Intel Macs cannot run
// this target (FluidAudio is Apple Silicon only); they use the sim (see README).
let package = Package(
    name: "parakeet",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio", exact: "0.9.1"),
    ],
    targets: [
        .executableTarget(
            name: "parakeet",
            dependencies: ["FluidAudio"],
            path: "src",
            exclude: ["sim.swift"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
