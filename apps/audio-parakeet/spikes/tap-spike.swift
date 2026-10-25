// Meeting mode, Phase 0 spike (throwaway; see docs/MEETING-MODE.md).
// Answers: can a CLI helper tap another app's audio output with a Core Audio
// process tap (macOS 14.2+), what does denial look like, and how much of the
// speaker output leaks into the built-in mic (echo).
//
// Build: swiftc -O apps/audio-parakeet/spikes/tap-spike.swift -o apps/audio-parakeet/bin/tap-spike
//
//   tap-spike list
//       audio process objects: pid, bundle id, running in/out
//   tap-spike record --seconds N --out DIR
//         [--play FILE...]       spawn afplay on FILEs and tap that process
//         [--bundle PREFIX]      tap every process whose bundle id starts with PREFIX
//         [--global]             tap all system output (excluding this process)
//         [--mic] [--vp]         also record the mic; --vp = Apple voice processing (AEC)
//       writes DIR/system.wav (+ DIR/mic.wav), 16 kHz mono, and prints JSON stats
//   tap-spike analyze SYSTEM.wav MIC.wav
//       echo estimate: best lag, coupling gain, share of mic energy explained by system audio
import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox

func out(_ obj: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
}

func die(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

func check(_ status: OSStatus, _ what: String) {
    if status != noErr { die("\(what) failed: OSStatus \(status) (\(fourCC(status)))") }
}

func fourCC(_ s: OSStatus) -> String {
    let n = UInt32(bitPattern: s)
    let chars = [24, 16, 8, 0].map { Character(UnicodeScalar(UInt8((n >> UInt32($0)) & 0xff))) }
    return chars.allSatisfy { $0.isASCII && !$0.isWhitespace } ? String(chars) : "\(s)"
}

// MARK: Core Audio property helpers

func addr(_ sel: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func getArray<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _: T.Type) -> [T] {
    var a = addr(sel)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(obj, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
    let count = Int(size) / MemoryLayout<T>.stride
    let buf = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<T>.alignment)
    defer { buf.deallocate() }
    guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, buf) == noErr else { return [] }
    let typed = buf.bindMemory(to: T.self, capacity: count)
    return Array(UnsafeBufferPointer(start: typed, count: count))
}

func getValue<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ initial: T) -> T? {
    var a = addr(sel)
    var v = initial
    var size = UInt32(MemoryLayout<T>.size)
    let st = withUnsafeMutablePointer(to: &v) { AudioObjectGetPropertyData(obj, &a, 0, nil, &size, $0) }
    return st == noErr ? v : nil
}

func getString(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
    var a = addr(sel)
    var ref: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let st = withUnsafeMutablePointer(to: &ref) { AudioObjectGetPropertyData(obj, &a, 0, nil, &size, $0) }
    guard st == noErr, let r = ref else { return nil }
    return r.takeRetainedValue() as String
}

struct AudioProc {
    let object: AudioObjectID
    let pid: pid_t
    let bundle: String
    let runningOutput: Bool
    let runningInput: Bool
}

func audioProcesses() -> [AudioProc] {
    getArray(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList, AudioObjectID.self).map { o in
        AudioProc(
            object: o,
            pid: getValue(o, kAudioProcessPropertyPID, pid_t(0)) ?? 0,
            bundle: getString(o, kAudioProcessPropertyBundleID) ?? "",
            runningOutput: (getValue(o, kAudioProcessPropertyIsRunningOutput, UInt32(0)) ?? 0) != 0,
            runningInput: (getValue(o, kAudioProcessPropertyIsRunningInput, UInt32(0)) ?? 0) != 0
        )
    }
}

func processObject(pid: pid_t) -> AudioObjectID? {
    var a = addr(kAudioHardwarePropertyTranslatePIDToProcessObject)
    var p = pid
    var obj = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let st = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, UInt32(MemoryLayout<pid_t>.size), &p, &size, &obj)
    return st == noErr && obj != kAudioObjectUnknown ? obj : nil
}

func defaultOutputUID() -> String {
    guard let dev = getValue(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioDeviceID(0)),
          let uid = getString(dev, kAudioDevicePropertyDeviceUID) else { die("no default output device") }
    return uid
}

// MARK: 16 kHz mono accumulation

let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!

final class Sink: @unchecked Sendable {
    let q: DispatchQueue
    var samples: [Float] = []
    var converter: AVAudioConverter?
    var firstHostTime: UInt64 = 0
    init(_ label: String) { q = DispatchQueue(label: label) }

