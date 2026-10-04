import Foundation
import XCTest
@testable import Bottega

/// No network or audio device: server frames and suspended sends are controlled by each test.
@MainActor
final class VoceTelefonoTests: XCTestCase {
    private func attendi(_ condizione: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<500 {
            if condizione() { return }
            try await Task.sleep(for: .milliseconds(2))
        }
        XCTFail("Il protocollo non ha raggiunto lo stato atteso", file: file, line: line)
        throw ErroreProva.scadenza
    }

    private func assesta() async throws { try await Task.sleep(for: .milliseconds(15)) }

    private func nuova(_ socket: SocketVoceFinto, timeout: Duration = .seconds(2),
                       audio: @escaping (Data) -> Void = { _ in }) -> VoceTelefono {
        VoceTelefono(key: "chiave-finta", voiceID: "voce-finta", creaSocket: { _ in socket },
                     timeoutFinale: timeout, audio: audio)
    }

    private func successo(_ fine: FineVoce) async throws {
        try await attendi { fine.risultato != nil }
        try XCTUnwrap(fine.risultato).get()
    }

    func testPrimaFraseFinitaNonChiudeIlRaccontoDiPiuFrasi() async throws {
        let socket = SocketVoceFinto()
        var pcm = Data()
        let voce = nuova(socket) { pcm.append($0) }
        defer { voce.ferma() }
        try await voce.apri()
        try await voce.invia("Prima frase completa.")
        try socket.inietta(["audio": Data([1, 2]).base64EncodedString(), "is_final_audio_for_turn": true])
        try await attendi { socket.ricezioni >= 2 }
        try await voce.invia("Seconda frase completa.")
        let fine = FineVoce(voce)
        try await attendi { socket.chiusureRichieste == 1 }
        try await assesta()
        XCTAssertNil(fine.risultato, "Un marker precedente non conclude l'intera risposta")
        XCTAssertFalse(socket.cancellato)
        try socket.inietta(["audio": Data([3, 4]).base64EncodedString()])
        try socket.inietta(["is_final": true])
        try await successo(fine)
        XCTAssertEqual(pcm, Data([1, 2, 3, 4]))
        XCTAssertTrue(socket.cancellato)
    }

    func testMarkerDiTurnoDopoCloseNonScartaLAudioSuccessivo() async throws {
        let socket = SocketVoceFinto()
        var pcm = Data()
        let voce = nuova(socket) { pcm.append($0) }
        defer { voce.ferma() }
        try await voce.apri()
        try await voce.invia("Prima frase.")
        try await voce.invia("Seconda frase.")
        let fine = FineVoce(voce)
        try await attendi { socket.chiusureRichieste == 1 }
        try socket.inietta(["audio": Data([10, 11]).base64EncodedString(), "is_final_audio_for_turn": true])
        try await assesta()
        XCTAssertNil(fine.risultato)
        XCTAssertFalse(socket.cancellato)
        // PCM in the same frame as the global final marker must also be delivered.
        try socket.inietta(["audio": Data([12, 13]).base64EncodedString(), "is_final": true])
        try await successo(fine)
        XCTAssertEqual(pcm, Data([10, 11, 12, 13]))
    }

    func testFinaleRicevutoMentreInvioCloseESospeso() async throws {
        let socket = SocketVoceFinto()
        let cancello = CancelloVoce()
        socket.duranteChiusura = { await cancello.attendi() }
        let voce = nuova(socket)
        defer { voce.ferma() }
        try await voce.apri()
        try await voce.invia("Testo da leggere.")
        let fine = FineVoce(voce)
        try await attendi { socket.chiusureRichieste == 1 }
        try socket.inietta(["is_final": true])
        try await assesta()
        XCTAssertNil(fine.risultato, "Il send è ancora sospeso")
        await cancello.apri()
        try await successo(fine)
    }

    func testErroreRicevutoDuranteInvioCloseNonAspettaUnaContinuationAssente() async throws {
        let socket = SocketVoceFinto()
        let cancello = CancelloVoce()
        socket.duranteChiusura = { await cancello.attendi() }
        let voce = nuova(socket, timeout: .seconds(5))
        defer { voce.ferma() }
        try await voce.apri()
        try await voce.invia("Testo da leggere.")
        let fine = FineVoce(voce)
        try await attendi { socket.chiusureRichieste == 1 }
        try socket.inietta(["error": "errore-finto", "message": "Sintesi rifiutata per prova"])
        try await assesta()
        await cancello.apri()
        try await attendi { fine.risultato != nil }
        guard case .failure(let error) = fine.risultato else { return XCTFail("Atteso errore del servizio") }
        XCTAssertTrue(error.localizedDescription.contains("Sintesi rifiutata"))
    }

