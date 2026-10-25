// Meeting mode: two streams on one clock (docs/MEETING-MODE.md, Phase 1).
//
//   mic     default input device (AVAudioEngine), you
//   system  Core Audio process tap on the call app (or all output), them
//
// Both are resampled to 16 kHz mono, placed on a shared timeline by host time
// (an idle tap delivers no callbacks, so gaps are padded with silence), written
// to DIR/mic.wav and DIR/system.wav, and run through their own Listener (VAD,
// partials, commit). Every commit is a timestamped `segment` line with the
// levels main needs to judge speaker echo.
//
//   parakeet --meeting DIR [--app BUNDLE_PREFIX ...] [--no-mic]
//            [--engine parakeet|whisper --model GGML --language hi]   (whisper.swift)
//   parakeet --meeting DIR --replay-mic A.wav --replay-system B.wav   (no devices)
//
// Stops on a `stop` line or EOF on stdin, SIGTERM/SIGINT, or when the parent
// dies: in-flight speech is committed, WAVs are closed, `status stopped`.
//
// Permission: macOS asks the *responsible* process for system-audio capture.
// Spawned from a terminal that is the terminal, which usually lacks
// NSAudioCaptureUsageDescription, and the tap then delivers silent zeros with
// no error. So live meeting mode re-execs itself with responsibility
// disclaimed: TCC then judges this binary by its embedded Info.plist.
import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox
import FluidAudio

nonisolated(unsafe) var meetingPartialEvery = envNumber("JARVIS_MEETING_PARTIAL_MS", 1200) / 1000

// MARK: responsibility

typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32

// Parent side: spawn the real worker disclaimed, forward signals, mirror its exit.
func reexecDisclaimed() -> Never {
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else {
        fail("unavailable", "cannot disclaim responsibility on this macOS", code: 1)
    }
    let disclaim = unsafeBitCast(sym, to: DisclaimFn.self)
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    _ = disclaim(&attr, 1)
    setenv("JARVIS_PARAKEET_DISCLAIMED", "1", 1)
    let exe = Bundle.main.executablePath ?? CommandLine.arguments[0]
    var cargs = CommandLine.arguments.map { strdup($0) } + [nil]
    var pid: pid_t = 0
    let st = posix_spawn(&pid, exe, nil, &attr, &cargs, environ)
    if st != 0 { fail("unavailable", "meeting worker spawn failed: \(st)", code: 1) }
    childPid = pid
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig) { s in if childPid > 0 { kill(childPid, s) } }
    }
    var status: Int32 = 0
    while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
    exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 1)
}
nonisolated(unsafe) var childPid: pid_t = 0

// MARK: Core Audio helpers

