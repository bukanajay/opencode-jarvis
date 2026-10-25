// Voiceprints (docs/MEETING-MODE.md, Phase 2): who is talking, not what.
// WeSpeaker v2 via FluidAudio's diarizer models gives a 256-dim embedding of a
// clip; two clips of the same voice point the same way (cosine similarity).
//
//   parakeet --embed A.wav [B.wav ...]   one {"kind":"embedding"} line per file
//
// The extractor takes a 10 s window plus a per-frame speech mask (589 frames
// per 10 s, as the segmentation model emits). Shorter clips are repeat-padded
// by FluidAudio; longer ones are cut into 10 s windows and averaged. The mask
// comes from the same energy floor the VAD uses, so silence does not count.
import AVFoundation
import Accelerate
import Foundation
import FluidAudio

let voiceFrames = 589                       // segmentation frames per 10 s window
let voiceWindow = 10 * sampleRate           // samples per window
let minVoicedForPrint = 1.0                 // seconds of speech needed for a usable print

func l2normalize(_ v: [Float]) -> [Float] {
    var n: Float = 0
    vDSP_svesq(v, 1, &n, vDSP_Length(v.count))
    n = n.squareRoot()
    return n > 0 ? v.map { $0 / n } : v
}

func cosine(_ a: [Float], _ b: [Float]) -> Float {
    guard a.count == b.count, !a.isEmpty else { return 0 }
    var dot: Float = 0, na: Float = 0, nb: Float = 0
    vDSP_dotpr(a, 1, b, 1, &dot, vDSP_Length(a.count))
    vDSP_svesq(a, 1, &na, vDSP_Length(a.count))
    vDSP_svesq(b, 1, &nb, vDSP_Length(b.count))
    return na > 0 && nb > 0 ? dot / (na.squareRoot() * nb.squareRoot()) : 0
}

// The extractor is not safe to call concurrently: every call goes through q.
final class VoicePrinter: @unchecked Sendable {
    private let extractor: EmbeddingExtractor
    private let q = DispatchQueue(label: "jarvis.voiceprint")

    private init(_ e: EmbeddingExtractor) { extractor = e }

    static func load() async throws -> VoicePrinter {
        let models = try await DiarizerModels.downloadIfNeeded()
        return VoicePrinter(EmbeddingExtractor(embeddingModel: models.embeddingModel))
    }

    // (L2-normalised embedding, seconds of speech it was made from), nil when
    // the clip holds too little speech to say anything about the voice.
    func embed(_ samples: [Float]) -> (vector: [Float], voiced: Double)? {
        q.sync {
            var sum = [Float](repeating: 0, count: 256)
            var weight = 0.0
            var start = 0
            while start < samples.count {
                let win = Array(samples[start..<min(start + voiceWindow, samples.count)])
                start += voiceWindow
                let (mask, voiced) = speechMask(win)
                guard voiced >= 0.5,
                      let e = try? extractor.getEmbeddings(audio: win, masks: [mask], minActivityThreshold: 10).first,
                      e.contains(where: { $0 != 0 }) else { continue }
                let n = l2normalize(e)
                for i in 0..<256 { sum[i] += n[i] * Float(voiced) }
                weight += voiced
            }
            guard weight >= minVoicedForPrint else { return nil }
            return (l2normalize(sum), weight)
        }
    }

    // 1 for frames over the speech floor, 0 otherwise, laid out on the
    // segmentation frame grid; FluidAudio repeats it along with the audio.
    private func speechMask(_ s: [Float]) -> ([Float], Double) {
        var mask = [Float](repeating: 0, count: voiceFrames)
        let used = min(voiceFrames, (voiceFrames * s.count + voiceWindow / 2) / voiceWindow)
        var voiced = 0
        for f in 0..<used {
            let a = f * voiceWindow / voiceFrames, b = min(s.count, (f + 1) * voiceWindow / voiceFrames)
            guard b > a else { continue }
            var ms: Float = 0
            s[a..<b].withUnsafeBufferPointer { vDSP_measqv($0.baseAddress!, 1, &ms, vDSP_Length(b - a)) }
            if ms.squareRoot() > floorRMS { mask[f] = 1; voiced += 1 }
        }
        return (mask, Double(voiced) * 10 / Double(voiceFrames))
    }
}

