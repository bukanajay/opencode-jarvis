//swift-tools-version: 6.0
import PackageDescription

// M5 build: swift build -c release, then copy .build/release/parakeet to bin/parakeet.
// Intel Macs cannot run this target (FluidAudio is Apple Silicon only);
// build the sim target instead (see README).
let package = Package(
    name: "parakeet",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio", from: "0.9.0"),
    ],
    targets: [
        .executableTarget(
            name: "parakeet",
            dependencies: ["FluidAudio"],
            path: "src"
        ),
    ]
)