func caAddr(_ sel: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func caValue<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ initial: T, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> T? {
    var a = caAddr(sel)
    a.mScope = scope
    var v = initial
    var size = UInt32(MemoryLayout<T>.size)
    let st = withUnsafeMutablePointer(to: &v) { AudioObjectGetPropertyData(obj, &a, 0, nil, &size, $0) }
    return st == noErr ? v : nil
}

func caString(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
    var a = caAddr(sel)
    var ref: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let st = withUnsafeMutablePointer(to: &ref) { AudioObjectGetPropertyData(obj, &a, 0, nil, &size, $0) }
    guard st == noErr, let r = ref else { return nil }
    return r.takeRetainedValue() as String
}

func caObjects(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> [AudioObjectID] {
    var a = caAddr(sel)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(obj, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.stride)
    guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

let systemObject = AudioObjectID(kAudioObjectSystemObject)

struct TapTarget: Equatable {
    let objects: [AudioObjectID]
    let note: String
}

// Every audio process whose bundle id starts with one of the prefixes. Call
// apps play from helpers (Teams: com.microsoft.teams2.helper, Chrome:
// com.google.Chrome.helper), so a prefix catches the whole family.
func processesMatching(_ prefixes: [String]) -> TapTarget {
    var objs: [AudioObjectID] = []
    var names: [String] = []
    for o in caObjects(systemObject, kAudioHardwarePropertyProcessObjectList) {
        let bundle = caString(o, kAudioProcessPropertyBundleID) ?? ""
        if prefixes.contains(where: { !bundle.isEmpty && bundle.hasPrefix($0) }) {
            objs.append(o)
            names.append(bundle)
        }
    }
    return TapTarget(objects: objs.sorted(), note: Set(names).sorted().joined(separator: ","))
}

func anyRunningOutput(_ objs: [AudioObjectID]) -> Bool {
    objs.contains { (caValue($0, kAudioProcessPropertyIsRunningOutput, UInt32(0)) ?? 0) != 0 }
}

// Where Jarvis's speakers point decides how likely the mic hears the call.
func outputRoute() -> (route: String, uid: String) {
    guard let dev = caValue(systemObject, kAudioHardwarePropertyDefaultSystemOutputDevice, AudioDeviceID(0)),
          let uid = caString(dev, kAudioDevicePropertyDeviceUID) else { return ("none", "") }
    let transport = caValue(dev, kAudioDevicePropertyTransportType, UInt32(0)) ?? 0
    switch transport {
    case kAudioDeviceTransportTypeBuiltIn:
        let source = caValue(dev, kAudioDevicePropertyDataSource, UInt32(0), scope: kAudioObjectPropertyScopeOutput) ?? 0
        return (source == 0x6864_706E /* 'hdpn' */ ? "headphones" : "speakers", uid)
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return ("bluetooth", uid)
    case kAudioDeviceTransportTypeUSB: return ("usb", uid)
    case kAudioDeviceTransportTypeHDMI, kAudioDeviceTransportTypeDisplayPort: return ("display", uid)
    default: return ("other", uid)
    }
}

// MARK: timeline track

let meetingFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false)!

// One stream: resample, place on the shared clock, write the WAV, keep 20 ms
// levels, feed the Listener. Everything runs on the meeting queue.
final class Track: @unchecked Sendable {
    let name: String
    let listener: Listener
    var file: AVAudioFile?
    var written = 0                  // samples on the timeline so far
    var levels: [Float] = []         // RMS per 20 ms frame, timeline-aligned
    private var pending: [Float] = []
    var peakSincePoll: Float = 0
    private var converter: AVAudioConverter?
    private var converterFrom: AVAudioFormat?

    init(name: String, listener: Listener, path: String) {
        self.name = name
        self.listener = listener
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: sampleRate,
                                       AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false]
        file = try? AVAudioFile(forWriting: URL(fileURLWithPath: path), settings: settings,
                                commonFormat: .pcmFormatFloat32, interleaved: false)
    }

    func resample(_ buffer: AVAudioPCMBuffer) -> [Float] {
        if converterFrom != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: meetingFormat)
            converterFrom = buffer.format
        }
        guard let converter else { return [] }
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * meetingFormat.sampleRate / buffer.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: meetingFormat, frameCapacity: cap) else { return [] }
        var fed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard err == nil, let ch = out.floatChannelData?[0] else { return [] }
        return Array(UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))
    }

    // at: timeline position in samples (nil = right after what is there).
    func place(_ samples: [Float], at: Int?) {
        if let at, at > written + sampleRate / 50 {
            append([Float](repeating: 0, count: at - written))
        }
        append(samples)
    }

    // Pad to `upTo` so a silent stream still advances (and its VAD can end utterances).
    func pad(upTo: Int) {
        if upTo > written + sampleRate / 10 {
            debug(["stream": name, "pad": Double(upTo - written) / Double(sampleRate), "at": Double(written) / Double(sampleRate)])
            append([Float](repeating: 0, count: upTo - written))
        }
    }

    private func append(_ s: [Float]) {
        guard !s.isEmpty else { return }
        written += s.count
        if let file, let b = AVAudioPCMBuffer(pcmFormat: meetingFormat, frameCapacity: AVAudioFrameCount(s.count)) {
            b.frameLength = AVAudioFrameCount(s.count)
            s.withUnsafeBufferPointer { _ = memcpy(b.floatChannelData![0], $0.baseAddress, s.count * 4) }
            try? file.write(from: b)
        }
        pending.append(contentsOf: s)
        let frame = sampleRate / 50
        var i = 0
        while i + frame <= pending.count {
            var sum: Float = 0
            for k in i..<(i + frame) {
                sum += pending[k] * pending[k]
                peakSincePoll = max(peakSincePoll, abs(pending[k]))
            }
            levels.append((sum / Float(frame)).squareRoot())
            i += frame
        }
        pending.removeFirst(i)
        listener.feed(s)
    }

    func close() { file = nil } // AVAudioFile finalises the header on release
}

