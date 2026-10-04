// The recognizer's request lasts less than a long spoken turn. Keep its successive
// hypotheses as one utterance until the listener actually ends the turn.
import Foundation

struct RollingTranscript {
    private(set) var completed = ""
    private(set) var current = ""

    var text: String { Self.join(completed, current) }
    var isEmpty: Bool { text.isEmpty }

    mutating func partial(_ value: String) {
        current = value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    mutating func rollOver() {
        completed = Self.join(completed, current)
        current = ""
    }

    mutating func reset() {
        completed = ""
        current = ""
    }

    private static func join(_ first: String, _ second: String) -> String {
        guard !first.isEmpty else { return second }
        guard !second.isEmpty else { return first }
        return first + " " + second
    }
}