    func push(_ buffer: AVAudioPCMBuffer, hostTime: UInt64) {
        if firstHostTime == 0 { firstHostTime = hostTime }
        if converter == nil { converter = AVAudioConverter(from: buffer.format, to: target) }
        guard let converter else { return }
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate) + 64
        guard let o = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: cap) else { return }
        var fed = false
        var err: NSError?
        converter.convert(to: o, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        if err == nil, let ch = o.floatChannelData?[0] {
            samples.append(contentsOf: UnsafeBufferPointer(start: ch, count: Int(o.frameLength)))
        }
    }
}

func copyBuffer(_ src: AVAudioPCMBuffer) -> AVAudioPCMBuffer {
    let dst = AVAudioPCMBuffer(pcmFormat: src.format, frameCapacity: src.frameLength)!
    dst.frameLength = src.frameLength
    let n = Int(src.format.isInterleaved ? 1 : src.format.channelCount)
    let sabl = UnsafeMutableAudioBufferListPointer(src.mutableAudioBufferList)
    let dabl = UnsafeMutableAudioBufferListPointer(dst.mutableAudioBufferList)
    for i in 0..<n {
        memcpy(dabl[i].mData, sabl[i].mData, Int(sabl[i].mDataByteSize))
        dabl[i].mDataByteSize = sabl[i].mDataByteSize
    }
    return dst
}

func writeWav(_ samples: [Float], _ path: String) {
    let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
                                   AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false]
    guard let f = try? AVAudioFile(forWriting: URL(fileURLWithPath: path), settings: settings,
                                   commonFormat: .pcmFormatFloat32, interleaved: false) else { die("cannot write \(path)") }
    let b = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(max(samples.count, 1)))!
    b.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { _ = memcpy(b.floatChannelData![0], $0.baseAddress, samples.count * 4) }
    try? f.write(from: b)
}

func readWav(_ path: String) -> [Float] {
    guard let f = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else { die("cannot read \(path)") }
    let b = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.length))!
    try? f.read(into: b)
    return Array(UnsafeBufferPointer(start: b.floatChannelData![0], count: Int(b.frameLength)))
}

func rms(_ s: ArraySlice<Float>) -> Float {
    guard !s.isEmpty else { return 0 }
    var sum: Float = 0
    for x in s { sum += x * x }
    return (sum / Float(s.count)).squareRoot()
}

func db(_ x: Float) -> Double { x > 0 ? (20 * log10(Double(x)) * 10).rounded() / 10 : -999 }

func stats(_ s: [Float]) -> [String: Any] {
    let frame = 320 // 20 ms
    var voiced = 0, frames = 0
    var i = 0
    while i + frame <= s.count {
        if rms(s[i..<(i + frame)]) > 0.008 { voiced += 1 }
        frames += 1
        i += frame
    }
    let peak = s.map(abs).max() ?? 0
    return ["seconds": Double(s.count) / 16000, "rmsDb": db(rms(s[...])), "peakDb": db(peak),
            "voicedPct": frames > 0 ? Double(voiced * 100 / frames) : 0, "allZero": peak == 0]
}

// MARK: echo analysis