    func testCancellazioneDuranteAttesaFinaleChiudeIlSocket() async throws {
        let socket = SocketVoceFinto()
        let voce = nuova(socket)
        defer { voce.ferma() }
        try await voce.apri()
        try await voce.invia("Testo da leggere.")
        let fine = FineVoce(voce)
        try await attendi { socket.chiusureRichieste == 1 }
        fine.compito?.cancel()
        try await attendi { fine.risultato != nil }
        guard case .failure(let error) = fine.risultato else { return XCTFail("Attesa cancellazione") }
        XCTAssertTrue(error is CancellationError)
        XCTAssertTrue(socket.cancellato)
    }

    func testSilenzioSenzaFinaleScadeESganciaIlSocket() async throws {
        let socket = SocketVoceFinto()
        let voce = nuova(socket, timeout: .milliseconds(50))
        defer { voce.ferma() }
        try await voce.apri()
        try await voce.invia("Testo da leggere.")
        let fine = FineVoce(voce)
        try await attendi { fine.risultato != nil }
        guard case .failure(let error) = fine.risultato else { return XCTFail("Atteso timeout") }
        XCTAssertFalse(error is CancellationError)
        XCTAssertTrue(error.localizedDescription.localizedCaseInsensitiveContains("prima di completare"))
        XCTAssertTrue(socket.cancellato)
    }

    func testErroreDiReteDuranteReceiveNonDiventaSuccessoParziale() async throws {
        let socket = SocketVoceFinto()
        let voce = nuova(socket, timeout: .seconds(5))
        defer { voce.ferma() }
        try await voce.apri()
        try await voce.invia("Prima frase ricevuta, resto interrotto dalla rete.")
        try socket.inietta(["audio": Data([1, 2]).base64EncodedString()])
        let fine = FineVoce(voce)
        try await attendi { socket.chiusureRichieste == 1 }
        socket.fallisciRicezione(URLError(.networkConnectionLost))
        try await attendi { fine.risultato != nil }
        guard case .failure(let error) = fine.risultato else { return XCTFail("Atteso errore di rete") }
        XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost)
        XCTAssertTrue(socket.cancellato)
    }

    func testFinalePrimaDellaChiusuraRichiestaSegnalaRaccontoInterrotto() async throws {
        let socket = SocketVoceFinto()
        let voce = nuova(socket)
        defer { voce.ferma() }
        try await voce.apri()
        try await voce.invia("Il testo non è ancora finito.")
        try socket.inietta(["audio": Data([1, 2]).base64EncodedString(), "is_final": true])
        try await assesta()
        let fine = FineVoce(voce)
        try await attendi { fine.risultato != nil }
        guard case .failure(let error) = fine.risultato else { return XCTFail("Attesa chiusura prematura") }
        XCTAssertTrue(error.localizedDescription.contains("prima della fine del testo"))
        XCTAssertEqual(socket.chiusureRichieste, 0)
        XCTAssertTrue(socket.cancellato)
    }

    func testPCMCheContinuaAdArrivareRinnovaLaScadenzaFinale() async throws {
        let socket = SocketVoceFinto()
        var pcm = Data()
        let voce = nuova(socket, timeout: .milliseconds(200)) { pcm.append($0) }
        defer { voce.ferma() }
        try await voce.apri()
        try await voce.invia("Un racconto lungo continua a produrre audio.")
        let fine = FineVoce(voce)
        try await attendi { socket.chiusureRichieste == 1 }
        for i in 0..<6 {
            try await Task.sleep(for: .milliseconds(60))
            try socket.inietta(["audio": Data([UInt8(i), 0]).base64EncodedString()])
            try await attendi { pcm.count == (i + 1) * 2 || fine.risultato != nil }
            XCTAssertNil(fine.risultato, "Il timeout misura inattività, non durata totale della voce")
        }
        try socket.inietta(["is_final": true])
        try await successo(fine)
        XCTAssertEqual(pcm.count, 12)
    }

    func testFrammentiPCMDispariVengonoRiunitiSenzaPerdereCampioni() async throws {
        let socket = SocketVoceFinto()
        var pezzi: [Data] = []
        let voce = nuova(socket) { pezzi.append($0) }
        defer { voce.ferma() }
        try await voce.apri()
        try await voce.invia("Campioni PCM spezzati fra frame.")
        try socket.inietta(["audio": Data([1]).base64EncodedString()])
        try socket.inietta(["audio": Data([2, 3, 4, 5]).base64EncodedString()])
        try socket.inietta(["audio": Data([6]).base64EncodedString()])
        try await attendi { pezzi.reduce(0) { $0 + $1.count } == 6 }
        let fine = FineVoce(voce)
        try await attendi { socket.chiusureRichieste == 1 }
        try socket.inietta(["is_final": true])
        try await successo(fine)
        XCTAssertTrue(pezzi.allSatisfy { $0.count.isMultiple(of: 2) })
        XCTAssertEqual(pezzi.reduce(into: Data()) { $0.append($1) }, Data([1, 2, 3, 4, 5, 6]))
    }
}

