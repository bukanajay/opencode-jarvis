// Whisper engine for meeting mode (docs/MEETING-MODE.md): whisper.cpp with
// Metal, linked in by scripts/build-parakeet.sh when it could build it.
// Parakeet covers European languages only; the default model here is
// Oriserve's Whisper-Hindi2Hinglish-Apex (large-v3-turbo fine-tune, Apache
// 2.0), which writes Hindi as romanized Hinglish and keeps English as English.
//
//   parakeet --meeting DIR --engine whisper --model PATH [--language hi]
import Foundation
import FluidAudio
#if canImport(Whisper)
import Whisper
#endif

let whisperPartialEvery = envNumber("JARVIS_WHISPER_PARTIAL_MS", 2500) / 1000

#if canImport(Whisper)
let whisperAvailable = true

// One context; Transcriber already serialises calls, this queue keeps the
// blocking whisper_full off the cooperative thread pool.
final class WhisperEngine: @unchecked Sendable {
    private let ctx: OpaquePointer
    private let language: UnsafeMutablePointer<CChar>
    private let q = DispatchQueue(label: "jarvis.whisper")
    let note: String

    init(model: String, language lang: String) throws {
        whisper_log_set({ _, _, _ in }, nil) // its model-load chatter would land on our stdout protocol
        var cp = whisper_context_default_params()
        cp.use_gpu = true
        cp.flash_attn = true
        guard let c = whisper_init_from_file_with_params(model, cp) else {
            throw MeetingError("cannot load whisper model \(model)")
        }
        ctx = c
        language = strdup(lang)
        note = "whisper \((model as NSString).lastPathComponent) (\(lang)) on Metal"
    }

    func text(_ samples: [Float]) async -> String {
        await withCheckedContinuation { (k: CheckedContinuation<String, Never>) in
            q.async {
                var p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
                p.n_threads = Int32(max(2, min(8, ProcessInfo.processInfo.activeProcessorCount / 2)))
                p.language = UnsafePointer(self.language)
                p.translate = false
                p.no_context = true      // each utterance stands alone, no drift from the last one
                p.no_timestamps = true
                p.single_segment = false
                p.print_progress = false
                p.print_realtime = false
                p.print_special = false
                p.print_timestamps = false
                p.suppress_blank = true
                p.suppress_nst = true    // no "[Music]" / "(applause)" style tokens
                let x = padded(samples)
                let rc = x.withUnsafeBufferPointer { whisper_full(self.ctx, p, $0.baseAddress, Int32(x.count)) }
                guard rc == 0 else { k.resume(returning: ""); return }
                // Noise that got past the VAD comes back as "nan" or filler
                // with a high no-speech probability: drop those segments.
                var out = ""
                for i in 0..<whisper_full_n_segments(self.ctx) {
                    if whisper_full_get_segment_no_speech_prob(self.ctx, i) > 0.6 { continue }
                    guard let t = whisper_full_get_segment_text(self.ctx, i) else { continue }
                    let s = String(cString: t)
                    if s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "nan" { continue }
                    out += s
                }
                k.resume(returning: clean(out))
            }
        }
    }

    // ggml-metal asserts at exit() while a context still holds buffers.
    func close() { q.sync { whisper_free(ctx) } }
}

func loadWhisper(model: String, language: String) throws -> (Transcriber, String) {
    let w = try WhisperEngine(model: model, language: language)
    let t = Transcriber(run: { samples, _ in await w.text(samples) })
    t.shutdown = { w.close() }
    return (t, w.note)
}
#else
let whisperAvailable = false
func loadWhisper(model: String, language: String) throws -> (Transcriber, String) {
    throw MeetingError("this parakeet was built without whisper.cpp (npm run build:parakeet needs cmake)")
}
#endif