// Mic ≈ g · system(t - lag) + you + noise. Find lag by cross-correlation
// (0..400 ms), then least-squares g. "explainedPct" = how much of the mic's
// energy is the speaker output leaking back in.
func analyze(system: [Float], mic: [Float]) -> [String: Any] {
    let n = min(system.count, mic.count)
    guard n > 16000 else { return ["error": "need at least 1 s of both"] }
    let maxLag = 6400
    var best = 0
    var bestC: Double = -1
    // Decimate by 4 for the lag search, then refine at full rate.
    func corr(_ lag: Int, step: Int) -> Double {
        var c: Double = 0, ea: Double = 0, eb: Double = 0
        var i = lag
        while i < n {
            let a = Double(mic[i]), b = Double(system[i - lag])
            c += a * b; ea += a * a; eb += b * b
            i += step
        }
        return ea > 0 && eb > 0 ? c / (ea * eb).squareRoot() : 0
    }
    var lag = 0
    while lag <= maxLag {
        let c = corr(lag, step: 4)
        if c > bestC { bestC = c; best = lag }
        lag += 4
    }
    for l in max(0, best - 4)...min(maxLag, best + 4) {
        let c = corr(l, step: 1)
        if c >= bestC { bestC = c; best = l }
    }
    var ms: Double = 0, ss: Double = 0, mm: Double = 0
    for i in best..<n {
        let a = Double(mic[i]), b = Double(system[i - best])
        ms += a * b; ss += b * b; mm += a * a
    }
    let g = ss > 0 ? ms / ss : 0
    var res: Double = 0
    for i in best..<n {
        let e = Double(mic[i]) - g * Double(system[i - best])
        res += e * e
    }
    // Level view, robust to room reverb and mic DSP: mic level in 100 ms
    // frames where the speakers are playing vs where they are silent.
    let f = 1600
    var onMic: [Float] = [], offMic: [Float] = []
    var i = 0
    while i + f <= n {
        let s = rms(system[i..<(i + f)]), m = rms(mic[i..<(i + f)])
        if s > 0.02 { onMic.append(m) } else if s < 0.001 { offMic.append(m) }
        i += f
    }
    let med = { (a: [Float]) -> Float in a.isEmpty ? 0 : a.sorted()[a.count / 2] }
    return ["lagMs": Double(best) / 16, "correlation": (bestC * 1000).rounded() / 1000,
            "couplingDb": g > 0 ? (20 * log10(g) * 10).rounded() / 10 : -999,
            "explainedPct": mm > 0 ? ((1 - res / mm) * 1000).rounded() / 10 : 0,
            "micWhileSpeakersPlayingDb": db(med(onMic)), "micWhileSpeakersSilentDb": db(med(offMic)),
            "framesPlaying": onMic.count, "framesSilent": offMic.count]
}

// MARK: commands

let args = Array(CommandLine.arguments.dropFirst())
func opt(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
func opts(_ name: String) -> [String] {
    var r: [String] = []
    var i = 0
    while i < args.count {
        if args[i] == name, i + 1 < args.count { r.append(args[i + 1]); i += 2 } else { i += 1 }
    }
    return r
}

switch args.first {
case "list":
    out(["processes": audioProcesses().map {
        ["object": Int($0.object), "pid": Int($0.pid), "bundle": $0.bundle, "out": $0.runningOutput, "in": $0.runningInput]
    }])
    exit(0)
case "analyze":
    guard args.count >= 3 else { die("analyze SYSTEM.wav MIC.wav") }
    out(analyze(system: readWav(args[1]), mic: readWav(args[2])))
    exit(0)
case "record":
    break
default:
    die("usage: tap-spike list | record ... | analyze SYSTEM.wav MIC.wav")
}

let seconds = Double(opt("--seconds") ?? "10") ?? 10
guard let dir = opt("--out") else { die("record needs --out DIR") }
try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

// Who to tap.
var player: Process?
var tapDesc: CATapDescription
var targetNote = ""
let plays = opts("--play")
if !plays.isEmpty {
    // One afplay per file, back to back, through a shell so the pid stays fixed.
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["-c", "sleep 1; " + plays.map { "afplay '\($0)'" }.joined(separator: "; ")]
    try! p.run()
    player = p
    // afplay is a child of sh; find it once it opens audio.
    var obj: AudioObjectID?
    for _ in 0..<60 {
        Thread.sleep(forTimeInterval: 0.05)
        obj = audioProcesses().first { proc in
            var info = kinfo_proc()
            var size = MemoryLayout<kinfo_proc>.stride
            var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, proc.pid]
            sysctl(&mib, 4, &info, &size, nil, 0)
            return info.kp_eproc.e_ppid == p.processIdentifier
        }?.object
        if obj != nil { break }
    }
    guard let obj else { die("afplay never appeared as an audio process") }
    tapDesc = CATapDescription(stereoMixdownOfProcesses: [obj])
    targetNote = "afplay child of pid \(p.processIdentifier)"
} else if let prefix = opt("--bundle") {
    let procs = audioProcesses().filter { $0.bundle.hasPrefix(prefix) }
    guard !procs.isEmpty else { die("no audio process with bundle prefix \(prefix)") }
    tapDesc = CATapDescription(stereoMixdownOfProcesses: procs.map(\.object))
    targetNote = procs.map { "\($0.bundle)#\($0.pid)\($0.runningOutput ? "*" : "")" }.joined(separator: ", ")
} else if args.contains("--global") {
    let me = processObject(pid: getpid()).map { [$0] } ?? []
    tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: me)
    targetNote = "global"
} else {
    die("record needs --play FILE, --bundle PREFIX or --global")
}
tapDesc.name = "jarvis-meeting-spike"
tapDesc.isPrivate = true
tapDesc.muteBehavior = .unmuted

