// parakeet sim: protocol-identical stand-in. Pure Foundation, compiles anywhere
// (Intel included). The M5 binary is built from helper.swift and speaks the same
// lines, so the deck cannot tell them apart. See protocol.md.
import Foundation

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

emit(["kind": "status", "state": "unavailable", "note": "sim binary: live mic needs the M5 FluidAudio build (helper.swift)"])
exit(1)