private enum ErroreProva: Error { case scadenza }

@MainActor
private final class FineVoce {
    var risultato: Result<Void, Error>?
    var compito: Task<Void, Never>?
    init(_ voce: VoceTelefono) {
        compito = Task { [weak self] in
            do { try await voce.finisci(); self?.risultato = .success(()) }
            catch { self?.risultato = .failure(error) }
        }
    }
}

private actor CancelloVoce {
    private var aperto = false
    private var attesa: CheckedContinuation<Void, Never>?
    func attendi() async {
        if aperto { return }
        await withCheckedContinuation { attesa = $0 }
    }
    func apri() { aperto = true; attesa?.resume(); attesa = nil }
}

/// The protocol is not actor-isolated, just like URLSessionWebSocketTask. Protect mutable
/// fake transport state because async protocol methods may run off the main executor.
private final class SocketVoceFinto: SocketVoce, @unchecked Sendable {
    private let lock = NSLock()
    private var coda: [URLSessionWebSocketTask.Message] = []
    private var attesa: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
    private var codice: URLSessionWebSocketTask.CloseCode = .invalid
    private var numeroRicezioni = 0
    private var numeroChiusure = 0
    private var chiuso = false
    private var erroreRicezione: Error?
    private var hookChiusura: (@Sendable () async -> Void)?

    var closeCode: URLSessionWebSocketTask.CloseCode { lock.withLock { codice } }
    var ricezioni: Int { lock.withLock { numeroRicezioni } }
    var chiusureRichieste: Int { lock.withLock { numeroChiusure } }
    var cancellato: Bool { lock.withLock { chiuso } }
    var duranteChiusura: (@Sendable () async -> Void)? {
        get { lock.withLock { hookChiusura } }
        set { lock.withLock { hookChiusura = newValue } }
    }

    func resume() {}

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        let data: Data
        switch message {
        case .string(let string): data = Data(string.utf8)
        case .data(let bytes): data = bytes
        @unknown default: return
        }
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard json?["close_socket"] as? Bool == true else { return }
        let hook = lock.withLock { numeroChiusure += 1; return hookChiusura }
        await hook?()
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { continuation in
            let immediato: Result<URLSessionWebSocketTask.Message, Error>? = lock.withLock {
                numeroRicezioni += 1
                if chiuso { return .failure(CancellationError()) }
                if let erroreRicezione { return .failure(erroreRicezione) }
                if !coda.isEmpty { return .success(coda.removeFirst()) }
                precondition(attesa == nil, "Una sola ricezione WebSocket per volta")
                attesa = continuation
                return nil
            }
            if let immediato { continuation.resume(with: immediato) }
        }
    }

    func inietta(_ json: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: json)
        let message = URLSessionWebSocketTask.Message.string(String(decoding: data, as: UTF8.self))
        let pending: CheckedContinuation<URLSessionWebSocketTask.Message, Error>? = lock.withLock {
            guard !chiuso else { return nil }
            if let pending = attesa { attesa = nil; return pending }
            coda.append(message)
            return nil
        }
        pending?.resume(returning: message)
    }

    func fallisciRicezione(_ error: Error) {
        let pending: CheckedContinuation<URLSessionWebSocketTask.Message, Error>? = lock.withLock {
            erroreRicezione = error
            let pending = attesa; attesa = nil
            return pending
        }
        pending?.resume(throwing: error)
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let pending: CheckedContinuation<URLSessionWebSocketTask.Message, Error>? = lock.withLock {
            chiuso = true; codice = closeCode; coda.removeAll()
            let pending = attesa; attesa = nil
            return pending
        }
        pending?.resume(throwing: CancellationError())
    }
}
