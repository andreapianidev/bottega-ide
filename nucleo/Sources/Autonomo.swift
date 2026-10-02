//
//  Autonomo.swift
//  Bottega Nucleo
//
//  The Nucleo answers for itself in front of macOS privacy (TCC), like a standalone app.
//
//  CORRECTION (2/10/2026, 19:07): this did NOT move TCC off Bottega. The crash report of the
//  first speech-recognition request says macOS read the usage description from the responsible
//  app, Bottega.app (coalition com.andreapiani.bottega), not from the Nucleo. So the permissions
//  the Nucleo uses need their usage strings in Bottega.app too (scripts/package.sh). The silence
//  of 18:43 was not proven to be a TCC problem: the transcription engine was (see AppleSTT.swift).
//  The re-launch is harmless and stays until it is removed on purpose.
//
//  Spawned by the Bottega extension (node child_process), the Nucleo has Bottega.app as its
//  "responsible process": macOS applies Bottega's microphone permission, not the Nucleo's.
//  On 2/10/2026 that gave silence: authorizationStatus said "authorized", the mic opened, 10 s
//  of audio went to ElevenLabs and not one word came back (the orb did not move either). macOS
//  does not fail a capture it does not allow: it delivers zeros.
//
//  Avo Agency AI works because it is its own app. Here the service re-launches itself once at
//  start with the responsibility disclaimed (the same thing terminals and helper-hosting apps
//  do): the child is responsible for itself, asks for the microphone as "Bottega Nucleo" and
//  keeps its own permission. Same stdin/stdout/stderr (inherited), signals forwarded, the
//  parent exits with the child's status. If the disclaim is not available the Nucleo runs as
//  before.
//

import Darwin
import Foundation

enum Autonomo {
    static let flag = "BOTTEGA_NUCLEO_AUTONOMO"

    /// In service mode, before anything else: re-launch disclaimed and wait. Returns only when
    /// this process is already the disclaimed one, or when the re-launch is impossible.
    static func rilancia() {
        let env = ProcessInfo.processInfo.environment
        if env[flag] != nil { return }
        guard let exe = Bundle.main.executablePath ?? CommandLine.arguments.first else { return }
        typealias Disclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else {
            FileHandle.standardError.write(Data("[nucleo] responsabilita' non separabile: resto nel processo della Bottega\n".utf8))
            return
        }
        let disclaim = unsafeBitCast(sym, to: Disclaim.self)

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        guard disclaim(&attr, 1) == 0 else { return }

        var childEnv = env
        childEnv[flag] = "1"
        let argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = childEnv.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
        }

        var pid: pid_t = 0
        let rc = posix_spawn(&pid, exe, nil, &attr, argv, envp)
        guard rc == 0 else {
            FileHandle.standardError.write(Data("[nucleo] rilancio autonomo fallito (\(rc)): resto nel processo della Bottega\n".utf8))
            return
        }

        // The extension stops the Nucleo with SIGTERM: pass it (and the others) to the child.
        var sources: [DispatchSourceSignal] = []
        for s in [SIGTERM, SIGINT, SIGHUP, SIGQUIT] {
            signal(s, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: s, queue: .global())
            src.setEventHandler { kill(pid, s) }
            src.resume()
            sources.append(src)
        }
        var status: Int32 = 0
        while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
        _ = sources
        let exited = (status & 0x7f) == 0
        exit(exited ? (status >> 8) & 0xff : 1)
    }
}
