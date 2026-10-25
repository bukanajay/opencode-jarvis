// Who said what on the call side (docs/MEETING-MODE.md, Phase 3). After a
// meeting, the system stream holds everyone but you mixed together; this
// splits it into speakers.
//
//   parakeet --diarize DIR [--voices PATH]
//
// Reads DIR/system.wav, writes DIR/speakers/<id>.wav (each speaker's longest
// clean turn, for "who is this?" in Phase 4) and prints:
//   {"kind":"turns","turns":[{"speaker":"S1","start":3.2,"end":7.9},…]}
//   {"kind":"speaker","id":"S1","seconds":41.5,"turns":4,"print":[256],"voices":[{id,score}],"clip":"…"}
//   {"kind":"status","state":"diarized","note":"…","speakers":2}
//
// Built on the Phase 2 voiceprints (voice.swift), not FluidAudio's offline
// diarizer: on three clearly different voices taking turns, the diarizer put
// them all in one speaker, and even told there were three it mixed two of
// them, while these prints scored ≥0.79 within a voice and ≤0.23 across.
// It also keeps call-side speakers in the same space as people.json.
//
//   1. 1.5 s windows every 0.5 s over the speech; a print for each.
//   2. Consecutive windows that still sound alike form a turn.
//   3. Turns cluster by voice (average linkage, stop below dzSameVoice).
//   4. Clusters with only a couple of seconds join their nearest voice.
import AVFoundation
import Foundation
import FluidAudio

let dzWindow = 1.5, dzHop = 0.5             // seconds
let dzMinVoiced = 0.75                      // speech a window needs to be printed
let dzSameTurn: Float = 0.6                 // consecutive windows still the same voice
let dzSameVoice: Float = 0.5                // clusters merge at or above this
let dzMinSpeaker = 2.0                      // seconds; less folds into the nearest voice
let dzWeakSpeaker = 5.0                     // seconds; less joins its closest voice at dzWeakJoin
let dzWeakJoin: Float = 0.3
let maxPrintSeconds = 60.0                  // per speaker: plenty for a stable print
let minTurnForClip = 1.5                    // seconds

struct DzTurn {
    var start: Double
    var end: Double
    var sum: [Float]                        // speech-weighted sum of window prints
    var weight: Float
    var centroid: [Float] { l2normalize(sum) }
}

// Steps 1–2: printed windows, chained into turns.
func voiceTurns(_ samples: [Float], printer: VoicePrinter) -> [DzTurn] {
    let win = Int(dzWindow * Double(sampleRate)), hop = Int(dzHop * Double(sampleRate))
    var turns: [DzTurn] = []
    var prev: [Float]? = nil
    var lastEnd = -1.0
    var i = 0
    while i + win / 2 < samples.count {
        let a = i, b = min(samples.count, i + win)
        i += hop
        guard let p = printer.embed(Array(samples[a..<b]), minVoiced: dzMinVoiced) else { prev = nil; continue }
        let start = Double(a) / Double(sampleRate), end = Double(b) / Double(sampleRate)
        let w = Float(p.voiced)
        if let last = prev, cosine(last, p.vector) >= dzSameTurn, start <= lastEnd, var t = turns.popLast() {
            t.end = end
            for k in 0..<256 { t.sum[k] += p.vector[k] * w }
            t.weight += w
            turns.append(t)
        } else {
            turns.append(DzTurn(start: start, end: end, sum: p.vector.map { $0 * w }, weight: w))
        }
        prev = p.vector
        lastEnd = end
    }
    // Windows overlap, so a turn's tail runs into the next one's head: split the difference.
    for k in turns.indices.dropFirst() where turns[k].start < turns[k - 1].end {
        let mid = (turns[k].start + turns[k - 1].end) / 2
        turns[k - 1].end = mid
        turns[k].start = mid
    }
    return turns
}

// Steps 3–4: a cluster number per turn, numbered by first appearance.
// Only turns long enough for a clean print are clustered: a window spanning
// a change of speaker prints as a blend that matches nobody, and short blends
// would otherwise gather into a voice of their own. Short turns then join
// the voice they sound most like, or failing that their neighbour in time.
let dzClusterTurn = 2.0                     // seconds
func clusterTurns(_ turns: [DzTurn]) -> [Int] {
    guard !turns.isEmpty else { return [] }
    let long = turns.indices.filter { turns[$0].end - turns[$0].start >= dzClusterTurn }
    let core = long.isEmpty ? Array(turns.indices) : long
    var clusters: [[Int]] = core.map { [$0] }
    let c = turns.map(\.centroid)
    func link(_ x: [Int], _ y: [Int]) -> Float {      // average linkage, weighted by speech
        var s: Float = 0, w: Float = 0
        for a in x { for b in y { let ww = turns[a].weight * turns[b].weight; s += cosine(c[a], c[b]) * ww; w += ww } }
        return w > 0 ? s / w : 0
    }
    while clusters.count > 1 {
        var best: (Int, Int, Float) = (0, 0, -1)
        for x in 0..<clusters.count { for y in (x + 1)..<clusters.count {
            let l = link(clusters[x], clusters[y])
            if l > best.2 { best = (x, y, l) }
        } }
        guard best.2 >= dzSameVoice else { break }
        clusters[best.0] += clusters[best.1]
        clusters.remove(at: best.1)
    }
    // A voice with only a few seconds is weak evidence (a hesitant start of a
    // turn prints off): it joins its closest voice on less similarity than
    // two established voices would need. Different people never scored above
    // 0.23 against each other on the real call or the test voices.
    let seconds = { (cl: [Int]) in cl.reduce(0.0) { $0 + turns[$1].end - turns[$1].start } }
    while clusters.count > 1 {
        let small = clusters.indices.min { seconds(clusters[$0]) < seconds(clusters[$1]) }!
        let others = clusters.indices.filter { $0 != small }
        let target = others.max { link(clusters[small], clusters[$0]) < link(clusters[small], clusters[$1]) }!
        let s = seconds(clusters[small])
        guard s < dzMinSpeaker || (s < dzWeakSpeaker && link(clusters[small], clusters[target]) >= dzWeakJoin) else { break }
        clusters[target] += clusters[small]
        clusters.remove(at: small)
    }
    for t in turns.indices where !core.contains(t) {
        let sims = clusters.map { link([t], $0) }
        if let best = sims.indices.max(by: { sims[$0] < sims[$1] }), sims[best] >= dzSameVoice {
            clusters[best].append(t)
        } else {
            // Nearest clustered turn in time.
            let near = core.min { abs(turns[$0].start - turns[t].start) < abs(turns[$1].start - turns[t].start) }!
            clusters[clusters.firstIndex { $0.contains(near) }!].append(t)
        }
    }
    var label = [Int](repeating: 0, count: turns.count)
    for (n, cl) in clusters.sorted(by: { $0.min()! < $1.min()! }).enumerated() { for t in cl { label[t] = n + 1 } }
    return label
}

