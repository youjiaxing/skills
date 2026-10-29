import AppKit
import Foundation
import Vision

struct Observation: Encodable {
    let text: String
    let confidence: Float
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
}

struct Result: Encodable {
    let observations: [Observation]
    let text: String
    let averageConfidence: Float
    let qrPayloads: [String]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count == 2 else { fail("usage: vision-ocr.swift <image-path>") }
let imagePath = CommandLine.arguments[1]
let input = imagePath == "--stdin" ? FileHandle.standardInput.readDataToEndOfFile() : try? Data(contentsOf: URL(fileURLWithPath: imagePath))
guard let input, let image = NSImage(data: input) else { fail("cannot read image") }
var proposedRect = CGRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
    fail("cannot decode image")
}

var requestError: Error?
var observations = [Observation]()
let request = VNRecognizeTextRequest { request, error in
    requestError = error
    guard let results = request.results as? [VNRecognizedTextObservation] else { return }
    observations = results.compactMap { item in
        guard let candidate = item.topCandidates(1).first else { return nil }
        let box = item.boundingBox
        return Observation(
            text: candidate.string,
            confidence: candidate.confidence,
            x: box.origin.x,
            y: box.origin.y,
            width: box.size.width,
            height: box.size.height
        )
    }
}
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true
let barcodeRequest = VNDetectBarcodesRequest()
barcodeRequest.symbologies = [.qr]

do {
    try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request, barcodeRequest])
} catch {
    fail(error.localizedDescription)
}
if let requestError { fail(requestError.localizedDescription) }

let text = observations.map(\.text).joined(separator: "\n")
let average = observations.isEmpty ? 0 : observations.map(\.confidence).reduce(0, +) / Float(observations.count)
let payloads = (barcodeRequest.results ?? []).compactMap(\.payloadStringValue)
let result = Result(observations: observations, text: text, averageConfidence: average, qrPayloads: payloads)
do {
    let data = try JSONEncoder().encode(result)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
} catch {
    fail(error.localizedDescription)
}
