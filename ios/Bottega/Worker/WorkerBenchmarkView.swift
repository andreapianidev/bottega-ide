import SwiftUI
import UIKit

/// Dedicated diagnostic surface: normal voice/bridge UI must not mount while it is visible.
struct WorkerBenchmarkView: View {
    @Environment(\.scenePhase) private var phase
    @State private var task: Task<Void, Never>?
    @State private var status = "Preparazione della verifica"
    @State private var running = false
    @State private var finished = false
    @State private var previousIdleTimerDisabled: Bool?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Label("Verifica del telefono", systemImage: "cpu")
                .font(.title2.weight(.semibold))
            Text("Tieni questa schermata aperta. Durante la prova lo schermo resta acceso; al termine torna all'impostazione precedente. La prova usa soltanto dati sintetici e si interrompe quando l'app passa in background.")
                .foregroundStyle(Tinte.tinta)
            if running { ProgressView() }
            Text(status).font(.callout.monospacedDigit()).textSelection(.enabled)
            if running {
                Button("Interrompi", role: .cancel) { stop() }
            } else if !finished {
                Button("Riprendi la verifica") { start() }
                    .disabled(phase != .active)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(Tinte.testo)
        .background(Tinte.sfondo)
        .onAppear { if phase == .active { start() } }
        .onChange(of: phase) { _, next in
            if next != .active { stop() }
            else if task == nil && !finished { start() }
        }
        .onDisappear { stop() }
    }

    @MainActor private func start() {
        guard !running, !finished, phase == .active else { return }
        if previousIdleTimerDisabled == nil {
            previousIdleTimerDisabled = UIApplication.shared.isIdleTimerDisabled
            UIApplication.shared.isIdleTimerDisabled = true
        }
        running = true
        task = Task {
            defer {
                restoreIdleTimer()
                running = false
                task = nil
            }
            do {
                _ = try await WorkerBenchmarkLaunch.run { message in
                    Task { @MainActor in if running && !finished { status = message } }
                }
                status = "Verifica completata. Rapporto pronto per il confronto sul Mac."
                finished = true
            } catch is CancellationError {
                status = "Verifica interrotta. Puoi ripeterla mantenendo l'app aperta."
            } catch {
                status = "Verifica non completata: \(error.localizedDescription)"
            }
        }
    }

    @MainActor private func stop() {
        task?.cancel()
        // Vision may finish its current synchronous image before noticing cancellation.
        // Release immediately when leaving the foreground, without waiting for that call.
        restoreIdleTimer()
    }

    @MainActor private func restoreIdleTimer() {
        guard let previous = previousIdleTimerDisabled else { return }
        UIApplication.shared.isIdleTimerDisabled = previous
        previousIdleTimerDisabled = nil
    }
}