func runEmbed(_ files: [String]) -> Never {
    Task {
        do {
            let vp = try await VoicePrinter.load()
            for f in files {
                guard let samples = try? AudioConverter().resampleAudioFile(URL(fileURLWithPath: f)) else {
                    emit(["kind": "embedding", "file": f, "error": "unreadable"])
                    continue
                }
                if let (v, voiced) = vp.embed(samples) {
                    emit(["kind": "embedding", "file": f, "seconds": Double(samples.count) / Double(sampleRate),
                          "voiced": (voiced * 10).rounded() / 10, "embedding": v.map { Double($0) }])
                } else {
                    emit(["kind": "embedding", "file": f, "error": "too little speech"])
                }
            }
            exit(0)
        } catch {
            fail("unavailable", "voiceprint model load failed: \(error)", code: 1)
        }
    }
    RunLoop.main.run()
    exit(0)
}

// MARK: known voices

// Main's people.json (apps/main/src/voices.js); only id and mean are needed here.
struct VoiceProfile {
    let id: String
    let mean: [Float]
}

func loadProfiles(_ path: String) -> [VoiceProfile] {
    guard let data = FileManager.default.contents(atPath: path),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let people = root["people"] as? [[String: Any]] else { return [] }
    return people.compactMap { p in
        guard let id = p["id"] as? String, let mean = p["mean"] as? [Double], mean.count == 256 else { return nil }
        return VoiceProfile(id: id, mean: l2normalize(mean.map { Float($0) }))
    }
}

// MARK: enrollment

// parakeet --enroll [--seconds 30] [--voices PATH] [--replay FILE] [--test]
//
// Records the mic while you read the prompts (the deck shows them), streams
// {"kind":"level"} ten times a second for a meter, and on stop (a `stop` line,
// EOF, or --seconds) prints one {"kind":"enrollment"} line: voiceprints of
// each 5 s window with enough speech, their mean, and how consistent they
// are. With --voices, also how close it is to the voice already enrolled as
// "me" (the deck's "test it"). Main decides whether to keep it.
let enrollWindow = 5 * sampleRate
let enrollMinVoiced = 10.0                  // seconds of speech for a profile worth keeping

// test: "is this me?" from a few seconds, not a profile worth keeping.
func enrollmentResult(_ audio: [Float], printer: VoicePrinter, known: [VoiceProfile], test: Bool = false) -> [String: Any] {
    let minVoiced = test ? 3.0 : enrollMinVoiced
    let minWindows = test ? 1 : 2
    var prints: [(vector: [Float], voiced: Double)] = []
    var start = 0
    while start + sampleRate * 2 <= audio.count {
        let w = Array(audio[start..<min(start + enrollWindow, audio.count)])
        start += enrollWindow
        if let p = printer.embed(w), p.voiced >= 2 { prints.append(p) }
    }
    let voiced = prints.reduce(0) { $0 + $1.voiced }
    let peak = audio.reduce(Float(0)) { max($0, abs($1)) }
    var out: [String: Any] = ["kind": "enrollment", "seconds": Double(audio.count) / Double(sampleRate),
                              "voiced": (voiced * 10).rounded() / 10, "windows": prints.count,
                              "peakDb": dbfs(peak)]
    guard voiced >= minVoiced, prints.count >= minWindows else {
        out["error"] = "too little speech: \(Int(voiced)) s heard, need \(Int(minVoiced)) s"
        return out
    }
    var sum = [Float](repeating: 0, count: 256)
    for p in prints { for i in 0..<256 { sum[i] += p.vector[i] * Float(p.voiced) } }
    let mean = l2normalize(sum)
    var pair: [Float] = []
    for i in 0..<prints.count { for j in (i + 1)..<prints.count { pair.append(cosine(prints[i].vector, prints[j].vector)) } }
    let r = { (x: Float) in (Double(x) * 100).rounded() / 100 }
    out["consistency"] = ["min": r(pair.min() ?? 1), "mean": r(pair.reduce(0, +) / Float(max(pair.count, 1)))]
    out["mean"] = mean.map { (Double($0) * 1e4).rounded() / 1e4 }
    out["embeddings"] = prints.map { $0.vector.map { (Double($0) * 1e4).rounded() / 1e4 } }
    if let me = known.first(where: { $0.id == "me" }) { out["meScore"] = r(cosine(mean, me.mean)) }
    return out
}