func dbfs(_ x: Float) -> Double { x > 1e-6 ? (20 * log10(Double(x)) * 10).rounded() / 10 : -120 }

// Median level (dBFS) and voiced share of a track over [start, end) seconds.
func levelStats(_ t: Track, _ start: Double, _ end: Double) -> (db: Double, voiced: Double) {
    let a = max(0, Int(start * 50)), b = min(t.levels.count, Int(end * 50))
    guard b > a else { return (-120, 0) }
    let slice = t.levels[a..<b]
    let sorted = slice.sorted()
    let voiced = Double(slice.filter { $0 > floorRMS }.count) / Double(slice.count)
    return (dbfs(sorted[sorted.count / 2]), (voiced * 100).rounded() / 100)
}

// MARK: meeting

final class Meeting: @unchecked Sendable {
    let q = DispatchQueue(label: "jarvis.meeting")
    let dir: String
    var tracks: [String: Track] = [:]
    let startHost = mach_absolute_time()
    let timebase: mach_timebase_info_data_t = { var t = mach_timebase_info_data_t(); mach_timebase_info(&t); return t }()
    var stopping = false
    var asr: Transcriber?
    var tapID = AudioObjectID(kAudioObjectUnknown)
    var aggID = AudioObjectID(kAudioObjectUnknown)
    var ioProc: AudioDeviceIOProcID?
    var tapDesc: CATapDescription?
    var target = TapTarget(objects: [], note: "")
    var prefixes: [String] = []
    var zeroWhilePlaying = 0
    var deniedSent = false
    let engine = AVAudioEngine()
    var micOn = false
    var printer: VoicePrinter?       // voiceprints (voice.swift); nil until loaded, or if it fails
    var profiles: [VoiceProfile] = []
    var printerSettled = false       // loaded or given up: replay waits for this

    init(dir: String) { self.dir = dir }

    func position(host: UInt64) -> Int {
        guard host > startHost else { return 0 }
        let ns = Double(host - startHost) * Double(timebase.numer) / Double(timebase.denom)
        return Int(ns / 1e9 * Double(sampleRate))
    }
    var clockPosition: Int { position(host: mach_absolute_time()) }

    func addTrack(_ name: String, source: AudioSource) -> Track {
        let l = Listener(q: q, source: source, stream: name)
        let t = Track(name: name, listener: l, path: "\(dir)/\(name).wav")
        l.onCommit = { [unowned self] c in self.segment(t, c) }
        tracks[name] = t
        return t
    }

    func segment(_ t: Track, _ c: Committed) {
        var msg: [String: Any] = ["kind": "segment", "stream": t.name, "id": c.id, "text": c.text,
                                  "start": (c.start * 100).rounded() / 100, "end": (c.end * 100).rounded() / 100]
        for (name, other) in tracks {
            let s = levelStats(other, c.start, c.end)
            msg["\(name)Db"] = s.db
            msg["\(name)Voiced"] = s.voiced
        }
        guard let printer else { emit(msg); return }
        // Who said it: the voiceprint, and how close it is to each known voice.
        // Off the meeting queue (tens of ms on the ANE); lines may land a beat late.
        inFlightPrints += 1
        let profiles = self.profiles
        DispatchQueue.global(qos: .userInitiated).async {
            if let p = printer.embed(c.samples) {
                msg["voiced"] = (p.voiced * 10).rounded() / 10
                msg["print"] = p.vector.map { (Double($0) * 1e4).rounded() / 1e4 }
                msg["voices"] = profiles.map { ["id": $0.id, "score": (Double(cosine(p.vector, $0.mean)) * 100).rounded() / 100] }
            }
            self.q.async {
                emit(msg)
                self.inFlightPrints -= 1
            }
        }
    }
    var inFlightPrints = 0