var tapID = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateProcessTap(tapDesc, &tapID), "AudioHardwareCreateProcessTap")

var tapFormat = AudioStreamBasicDescription()
var fsize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
var fa = addr(kAudioTapPropertyFormat)
check(AudioObjectGetPropertyData(tapID, &fa, 0, nil, &fsize, &tapFormat), "read tap format")
guard let tapAVFormat = AVAudioFormat(streamDescription: &tapFormat) else { die("unusable tap format") }

let outUID = defaultOutputUID()
let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey: "jarvis-meeting-spike",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceMainSubDeviceKey: outUID,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outUID]],
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tapDesc.uuid.uuidString]],
]
var aggID = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID), "AudioHardwareCreateAggregateDevice")

let system = Sink("spike.system")
var ioProc: AudioDeviceIOProcID?
check(AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggID, nil) { _, inData, inTime, _, _ in
    guard let b = AVAudioPCMBuffer(pcmFormat: tapAVFormat, bufferListNoCopy: inData, deallocator: nil) else { return }
    let copy = copyBuffer(b)
    let host = inTime.pointee.mHostTime
    system.q.async { system.push(copy, hostTime: host) }
}, "AudioDeviceCreateIOProcIDWithBlock")

// Optional mic, started first so both clocks begin together.
let mic = Sink("spike.mic")
let wantMic = args.contains("--mic")
let engine = AVAudioEngine()
if wantMic {
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        let s = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .audio) { _ in s.signal() }
        s.wait()
    }
    if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized { die("microphone denied") }
    let input = engine.inputNode
    if args.contains("--vp") {
        do { try input.setVoiceProcessingEnabled(true) } catch { die("voice processing failed: \(error)") }
        // Default VP ducks every other app's audio, which would gut the call.
        input.voiceProcessingOtherAudioDuckingConfiguration =
            AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
    }
    let fmt = input.outputFormat(forBus: 0)
    FileHandle.standardError.write("mic format: \(fmt)\n".data(using: .utf8)!)
    // Voice processing reports 9 deinterleaved channels; channel 0 is the
    // processed voice. Keep only channel 0 in every mode.
    let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: fmt.sampleRate, channels: 1, interleaved: false)!
    input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { buffer, when in
        guard let ch = buffer.floatChannelData?[0],
              let m = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength) else { return }
        m.frameLength = buffer.frameLength
        memcpy(m.floatChannelData![0], ch, Int(buffer.frameLength) * 4)
        mic.q.async { mic.push(m, hostTime: when.hostTime) }
    }
}

// Tap first: voice processing reconfigures the output device and starting it
// before the aggregate left the tap without IO callbacks.
check(AudioDeviceStart(aggID, ioProc), "AudioDeviceStart")
if wantMic {
    do { try engine.start() } catch { die("mic engine start failed: \(error)") }
}
Thread.sleep(forTimeInterval: seconds)
AudioDeviceStop(aggID, ioProc)
if wantMic { engine.stop() }
player?.terminate()

system.q.sync {}
mic.q.sync {}

// Align the two streams on host time so the echo lag is meaningful.
var sys = system.samples
var mc = mic.samples
if wantMic, system.firstHostTime > 0, mic.firstHostTime > 0 {
    var tb = mach_timebase_info_data_t()
    mach_timebase_info(&tb)
    let ns = { (h: UInt64) in Double(h) * Double(tb.numer) / Double(tb.denom) }
    let offset = Int(((ns(mic.firstHostTime) - ns(system.firstHostTime)) / 1e9 * 16000).rounded())
    if offset > 0 { mc = [Float](repeating: 0, count: offset) + mc } else if offset < 0 { sys = [Float](repeating: 0, count: -offset) + sys }
}

writeWav(sys, dir + "/system.wav")
var result: [String: Any] = ["target": targetNote, "tapFormat": "\(tapAVFormat)", "outputDevice": outUID, "system": stats(sys)]
if wantMic {
    writeWav(mc, dir + "/mic.wav")
    result["mic"] = stats(mc)
    result["voiceProcessing"] = args.contains("--vp")
    result["echo"] = analyze(system: sys, mic: mc)
}
AudioDeviceDestroyIOProcID(aggID, ioProc!)
AudioHardwareDestroyAggregateDevice(aggID)
AudioHardwareDestroyProcessTap(tapID)
out(result)