func runEnroll() -> Never {
    let replay = argValues("--replay").first
    if replay == nil && ProcessInfo.processInfo.environment["JARVIS_PARAKEET_DISCLAIMED"] == nil { reexecDisclaimed() }
    let limit = Double(argValues("--seconds").first ?? "30") ?? 30
    let known = argValues("--voices").first.map(loadProfiles) ?? []
    let q = DispatchQueue(label: "jarvis.enroll")
    var audio: [Float] = []
    var stopped = false

    func finish() {
        q.async {
            guard !stopped else { return }
            stopped = true
            let recorded = audio
            Task {
                do {
                    let printer = try await VoicePrinter.load()
                    emit(enrollmentResult(recorded, printer: printer, known: known, test: args.contains("--test")))
                    exit(0)
                } catch {
                    fail("unavailable", "voiceprint model load failed: \(error)", code: 1)
                }
            }
        }
    }

    if let replay {
        do { audio = try AudioConverter().resampleAudioFile(URL(fileURLWithPath: replay)) }
        catch { fail("unavailable", "cannot read \(replay): \(error)", code: 1) }
        finish()
        RunLoop.main.run()
    }

    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: break
    case .notDetermined:
        let s = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .audio) { _ in s.signal() }
        s.wait()
        if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized { fail("mic-denied", "grant Microphone to parakeet in Settings", code: 2) }
    default:
        fail("mic-denied", "grant Microphone to parakeet in Settings", code: 2)
    }
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let fmt = input.outputFormat(forBus: 0)
    guard fmt.sampleRate > 0, fmt.channelCount > 0 else { fail("mic-error", "no input device", code: 3) }
    let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: fmt.sampleRate, channels: 1, interleaved: false)!
    guard let converter = AVAudioConverter(from: mono, to: meetingFormat) else { fail("mic-error", "cannot convert input", code: 3) }
    var levelAcc: [Float] = []
    input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { buffer, _ in
        guard let ch = buffer.floatChannelData?[0],
              let m = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength),
              let out = AVAudioPCMBuffer(pcmFormat: meetingFormat, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * meetingFormat.sampleRate / fmt.sampleRate) + 64)
        else { return }
        m.frameLength = buffer.frameLength
        memcpy(m.floatChannelData![0], ch, Int(buffer.frameLength) * 4)
        var fed = false
        converter.convert(to: out, error: nil) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return m
        }
        guard let o = out.floatChannelData?[0] else { return }
        let samples = Array(UnsafeBufferPointer(start: o, count: Int(out.frameLength)))
        q.async {
            guard !stopped else { return }
            audio.append(contentsOf: samples)
            levelAcc.append(contentsOf: samples)
            if levelAcc.count >= sampleRate / 10 {
                var ms: Float = 0
                vDSP_measqv(levelAcc, 1, &ms, vDSP_Length(levelAcc.count))
                emit(["kind": "level", "db": dbfs(ms.squareRoot()), "seconds": (Double(audio.count) / Double(sampleRate) * 10).rounded() / 10])
                levelAcc.removeAll(keepingCapacity: true)
            }
            if Double(audio.count) / Double(sampleRate) >= limit { finish() }
        }
    }
    do { try engine.start() } catch { fail("mic-error", "engine start failed: \(error)", code: 3) }
    emit(["kind": "status", "state": "listening", "note": "enrolling, up to \(Int(limit)) s"])
    Thread.detachNewThread {
        while let line = readLine() { if line.trimmingCharacters(in: .whitespaces) == "stop" { break } }
        finish()
    }
    signal(SIGTERM, SIG_IGN)
    let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    term.setEventHandler { finish() }
    term.resume()
    withExtendedLifetime((engine, term)) { RunLoop.main.run() }
    exit(0)
}