    func setASR(_ a: Transcriber) {
        q.async {
            self.asr = a
            for t in self.tracks.values { t.listener.asr = a; t.listener.tick() }
        }
    }

    // MARK: system tap

    func startTap() throws {
        let desc: CATapDescription
        if prefixes.isEmpty {
            let me = caObjects(systemObject, kAudioHardwarePropertyProcessObjectList).filter {
                (caValue($0, kAudioProcessPropertyPID, pid_t(0)) ?? 0) == getpid()
            }
            desc = CATapDescription(stereoGlobalTapButExcludeProcesses: me)
            target = TapTarget(objects: [], note: "all system audio")
        } else {
            target = processesMatching(prefixes)
            desc = CATapDescription(stereoMixdownOfProcesses: target.objects)
        }
        desc.name = "jarvis-meeting"
        desc.isPrivate = true
        desc.muteBehavior = .unmuted
        tapDesc = desc
        try check(AudioHardwareCreateProcessTap(desc, &tapID), "create process tap")

        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var fa = caAddr(kAudioTapPropertyFormat)
        try check(AudioObjectGetPropertyData(tapID, &fa, 0, nil, &size, &asbd), "read tap format")
        guard let fmt = AVAudioFormat(streamDescription: &asbd) else { throw MeetingError("unusable tap format") }

        let outUID = outputRoute().uid
        let agg: [String: Any] = [
            kAudioAggregateDeviceNameKey: "jarvis-meeting",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]],
        ]
        try check(AudioHardwareCreateAggregateDevice(agg as CFDictionary, &aggID), "create aggregate device")
        let system = tracks["system"]!
        try check(AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggID, nil) { [unowned self] _, inData, inTime, _, _ in
            guard let b = AVAudioPCMBuffer(pcmFormat: fmt, bufferListNoCopy: inData, deallocator: nil) else { return }
            let copy = copyPCM(b)
            let pos = self.position(host: inTime.pointee.mHostTime)
            self.q.async { if !self.stopping { system.place(system.resample(copy), at: pos) } }
        }, "create IO proc")
        try check(AudioDeviceStart(aggID, ioProc), "start tap")
    }

    // New call helpers appear mid-meeting (a Teams call spawns one); retarget the tap.
    func refreshTap() {
        guard !prefixes.isEmpty, let desc = tapDesc else { return }
        let now = processesMatching(prefixes)
        guard now != target else { return }
        desc.processes = now.objects
        var ref = Unmanaged.passUnretained(desc)
        var a = caAddr(kAudioTapPropertyDescription)
        let st = AudioObjectSetPropertyData(tapID, &a, 0, nil, UInt32(MemoryLayout<Unmanaged<CATapDescription>>.size), &ref)
        target = now
        emit(["kind": "status", "state": "listening", "note": st == noErr ? "tapping \(now.note)" : "tap retarget failed (\(st))"])
    }

    func stopTap() {
        if let ioProc, aggID != kAudioObjectUnknown {
            AudioDeviceStop(aggID, ioProc)
            AudioDeviceDestroyIOProcID(aggID, ioProc)
        }
        if aggID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggID) }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        aggID = kAudioObjectUnknown
        tapID = kAudioObjectUnknown
    }

    // MARK: mic

    func startMic() throws {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: break
        case .notDetermined:
            let s = DispatchSemaphore(value: 0)
            AVCaptureDevice.requestAccess(for: .audio) { _ in s.signal() }
            s.wait()
            if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized { throw MeetingError("mic-denied") }
        default: throw MeetingError("mic-denied")
        }
        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        guard fmt.sampleRate > 0, fmt.channelCount > 0 else { throw MeetingError("no input device") }
        // Channel 0 only: multi-channel inputs (and voice processing's 9) would mix to garbage.
        let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: fmt.sampleRate, channels: 1, interleaved: false)!
        let mic = tracks["mic"]!
        input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { [unowned self] buffer, when in
            guard let ch = buffer.floatChannelData?[0],
                  let m = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength) else { return }
            m.frameLength = buffer.frameLength
            memcpy(m.floatChannelData![0], ch, Int(buffer.frameLength) * 4)
            let pos = self.position(host: when.hostTime)
            self.q.async { if !self.stopping { mic.place(mic.resample(m), at: pos) } }
        }
        try engine.start()
        micOn = true
    }

    // MARK: housekeeping (1 s, on q)

    func poll() {
        guard !stopping else { return }
        let clock = clockPosition
        for t in tracks.values { t.pad(upTo: clock - sampleRate / 2) } // half a second behind live, so real buffers win
        if let system = tracks["system"] {
            let playing = prefixes.isEmpty ? false : anyRunningOutput(target.objects)
            if playing && system.peakSincePoll == 0 { zeroWhilePlaying += 1 } else if system.peakSincePoll > 0 { zeroWhilePlaying = 0 }
            system.peakSincePoll = 0
            if zeroWhilePlaying >= 3 && !deniedSent {
                deniedSent = true
                emit(["kind": "status", "state": "system-audio-denied",
                      "note": "the call app is playing but the tap hears silence: allow System Audio Recording for parakeet in Settings"])
            }
        }
        refreshTap()
        if getppid() == 1 { stop(); return } // parent (Jarvis) went away
        q.asyncAfter(deadline: .now() + 1) { self.poll() }
    }

    func stop() {
        q.async {
            guard !self.stopping else { return }
            self.stopping = true
            self.stopTap()
            if self.micOn { self.engine.stop() }
            let group = DispatchGroup()
            for t in self.tracks.values {
                group.enter()
                t.listener.flush { group.leave() }
            }
            group.notify(queue: self.q) { self.finish() }
        }
    }

    // On q, once every utterance is out; waits for the last voiceprints.
    func finish() {
        if inFlightPrints > 0 { q.asyncAfter(deadline: .now() + 0.05) { self.finish() }; return }
        for t in tracks.values { t.close() }
        asr?.shutdown()
        let seconds = Double(tracks.values.map(\.written).max() ?? 0) / Double(sampleRate)
        emit(["kind": "status", "state": "stopped", "note": dir, "seconds": (seconds * 10).rounded() / 10])
        exit(0)
    }
}