func runDiarize() -> Never {
    guard let dir = argValues("--diarize").first else { fail("unavailable", "--diarize needs a meeting directory", code: 1) }
    let known = argValues("--voices").first.map(loadProfiles) ?? []
    let wav = URL(fileURLWithPath: dir).appendingPathComponent("system.wav")
    Task {
        do {
            let samples = try AudioConverter().resampleAudioFile(wav)
            let t0 = Date()
            let printer = try await VoicePrinter.load()
            let vt = voiceTurns(samples, printer: printer)
            let label = clusterTurns(vt)
            // Adjacent turns of the same speaker read as one.
            var turns: [(speaker: String, start: Double, end: Double)] = []
            for (k, t) in vt.enumerated() {
                let id = "S\(label[k])"
                if let last = turns.last, last.speaker == id, t.start - last.end <= 1.0 { turns[turns.count - 1].end = t.end }
                else { turns.append((id, t.start, t.end)) }
            }
            emit(["kind": "turns", "turns": turns.map {
                ["speaker": $0.speaker, "start": ($0.start * 100).rounded() / 100, "end": ($0.end * 100).rounded() / 100]
            }])

            let clips = URL(fileURLWithPath: dir).appendingPathComponent("speakers")
            try FileManager.default.createDirectory(at: clips, withIntermediateDirectories: true)
            let slice = { (a: Double, b: Double) -> [Float] in
                let i = max(0, Int(a * Double(sampleRate))), j = min(samples.count, Int(b * Double(sampleRate)))
                return j > i ? Array(samples[i..<j]) : []
            }
            var ids: [String] = []
            for t in turns where !ids.contains(t.speaker) { ids.append(t.speaker) }
            for id in ids {
                let mine = turns.filter { $0.speaker == id }
                let total = mine.reduce(0) { $0 + $1.end - $1.start }
                // Longest turns first: they carry the cleanest voice.
                var audio: [Float] = []
                for t in mine.sorted(by: { $0.end - $0.start > $1.end - $1.start }) {
                    if Double(audio.count) / Double(sampleRate) >= maxPrintSeconds { break }
                    audio += slice(t.start, t.end)
                }
                var msg: [String: Any] = ["kind": "speaker", "id": id, "seconds": (total * 10).rounded() / 10, "turns": mine.count]
                if let p = printer.embed(audio) {
                    msg["print"] = p.vector.map { (Double($0) * 1e4).rounded() / 1e4 }
                    msg["voices"] = known.map { ["id": $0.id, "score": (Double(cosine(p.vector, $0.mean)) * 100).rounded() / 100] }
                }
                if let best = mine.max(by: { $0.end - $0.start < $1.end - $1.start }), best.end - best.start >= minTurnForClip {
                    let url = clips.appendingPathComponent("\(id).wav")
                    writeClip(slice(best.start, min(best.end, best.start + 8)), to: url)
                    msg["clip"] = url.path
                }
                emit(msg)
            }
            emit(["kind": "status", "state": "diarized", "speakers": ids.count,
                  "note": String(format: "%.1f s of call audio in %.1f s", Double(samples.count) / Double(sampleRate), Date().timeIntervalSince(t0))])
            exit(0)
        } catch {
            fail("unavailable", "diarization failed: \(error)", code: 1)
        }
    }
    RunLoop.main.run()
    exit(0)
}

func writeClip(_ s: [Float], to url: URL) {
    let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: sampleRate,
                                   AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false]
    guard !s.isEmpty,
          let f = try? AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false),
          let b = AVAudioPCMBuffer(pcmFormat: meetingFormat, frameCapacity: AVAudioFrameCount(s.count)) else { return }
    b.frameLength = AVAudioFrameCount(s.count)
    s.withUnsafeBufferPointer { _ = memcpy(b.floatChannelData![0], $0.baseAddress, s.count * 4) }
    try? f.write(from: b)
}
