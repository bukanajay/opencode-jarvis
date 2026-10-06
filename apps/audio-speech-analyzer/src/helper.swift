// speech-analyzer helper (Intel Mac).
// Role: own the microphone, emit partial captions + finished utterance.
// Audio never goes to Go. Utterance contract matches Parakeet v3 helper on M5.
// Protocol (stdout, one JSON per line):
//   {"kind":"partial","id":"...","text":"...","revision":N}
//   {"kind":"final","id":"...","text":"..."}
//   {"kind":"status","state":"...","note":"..."}
//
// Modes:
//   live (default): mic -> SFSpeechRecognizer (on-device when supported)
//   --simulate "words...": progressive partials then final (no mic, for proving plumbing)
//   --stdin: read lines from stdin, emit each as partial, blank line commits final
import Foundation
import Speech
import AVFoundation

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
    let words = sentence.split(separator: " ").map(String.init)
    var acc: [String] = []
    var rev = 0
    for w in words {
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

// Live mic path.
let locale = Locale(identifier: "en-US")
guard let recognizer = SFSpeechRecognizer(locale: locale) else {
    emit(["kind": "status", "state": "unavailable", "note": "no recognizer for en-US"])
    exit(1)
}
if !recognizer.isAvailable {
    emit(["kind": "status", "state": "unavailable", "note": "recognizer not available"])
    exit(1)
}

let sema = DispatchSemaphore(value: 0)
var authDone = false
var speechOK = false
SFSpeechRecognizer.requestAuthorization { status in
    speechOK = (status == .authorized)
    authDone = true
    sema.signal()
}
sema.wait()
if !authDone || !speechOK {
    emit(["kind": "status", "state": "speech-denied", "note": "grant Speech Recognition in Settings"])
    exit(2)
}

switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized:
    break
case .notDetermined:
    let s2 = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { _ in s2.signal() }
    s2.wait()
    if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
        emit(["kind": "status", "state": "mic-denied", "note": "grant Microphone in Settings"])
        exit(2)
    }
default:
    emit(["kind": "status", "state": "mic-denied", "note": "grant Microphone in Settings"])
    exit(2)
}

let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
if recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
}
let utteranceID = UUID().uuidString
var revision = 0

var task: SFSpeechRecognitionTask?
task = recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
        revision += 1
        let text = result.bestTranscription.formattedString
        if result.isFinal {
            emit(["kind": "final", "id": utteranceID, "text": text])
            exit(0)
        } else {
            emit(["kind": "partial", "id": utteranceID, "text": text, "revision": revision])
        }
    }
    if error != nil {
        // Emit what we have as final so the turn is not lost.
        emit(["kind": "status", "state": "error", "note": "recognition error, stopping"])
        exit(3)
    }
}

let engine = AVAudioEngine()
let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    request.append(buffer)
}
do {
    try engine.start()
    emit(["kind": "status", "state": "listening", "note": "onDevice=\(recognizer.supportsOnDeviceRecognition)"])
    RunLoop.main.run()
} catch {
    emit(["kind": "status", "state": "mic-error", "note": "engine start failed"])
    exit(3)
}