struct MeetingError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}

func check(_ st: OSStatus, _ what: String) throws {
    if st != noErr { throw MeetingError("\(what) failed (OSStatus \(st))") }
}

func copyPCM(_ src: AVAudioPCMBuffer) -> AVAudioPCMBuffer {
    let dst = AVAudioPCMBuffer(pcmFormat: src.format, frameCapacity: src.frameLength)!
    dst.frameLength = src.frameLength
    let s = UnsafeMutableAudioBufferListPointer(src.mutableAudioBufferList)
    let d = UnsafeMutableAudioBufferListPointer(dst.mutableAudioBufferList)
    for i in 0..<min(s.count, d.count) {
        memcpy(d[i].mData, s[i].mData, Int(s[i].mDataByteSize))
        d[i].mDataByteSize = s[i].mDataByteSize
    }
    return dst
}

func argValues(_ name: String) -> [String] {
    var r: [String] = []
    var i = 0
    while i < args.count {
        if args[i] == name, i + 1 < args.count { r.append(args[i + 1]); i += 2 } else { i += 1 }
    }
    return r
}

func runMeeting() -> Never {
    guard let dir = argValues("--meeting").first else { fail("unavailable", "--meeting needs a directory", code: 1) }
    let replayMic = argValues("--replay-mic").first
    let replaySystem = argValues("--replay-system").first
    let replay = replayMic != nil || replaySystem != nil
    if !replay && ProcessInfo.processInfo.environment["JARVIS_PARAKEET_DISCLAIMED"] == nil { reexecDisclaimed() }

    do { try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true) }
    catch { fail("unavailable", "cannot create \(dir): \(error)", code: 1) }

    let m = Meeting(dir: dir)
    m.prefixes = argValues("--app")
    let wantMic = !args.contains("--no-mic")
    if wantMic || replayMic != nil { _ = m.addTrack("mic", source: .microphone) }
    _ = m.addTrack("system", source: .system)

    // Stop triggers: a `stop` line, signals, and (live only) stdin EOF, which
    // is how a dead Jarvis looks from here. Replay ends on its own.
    Thread.detachNewThread {
        while let line = readLine() {
            if line.trimmingCharacters(in: .whitespaces) == "stop" { m.stop(); return }
        }
        if !replay { m.stop() }
    }
    for sig in [SIGTERM, SIGINT, SIGHUP] { signal(sig, SIG_IGN) }
    var sources: [DispatchSourceSignal] = []
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        s.setEventHandler { m.stop() }
        s.resume()
        sources.append(s)
    }

    // Parakeet (English and European languages, fastest) or Whisper (Hindi
    // and Hinglish, whisper.swift). Only the chosen model is loaded.
    let engine = argValues("--engine").first ?? "parakeet"
    let model = argValues("--model").first ?? ""
    let language = argValues("--language").first ?? "hi"
    var note = engineNote
    if engine == "whisper" {
        if model.isEmpty || !FileManager.default.fileExists(atPath: model) { fail("unavailable", "whisper model not found: \(model)", code: 1) }
        if !whisperAvailable { fail("unavailable", "this parakeet was built without whisper.cpp", code: 1) }
        note = "whisper \((model as NSString).lastPathComponent) (\(language)) on Metal"
        meetingPartialEvery = whisperPartialEvery
    } else if engine != "parakeet" {
        fail("unavailable", "unknown engine \(engine)", code: 1)
    }
    // Voiceprints: known voices from --voices (Main's people.json). Without the
    // model the meeting still runs, just without voice matching.
    let known = argValues("--voices").first.map(loadProfiles) ?? []
    Task {
        let printer = try? await VoicePrinter.load()
        if printer == nil { emit(["kind": "status", "state": "listening", "note": "voiceprints unavailable"]) }
        m.q.async { m.printer = printer; m.profiles = known; m.printerSettled = true }
    }
    Task {
        do {
            if engine == "whisper" { m.setASR(try loadWhisper(model: model, language: language).0) }
            else { m.setASR(Transcriber(try await loadASR())) }
        } catch { fail("unavailable", "model load failed: \(error)", code: 1) }
    }

    if replay {
        // Both files through the live path in lockstep at 4x real time.
        let read = { (p: String?) -> [Float] in
            guard let p else { return [] }
            do { return try AudioConverter().resampleAudioFile(URL(fileURLWithPath: p)) }
            catch { fail("unavailable", "cannot read \(p): \(error)", code: 1) }
        }
        let a = read(replayMic), b = read(replaySystem)
        Task {
            while true {
                let ready = m.q.sync { m.asr != nil && m.printerSettled }
                if ready { break }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            emit(["kind": "status", "state": "listening", "note": note + " (meeting replay)", "route": "replay", "engine": engine])
            let total = max(a.count, b.count) + sampleRate * 3
            let chunk = sampleRate / 10
            var i = 0
            while i < total {
                let ma = i < a.count ? Array(a[i..<min(i + chunk, a.count)]) : [Float](repeating: 0, count: chunk)
                let mb = i < b.count ? Array(b[i..<min(i + chunk, b.count)]) : [Float](repeating: 0, count: chunk)
                m.q.async {
                    // Real chunk sizes: the mic engine hands over ~100 ms, the
                    // system tap ~10 ms (less than one VAD frame).
                    m.tracks["mic"]?.place(ma, at: nil)
                    for k in stride(from: 0, to: mb.count, by: sampleRate / 100) {
                        m.tracks["system"]?.place(Array(mb[k..<min(k + sampleRate / 100, mb.count)]), at: nil)
                    }
                }
                i += chunk
                try? await Task.sleep(nanoseconds: 25_000_000)
            }
            m.stop()
        }
        RunLoop.main.run()
        exit(0)
    }

    do {
        try m.startTap()
        if wantMic { try m.startMic() }
    } catch let e as MeetingError where e.description == "mic-denied" {
        fail("mic-denied", "grant Microphone to parakeet in Settings", code: 2)
    } catch {
        m.stopTap()
        fail("mic-error", "\(error)", code: 3)
    }
    let route = outputRoute().route
    emit(["kind": "status", "state": "listening", "note": "\(note), tapping \(m.target.note)", "route": route, "engine": engine])
    m.q.asyncAfter(deadline: .now() + 1) { m.poll() }
    withExtendedLifetime(sources) { RunLoop.main.run() }
    exit(0)
}
