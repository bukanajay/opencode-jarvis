// jarvis-voice (Apple Silicon). Jarvis's one speaking voice: Kokoro-82M through
// FluidAudioTTS, on device. A single fixed voice for every turn; text in, WAV out.
// Audio never leaves the box.
//
// Build: npm run build:parakeet (builds both helpers). First run downloads the
// Kokoro CoreML models + the voice embedding (~350 MB, one time).
//
// Modes:
//   serve (default): one JSON request per stdin line {"id","text"}; replies on
//     stdout {"kind":"audio","id","path","ms"} or {"kind":"error","id","note"}.
//     Emits {"kind":"status","state":"ready","voice"} once the model is warm.
//   --say "text" --out file.wav: synthesize once and exit (samples, proofs).
//   --prepare: download + warm the model, emit status ready, exit.
// Options: --voice <kokoro id> (default bm_george), --speed <0.5..2> (default 1).
import Foundation
import FluidAudio
import FluidAudioTTS

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

let args = CommandLine.arguments
func opt(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

let voice = opt("--voice") ?? ProcessInfo.processInfo.environment["JARVIS_VOICE"] ?? "bm_george"
let speed = Float(opt("--speed") ?? ProcessInfo.processInfo.environment["JARVIS_VOICE_SPEED"] ?? "") ?? 1.0
let outDir = FileManager.default.temporaryDirectory.appendingPathComponent("jarvis-voice", isDirectory: true)
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

// Kokoro returns 24 kHz mono 16-bit WAV; duration from the data chunk size.
func durationMs(_ wav: Data) -> Int {
    max(0, (wav.count - 44)) * 1000 / (24_000 * 2)
}

func warm() async throws -> TtSManager {
    let tts = TtSManager(defaultVoice: voice)
    try await tts.initialize(preloadVoices: [voice])
    // First inference compiles the ANE graph; pay it now, not on the first reply.
    _ = try await tts.synthesize(text: "Ready.", voice: voice, voiceSpeed: speed)
    return tts
}

Task {
    let tts: TtSManager
    do {
        tts = try await warm()
    } catch {
        emit(["kind": "status", "state": "unavailable", "note": String("model load failed: \(error)".prefix(160))])
        exit(1)
    }

    if args.contains("--prepare") {
        emit(["kind": "status", "state": "ready", "voice": voice])
        exit(0)
    }

    if let text = opt("--say") {
        do {
            let wav = try await tts.synthesize(text: text, voice: voice, voiceSpeed: speed)
            let url = URL(fileURLWithPath: opt("--out") ?? outDir.appendingPathComponent("say.wav").path)
            try wav.write(to: url)
            emit(["kind": "audio", "id": "say", "path": url.path, "ms": durationMs(wav)])
            exit(0)
        } catch {
            emit(["kind": "error", "id": "say", "note": String("\(error)".prefix(160))])
            exit(1)
        }
    }

    emit(["kind": "status", "state": "ready", "voice": voice])
    // Requests are handled strictly in order: one voice, one line at a time.
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let text = req["text"] as? String else { continue }
        let id = req["id"] as? String ?? UUID().uuidString
        do {
            let wav = try await tts.synthesize(text: text, voice: voice, voiceSpeed: speed)
            let url = outDir.appendingPathComponent("\(id).wav")
            try wav.write(to: url)
            emit(["kind": "audio", "id": id, "path": url.path, "ms": durationMs(wav)])
        } catch {
            emit(["kind": "error", "id": id, "note": String("\(error)".prefix(160))])
        }
    }
    exit(0)
}
RunLoop.main.run()
