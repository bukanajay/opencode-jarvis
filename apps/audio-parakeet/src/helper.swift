// parakeet helper (Apple Silicon). Parakeet TDT 0.6B v3 through FluidAudio, ANE-offloaded.
// Same stdout protocol as speech-analyzer (see protocol.md): the deck cannot
// tell which engine heard it. Audio never leaves the box.
//
// Build: npm run build:parakeet (SwiftPM, or plain swiftc when SwiftPM is broken).
// First live run downloads the CoreML models (~600 MB, one time); run
// `bin/parakeet --prepare` ahead of time so the first utterance is not slow.
//
// Modes:
//   live (default): mic -> 16 kHz mono -> energy VAD -> rolling partials -> final on silence
//   --simulate "words...": progressive partials then final (no mic, no model)
//   --stdin: each line a partial, blank line commits the final (no mic, no model)
//   --file path: transcribe an audio file with the real model, emit one final
//   --prepare: download + compile the models, emit status ready, exit
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

func fail(_ state: String, _ note: String, code: Int32) -> Never {
    emit(["kind": "status", "state": state, "note": String(note.prefix(160))])
    exit(code)
}

func envNumber(_ key: String, _ fallback: Double) -> Double {
    if let v = ProcessInfo.processInfo.environment[key], let d = Double(v) { return d }
    return fallback
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

let sampleRate = 16000
let engineNote = "parakeet-tdt-0.6b-v3 on ANE"

func loadASR() async throws -> AsrManager {
    let models = try await AsrModels.downloadAndLoad(version: .v3)
    let asr = AsrManager(config: .default)
    try await asr.initialize(models: models)
    return asr
}

// Parakeet rejects < 1 s of audio; pad short clips with silence.
func padded(_ s: [Float]) -> [Float] {
    s.count >= sampleRate ? s : s + [Float](repeating: 0, count: sampleRate - s.count)
}

func clean(_ text: String) -> String {
    text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

if args.contains("--prepare") {
    Task {
        do {
            _ = try await loadASR()
            emit(["kind": "status", "state": "ready", "note": engineNote])
            exit(0)
        } catch {
            fail("unavailable", "model load failed: \(error)", code: 1)
        }
    }
    RunLoop.main.run()
}

if let fileIdx = args.firstIndex(of: "--file"), fileIdx + 1 < args.count {
    let url = URL(fileURLWithPath: args[fileIdx + 1])
    Task {
        do {
            let samples = try AudioConverter().resampleAudioFile(url)
            let asr = try await loadASR()
            let result = try await asr.transcribe(padded(samples), source: .system)
            emit(["kind": "final", "id": UUID().uuidString, "text": clean(result.text)])
            exit(0)
        } catch {
            fail("unavailable", "file transcription failed: \(error)", code: 1)
        }
    }
    RunLoop.main.run()
}

// Tunables (env, so they can be adjusted without a rebuild).
let silenceCommit = envNumber("JARVIS_PARAKEET_SILENCE_MS", 900) / 1000   // trailing silence that ends an utterance
let maxUtterance = envNumber("JARVIS_PARAKEET_MAX_S", 30)                 // hard cap, commits regardless
let partialEvery = envNumber("JARVIS_PARAKEET_PARTIAL_MS", 700) / 1000    // partial cadence while speaking
let minSpeech = envNumber("JARVIS_PARAKEET_MIN_SPEECH_MS", 250) / 1000    // voiced time before it counts as speech
let floorRMS = Float(envNumber("JARVIS_PARAKEET_MIN_RMS", 0.008))         // absolute speech threshold floor

// All mutable state lives on one serial queue; the tap and model tasks hop onto it.
final class Listener: @unchecked Sendable {
    let q = DispatchQueue(label: "jarvis.parakeet")
    let id = UUID().uuidString
    var asr: AsrManager?
    var audio: [Float] = []          // 16 kHz mono since mic start
    var speechStart: Int? = nil      // sample index where the utterance began (with pre-roll)
    var voiced: Double = 0           // seconds of voiced frames in this utterance
    var lastVoice: Double = 0        // seconds (stream time) of the last voiced frame
    var noise: Float = 0.004         // adaptive noise floor (RMS)
    var lastPartialAt: Double = 0
    var revision = 0
    var lastText = ""
    var busy = false
    var committing = false

    var now: Double { Double(audio.count) / Double(sampleRate) }

    // Called on q with freshly converted samples.
    func feed(_ samples: [Float]) {
        let frame = sampleRate / 50 // 20 ms
        var i = 0
        let base = audio.count
        audio.append(contentsOf: samples)
        while i + frame <= samples.count {
            var sum: Float = 0
            for k in i..<(i + frame) { sum += samples[k] * samples[k] }
            let rms = (sum / Float(frame)).squareRoot()
            let threshold = max(floorRMS, noise * 3)
            let t = Double(base + i) / Double(sampleRate)
            if rms > threshold {
                if speechStart == nil {
                    speechStart = max(0, base + i - sampleRate * 3 / 10) // 300 ms pre-roll
                    voiced = 0
                }
                voiced += 0.02
                lastVoice = t
            } else {
                // Track the floor only on non-speech frames, quickly down, slowly up.
                noise = rms < noise ? noise * 0.9 + rms * 0.1 : noise * 0.995 + rms * 0.005
            }
            i += frame
        }
        tick()
    }

    func tick() {
        guard let start = speechStart, !committing else { return }
        // A blip that never reached minSpeech and went quiet: forget it.
        if voiced < minSpeech && now - lastVoice > silenceCommit {
            speechStart = nil
            return
        }
        guard voiced >= minSpeech else { return }
        let length = now - Double(start) / Double(sampleRate)
        if now - lastVoice >= silenceCommit || length >= maxUtterance {
            commit()
        } else if now - lastPartialAt >= partialEvery {
            partial()
        }
    }

    func clip() -> [Float] {
        guard let start = speechStart else { return [] }
        return Array(audio[start..<audio.count])
    }

    func partial() {
        guard let asr, !busy else { return }
        busy = true
        lastPartialAt = now
        let samples = padded(clip())
        Task {
            let text = clean((try? await asr.transcribe(samples, source: .microphone))?.text ?? "")
            self.q.async {
                self.busy = false
                guard !self.committing, !text.isEmpty, text != self.lastText else { return }
                self.lastText = text
                self.revision += 1
                emit(["kind": "partial", "id": self.id, "text": text, "revision": self.revision])
            }
        }
    }

    func commit() {
        guard let asr else { return } // models still loading; retried on the next tick after load
        committing = true
        let samples = padded(clip())
        Task {
            let text = clean((try? await asr.transcribe(samples, source: .microphone))?.text ?? "")
            self.q.async {
                if text.isEmpty {
                    // Noise, a cough, a door: keep listening instead of committing nothing.
                    self.committing = false
                    self.speechStart = nil
                    self.lastText = ""
                    return
                }
                emit(["kind": "final", "id": self.id, "text": text])
                exit(0)
            }
        }
    }
}

let listener = Listener()

// Replay: stream a file through the exact live pipeline (VAD, partials,
// silence commit) at 2x real time, followed by silence. Proves the live logic
// without a microphone.
if let idx = args.firstIndex(of: "--replay"), idx + 1 < args.count {
    let samples: [Float]
    do { samples = try AudioConverter().resampleAudioFile(URL(fileURLWithPath: args[idx + 1])) }
    catch { fail("unavailable", "cannot read \(args[idx + 1]): \(error)", code: 1) }
    Task {
        do {
            let asr = try await loadASR()
            listener.q.async {
                listener.asr = asr
                emit(["kind": "status", "state": "listening", "note": engineNote + " (replay)"])
            }
            let chunk = sampleRate / 10
            let stream = [Float](repeating: 0, count: sampleRate / 2) + samples
                + [Float](repeating: 0, count: sampleRate * 3)
            var i = 0
            while i < stream.count {
                let piece = Array(stream[i..<min(i + chunk, stream.count)])
                listener.q.async { listener.feed(piece) }
                i += chunk
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            try await Task.sleep(nanoseconds: 2_000_000_000)
            fail("mic-error", "replay ended without a final", code: 3)
        } catch {
            fail("unavailable", "model load failed: \(error)", code: 1)
        }
    }
    RunLoop.main.run()
}

// Live mic path.
switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized:
    break
case .notDetermined:
    let s = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { _ in s.signal() }
    s.wait()
    if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
        fail("mic-denied", "grant Microphone in Settings", code: 2)
    }
default:
    fail("mic-denied", "grant Microphone in Settings", code: 2)
}

let engine = AVAudioEngine()
let input = engine.inputNode
let inFormat = input.outputFormat(forBus: 0)
guard inFormat.sampleRate > 0, inFormat.channelCount > 0 else {
    fail("mic-error", "no input device", code: 3)
}
let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false)!
guard let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
    fail("mic-error", "cannot convert \(inFormat.sampleRate) Hz input", code: 3)
}

// The mic opens before the model loads so nothing said during load is lost.
input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { buffer, _ in
    let ratio = outFormat.sampleRate / inFormat.sampleRate
    let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return }
    var fed = false
    var err: NSError?
    converter.convert(to: out, error: &err) { _, status in
        if fed { status.pointee = .noDataNow; return nil }
        fed = true
        status.pointee = .haveData
        return buffer
    }
    guard err == nil, let ch = out.floatChannelData?[0], out.frameLength > 0 else { return }
    let samples = Array(UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))
    listener.q.async { listener.feed(samples) }
}
do {
    try engine.start()
} catch {
    fail("mic-error", "engine start failed: \(error)", code: 3)
}

Task {
    do {
        let asr = try await loadASR()
        listener.q.async {
            listener.asr = asr
            emit(["kind": "status", "state": "listening", "note": engineNote])
            listener.tick()
        }
    } catch {
        fail("unavailable", "model load failed: \(error)", code: 1)
    }
}
RunLoop.main.run()
