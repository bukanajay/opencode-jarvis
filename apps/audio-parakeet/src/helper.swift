// parakeet helper (M5). Parakeet TDT 0.6B v3 through FluidAudio, ANE-offloaded.
// Same stdout protocol as speech-analyzer (see protocol.md): the deck cannot
// tell which engine heard it. Audio never leaves the box.
//
// Build on the M5: swift build -c release && cp .build/release/parakeet bin/parakeet
// First run downloads the CoreML model via AsrModels (Minutes, one time).
import Foundation
import AVFoundation
import FluidAudio

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

let args = CommandLine.arguments
if let simIdx = args.firstIndex(of: "--simulate"), simIdx + 1 < args.count {
    let sentence = args[simIdx + 1]
    let id = UUID().uuidString
    var acc: [String] = []
    var rev = 0
    for w in sentence.split(separator: " ").map(String.init) {
        acc.append(w)
        rev += 1
        emit(["kind": "partial", "id": id, "text": acc.joined(separator: " "), "revision": rev])
        Thread.sleep(forTimeInterval: 0.12)
    }
    emit(["kind": "final", "id": id, "text": sentence])
    exit(0)
}

if args.contains("--stdin") {
    let id = UUID().uuidString
    var rev = 0
    var current = ""
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty {
            emit(["kind": "final", "id": id, "text": current])
            exit(0)
        }
        current = line
        rev += 1
        emit(["kind": "partial", "id": id, "text": current, "revision": rev])
    }
    emit(["kind": "final", "id": id, "text": current])
    exit(0)
}

// Live mic path (M5 only).
switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized:
    break
case .notDetermined:
    let s = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { _ in s.signal() }
    s.wait()
    if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
        emit(["kind": "status", "state": "mic-denied", "note": "grant Microphone in Settings"])
        exit(2)
    }
default:
    emit(["kind": "status", "state": "mic-denied", "note": "grant Microphone in Settings"])
    exit(2)
}

let utteranceID = UUID().uuidString
var revision = 0
var committed = false
var lastText = ""
func commitFinal() {
    if (!committed) {
        committed = true
        emit(["kind": "final", "id": utteranceID, "text": lastText])
        exit(0)
    }
}

Task {
    do {
        let models = try await AsrModels.downloadAndLoad(version: .v3)
        let asr = AsrManager(config: .default)
        try await asr.initialize(models: models)
        emit(["kind": "status", "state": "listening", "note": "parakeet-tdt-0.6b-v3 on ANE"])

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        var ring: [Float] = []
        var lastVoice = Date()
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            guard let ch = buffer.floatChannelData?[0] else { return }
            let n = Int(buffer.frameLength)
            ring.append(contentsOf: UnsafeBufferPointer(start: ch, count: n).map { $0 })
            // M5 tuning notes (verify on first M5 run): resample the tap to 16 kHz mono
        // if the input format differs, and prefer FluidAudio VAD-gated windows
        // over the fixed 8s window + 1.2s silence commit below.
            if (ring.count >= 16000 * 8) {
                let window = Array(ring.suffix(16000 * 8))
                ring.removeAll()
                Task {
                    let result = try? await asr.transcribe(window)
                    if let text = result?.text, !text.isEmpty {
                        revision += 1
                        lastText = text
                        lastVoice = Date()
                        emit(["kind": "partial", "id": utteranceID, "text": text, "revision": revision])
                    }
                }
            }
            if (Date().timeIntervalSince(lastVoice) > 1.2 && revision > 0) {
                commitFinal()
            }
        }
        try engine.start()
        RunLoop.main.run()
    } catch {
        emit(["kind": "status", "state": "mic-error", "note": String(describing: error).prefix(160).description])
        exit(3)
    }
}
RunLoop.main.run()
