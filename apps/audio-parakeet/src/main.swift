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
//   --meeting DIR: long-running two-stream capture (mic + system audio tap),
//                  timestamped segments, WAVs in DIR (see meeting.swift)
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

// PK_DEBUG=1: extra {"kind":"debug"} lines (Main ignores unknown kinds).
let debugOn = ProcessInfo.processInfo.environment["PK_DEBUG"] != nil
func debug(_ obj: [String: Any]) {
    if debugOn { emit(obj.merging(["kind": "debug"]) { a, _ in a }) }
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

// Parakeet rejects < 1 s of audio; pad short clips with silence. Near
// full-scale input (tapped call audio peaks at -0.1 dBFS) makes it return
// nothing or the wrong words for whole utterances, so hot clips are scaled to
// a -10 dBFS peak first; mic speech is quieter and passes untouched.
func padded(_ s: [Float]) -> [Float] {
    let peak = s.reduce(Float(0)) { max($0, abs($1)) }
    let x = peak > 0.316 ? s.map { $0 * (0.316 / peak) } : s
    return x.count >= sampleRate ? x : x + [Float](repeating: 0, count: sampleRate - x.count)
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

// One model, two streams: AsrManager keeps separate decoder state per
// source but is not safe to call concurrently, so calls queue up here.
// The same queue fronts Whisper (meeting mode, Hindi/Hinglish; whisper.swift).
final class Transcriber: @unchecked Sendable {
    private let run: ([Float], AudioSource) async -> String
    var shutdown: () -> Void = {}    // before exit: Whisper must release its Metal buffers
    private let lock = NSLock()
    private var tail: Task<Void, Never>?
    init(_ asr: AsrManager) {
        run = { samples, source in clean((try? await asr.transcribe(padded(samples), source: source))?.text ?? "") }
    }
    init(run: @escaping ([Float], AudioSource) async -> String) { self.run = run }

    func text(_ samples: [Float], _ source: AudioSource) async -> String {
        lock.lock()
        let prev = tail
        let job = Task { () -> String in
            _ = await prev?.value
            return await self.run(samples, source)
        }
        tail = Task { _ = await job.value }
        lock.unlock()
        return await job.value
    }
}

// What a committed utterance hands back in meeting mode (seconds since start).
struct Committed {
    let id: String
    let text: String
    let start: Double
    let end: Double
    let samples: [Float]             // the utterance itself, for its voiceprint
    var alt: String? = nil           // hybrid: the second engine's text (Whisper)
}

// All mutable state lives on one serial queue; the tap and model tasks hop onto it.
// One-shot (default): the first final is emitted and the process exits.
// Meeting (onCommit set): every utterance goes to onCommit and listening goes
// on; audio before the current utterance is trimmed so hours stay small.
final class Listener: @unchecked Sendable {
    let q: DispatchQueue
    let source: AudioSource
    let stream: String?              // "mic" | "system" in meeting mode, nil one-shot
    var onCommit: ((Committed) -> Void)?
    var id = UUID().uuidString
    var asr: Transcriber?
    var alt: Transcriber?            // hybrid meetings: Whisper on every finished line (not partials)
    var audio: [Float] = []          // 16 kHz mono since mic start (since `offset` when trimmed)
    var offset = 0                   // samples trimmed off the front of `audio`
    var vadAt = 0                    // stream sample index of the next frame the VAD has not seen
    var speechStart: Int? = nil      // index into `audio` where the utterance began (with pre-roll)
    var voiced: Double = 0           // seconds of voiced frames in this utterance
    var lastVoice: Double = 0        // seconds (stream time) of the last voiced frame
    var noise: Float = 0.004         // adaptive noise floor (RMS)
    var lastPartialAt: Double = 0
    var revision = 0
    var lastText = ""
    var busy = false
    var committing = false           // one-shot only: the final is on its way
    var inFlight = 0                 // meeting: utterances handed over, not transcribed yet

    init(q: DispatchQueue = DispatchQueue(label: "jarvis.parakeet"), source: AudioSource = .microphone, stream: String? = nil) {
        self.q = q
        self.source = source
        self.stream = stream
    }

    var now: Double { Double(offset + audio.count) / Double(sampleRate) }

    // Called on q with freshly converted samples.
    func feed(_ samples: [Float]) {
        let frame = sampleRate / 50 // 20 ms
        if onCommit != nil, speechStart == nil, audio.count > sampleRate * 2 {
            let drop = min(audio.count - sampleRate, vadAt - offset) // keep 1 s for pre-roll
            audio.removeFirst(drop)
            offset += drop
        }
        audio.append(contentsOf: samples)
        // Frames span chunk boundaries: a system tap hands over ~10 ms at a
        // time, less than one frame, so the VAD walks `audio`, not the chunk.
        while vadAt + frame <= offset + audio.count {
            let i = vadAt - offset
            var sum: Float = 0
            for k in i..<(i + frame) { sum += audio[k] * audio[k] }
            let rms = (sum / Float(frame)).squareRoot()
            let threshold = max(floorRMS, noise * 3)
            let t = Double(vadAt) / Double(sampleRate)
            if rms > threshold {
                if speechStart == nil {
                    speechStart = max(0, i - sampleRate * 3 / 10) // 300 ms pre-roll
                    voiced = 0
                }
                voiced += 0.02
                lastVoice = t
            } else {
                // Track the floor only on non-speech frames, quickly down, slowly up.
                noise = rms < noise ? noise * 0.9 + rms * 0.1 : noise * 0.995 + rms * 0.005
            }
            vadAt += frame
        }
        tick()
    }

    func tick() {
        guard let start = speechStart, !committing else { return }
        // A blip that never reached minSpeech and went quiet: forget it.
        if voiced < minSpeech && now - lastVoice > silenceCommit {
            debug(["stream": stream ?? "-", "blip": now])
            speechStart = nil
            return
        }
        guard voiced >= minSpeech else { return }
        let length = now - Double(offset + start) / Double(sampleRate)
        if now - lastVoice >= silenceCommit || length >= maxUtterance {
            commit()
        } else if now - lastPartialAt >= (stream == nil ? partialEvery : meetingPartialEvery) {
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
        let samples = clip()
        let source = self.source
        let id = self.id
        Task {
            let text = await asr.text(samples, source)
            self.q.async {
                self.busy = false
                // Meeting mode moves on to a new utterance (new id) without waiting.
                guard !self.committing, id == self.id, !text.isEmpty, text != self.lastText else { return }
                self.lastText = text
                self.revision += 1
                var msg: [String: Any] = ["kind": "partial", "id": self.id, "text": text, "revision": self.revision]
                if let s = self.stream { msg["stream"] = s }
                emit(msg)
            }
        }
    }

    // done fires on q once this utterance is settled (meeting stop waits on it).
    func commit(done: (() -> Void)? = nil) {
        guard let asr, let start = speechStart else { done?(); return } // models still loading: retried on the next tick
        debug(["stream": stream ?? "-", "commit": Double(offset + start) / Double(sampleRate), "end": now, "voiced": voiced])
        let samples = clip()
        let startSec = Double(offset + start) / Double(sampleRate)
        let endSec = min(now, lastVoice + 0.1) // not the trailing silence that ended it
        let source = self.source
        if let onCommit {
            // Meeting: hand the clip over and listen on at once. Whatever is
            // said while it is transcribed (Whisper's first pass takes over a
            // second) starts the next utterance instead of being dropped.
            let id = self.id
            self.id = UUID().uuidString
            speechStart = nil
            voiced = 0
            lastText = ""
            revision = 0
            inFlight += 1
            let alt = self.alt
            Task {
                let text = await asr.text(samples, source)
                let altText = await alt?.text(samples, source)
                self.q.async {
                    debug(["stream": self.stream ?? "-", "result": text])
                    self.inFlight -= 1
                    // Empty: noise, a cough, a door (in hybrid, only when both engines heard nothing).
                    if !text.isEmpty || !(altText ?? "").isEmpty {
                        var c = Committed(id: id, text: text, start: startSec, end: endSec, samples: samples)
                        c.alt = altText
                        onCommit(c)
                    }
                    done?()
                }
            }
            return
        }
        committing = true
        Task {
            let text = await asr.text(samples, source)
            self.q.async {
                let id = self.id
                debug(["stream": self.stream ?? "-", "result": text])
                self.committing = false
                self.speechStart = nil
                self.lastText = ""
                if text.isEmpty {
                    // Noise, a cough, a door: keep listening instead of committing nothing.
                    done?()
                    return
                }
                emit(["kind": "final", "id": id, "text": text])
                exit(0)
            }
        }
    }

    // Meeting stop: commit whatever is being said right now, then wait for
    // every utterance still being transcribed.
    func flush(done: @escaping () -> Void) {
        if speechStart != nil, voiced >= minSpeech { commit() }
        func settle() {
            if inFlight > 0 { q.asyncAfter(deadline: .now() + 0.1) { settle() } } else { done() }
        }
        settle()
    }
}

if args.contains("--meeting") { runMeeting() }
if let i = args.firstIndex(of: "--embed") { runEmbed(Array(args[(i + 1)...])) }
if args.contains("--enroll") { runEnroll() }
if args.contains("--diarize") { runDiarize() }
if args.contains("--watch-calls") { runWatchCalls() }

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
                listener.asr = Transcriber(asr)
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
            listener.asr = Transcriber(asr)
            emit(["kind": "status", "state": "listening", "note": engineNote])
            listener.tick()
        }
    } catch {
        fail("unavailable", "model load failed: \(error)", code: 1)
    }
}
RunLoop.main.run()
