// Run with:
// swiftc nucleo/Sources/Voice/RollingTranscript.swift nucleo/Tests/RollingTranscriptTests.swift -o /tmp/rolling-transcript-tests && /tmp/rolling-transcript-tests
import Foundation

@main
struct RollingTranscriptTests {
    static func main() {
        var turn = RollingTranscript()

        // Apple may revise a hypothesis before closing its first request.
        turn.partial("La prima parte è")
        turn.partial("La prima parte è stata corretta")
        turn.rollOver()
        assert(turn.text == "La prima parte è stata corretta")

        // A spoken turn can span multiple Apple recognition windows.
        turn.partial("poi continuo per oltre un minuto")
        assert(turn.text == "La prima parte è stata corretta poi continuo per oltre un minuto")
        turn.rollOver()
        turn.partial("e ancora per un terzo segmento")
        assert(turn.text == "La prima parte è stata corretta poi continuo per oltre un minuto e ancora per un terzo segmento")

        // A canceled or answered turn must not leak into the next one.
        turn.reset()
        assert(turn.isEmpty)
        turn.partial("Una domanda nuova")
        assert(turn.text == "Una domanda nuova")
        print("RollingTranscriptTests passed")
    }
}
