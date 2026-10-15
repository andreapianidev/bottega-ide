//
//  ConversazioneView.swift
//  Bottega per iPhone
//
//  La chat di Moony sulla luna (15/10/2026), come Moony AI sul Mac e come ChatGPT. Senza conversazione la luna e'
//  grande al centro con il nome e le domande pronte; appena c'e' una conversazione si fa piccola in alto e la chat
//  scorre sotto. La domanda di Andrea a destra in un fumetto scuro, la risposta di Moony a sinistra senza fumetto, in
//  markdown, con il pulsante per copiarla; i turni nati a voce hanno il microfono. In basso la barra: "+" per
//  allegare (foto, fotocamera, file), "Chiedi a Moony", il microfono che passa alla voce di sempre, invia. Sotto il
//  campo il modello (Flash, Pro, Vision), con chi parli e il credito DeepSeek, come sul Mac (4.0 beta 3).
//
//  Il cervello e la memoria sono quelli di sempre (Melissa, AssistenteTelefono, il ponte): le righe sono il registro
//  del Mac piu' i turni dell'iPhone non ancora arrivati. «Nuova chat» e le conversazioni passate restano
//  sull'iPhone (docs/CONTRATTI.md, 9.10).
//

import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Una riga della chat, come la mostra l'iPhone.
struct RigaChat: Codable, Identifiable, Equatable {
    let id: String
    let chi: String
    let testo: String
    let alle: Double
    var voce = false
    /// Un allegato: `testo` e' il nome del file.
    var allegato = false
}

/// Una conversazione chiusa con «Nuova chat».
struct ChatPassata: Codable, Identifiable {
    let id: UUID
    let titolo: String
    let inizio: Double
    let righe: [RigaChat]
}

enum RigheChat {
    /// La chat di adesso: il registro del Mac piu' i turni dell'iPhone ancora in attesa (o tutti, da scollegati),
    /// dall'ultima «Nuova chat». Gli allegati restano sull'iPhone e si vedono sempre.
    @MainActor
    static func attuali(stato: StatoMac?, online: Bool) -> [RigaChat] {
        let telefono = AssistenteTelefono.shared
        let mac = stato?.melissa.registro ?? []
        // Il server assegna il proprio orario ai turni importati: dei locali solo quelli non ancora nel registro.
        let locali = telefono.turni.filter { t in
            t.esterno == true || !t.sincronizzato
                || (!online && !mac.contains { $0.chi == t.riga.chi && $0.testo == t.riga.testo })
        }
        let dalMac = mac.map { r in
            RigaChat(id: r.id, chi: r.chi, testo: r.testo, alle: r.alle,
                     voce: telefono.turni.contains { $0.voce == true && $0.riga.chi == r.chi && $0.riga.testo == r.testo })
        }
        let dalTelefono = locali.map { t in
            RigaChat(id: t.id.uuidString, chi: t.riga.chi,
                     testo: t.esterno == true ? (AllegatoMoony.nome(in: t.testo) ?? "Allegato") : t.riga.testo,
                     alle: t.alle, voce: t.voce == true, allegato: t.esterno == true)
        }
        return (dalMac + dalTelefono).filter { $0.alle >= telefono.inizioChat }.sorted { $0.alle < $1.alle }
    }
}

extension Ponte {
    /// Il nome di chi ha la chiamata nella barra del Mac, se non e' Melissa (`melissa.personaggio` di /v1/stato).
    var personaggioMac: String? {
        guard let k = stato?.melissa.personaggio, k != "melissa", !k.isEmpty else { return nil }
        return Personaggi.tutti[k]?.nome ?? (k.prefix(1).uppercased() + String(k.dropFirst()))
    }
}

struct ConversazioneView: View {
    let ponte: Ponte
    let melissa: Melissa
    let davanti: Bool
    let apriCervello: () -> Void
    @State private var telefono = AssistenteTelefono.shared
    @State private var conversazioni = false

    private var online: Bool { ponte.linea == .collegato }
    private var statoVisibile: StatoMac? { ponte.stato ?? StatoMac.ultimo() }
    private var righe: [RigaChat] { RigheChat.attuali(stato: statoVisibile, online: online) }
    private var parzialeMac: String? {
        guard online, let p = ponte.stato?.melissa.risposta, !p.isEmpty else { return nil }
        return p
    }
    private var vuota: Bool { righe.isEmpty && parzialeMac == nil && telefono.rispostaParziale.isEmpty && melissa.sfera != .pensa }

    private static let pronte: [(String, String)] = [
        ("Briefing", "Fammi il briefing di oggi."),
        ("Chi mi aspetta", "Quali attività Claude, Cline, Codex o terminali mi aspettano?"),
        ("Regole", "Ci sono regole violate nei progetti?"),
        ("Al lavoro", "Cosa stanno facendo Claude, Cline, Codex e i terminali adesso?"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            testata
            if vuota { Spacer(minLength: 0) }
            luna
            sottoLaLuna
            if vuota {
                Spacer(minLength: 0)
                pronte.padding(.bottom, 8)
            } else {
                trascrizione
            }
            BarraMoony(melissa: melissa, apriCervello: apriCervello)
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.85), value: vuota)
        .sheet(isPresented: $conversazioni) {
            ConversazioniFoglio { nuovaChat() }
                .presentationDetents([.medium, .large])
        }
        // il credito si rilegge all'apertura, dopo ogni risposta (Melissa.chiedi) e ogni 5 minuti, come sul Mac
        .task(id: davanti) {
            while davanti, !Task.isCancelled {
                await telefono.aggiornaCredito()
                try? await Task.sleep(for: .seconds(300))
            }
        }
    }

    // MARK: - testata e luna

    private var testata: some View {
        HStack {
            Button { conversazioni = true } label: {
                Image(systemName: "line.3.horizontal")
                    .font(.title3)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Conversazioni")
            Spacer()
            Button(action: nuovaChat) {
                Image(systemName: "square.and.pencil")
                    .font(.title3)
                    .frame(width: 44, height: 44)
            }
            .disabled(melissa.occupata || righe.isEmpty)
            .accessibilityLabel("Nuova chat")
        }
        .foregroundStyle(Tinte.tinta)
        .padding(.horizontal, 10)
    }

    private func nuovaChat() {
        guard !melissa.occupata else { return }
        if melissa.conversazione { melissa.chiudiConversazione() }
        telefono.nuovaChat(righe: righe)
    }

    private var lato: CGFloat { vuota ? 230 : 76 }

    private var luna: some View {
        SferaView(stato: melissa.sfera, attiva: davanti, aspetto: AspettoPersonaggi.di(melissa))
            .frame(width: lato, height: lato)
            // la maschera radiale della barra sul Mac: piena fino al 62% del raggio, zero sul bordo
            .mask {
                RadialGradient(stops: [.init(color: .black, location: 0.62), .init(color: .clear, location: 1)],
                               center: .center, startRadius: 0, endRadius: lato / 2)
            }
            .contentShape(Circle())
            .onTapGesture { melissa.tocca() }
            // tocco lungo: il selettore del cervello (CervelloView.swift)
            .onLongPressGesture(minimumDuration: 0.5) { apriCervello() }
            .accessibilityLabel("Luna di Moony")
            .accessibilityHint(melissa.sfera == .ascolta ? "Tocca per mandare la frase" : "Tocca per parlare con Moony")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction(named: "Scegli il cervello") { apriCervello() }
    }

    @ViewBuilder
    private var sottoLaLuna: some View {
        VStack(spacing: 4) {
            if vuota {
                Text(melissa.parlante)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Tinte.testo)
            }
            if vuota || melissa.sfera != .riposo || melissa.conversazione {
                Text(fraseLuna)
                    .font(vuota ? .callout : .caption)
                    .foregroundStyle(melissa.sfera == .errore ? Tinte.rosso : Tinte.tinta)
                    .multilineTextAlignment(.center)
                    .lineLimit(vuota ? 3 : 2)
                    .padding(.horizontal, 28)
                    .animation(.easeOut(duration: 0.2), value: fraseLuna)
            }
            if melissa.conversazione {
                Button("Chiudi la conversazione") { melissa.chiudiConversazione() }
                    .font(.footnote)
                    .foregroundStyle(Tinte.ambra)
            }
        }
        .padding(.bottom, vuota ? 0 : 4)
    }

    private var fraseLuna: String {
        switch melissa.sfera {
        case .ascolta: melissa.parziale.isEmpty ? "Ti ascolto" : melissa.parziale
        case .pensa: "Ci penso…"
        case .parla: melissa.parlante == "Moony" ? "Tocca la luna per interrompermi" : "Parla \(melissa.parlante). Tocca la luna per interrompere"
        case .errore: "Qualcosa non è andato. Tocca la luna per riprovare."
        case .riposo:
            switch ponte.stato?.melissa.stato {
            case "thinking"?: ponte.personaggioMac.map { "Sul Mac \($0) sta già rispondendo" } ?? "Sul Mac sto già rispondendo"
            case "speaking"?: ponte.personaggioMac.map { "Sul Mac sta parlando \($0)" } ?? "Sto parlando sul Mac"
            case "listening"?: "Sul Mac ti sto ascoltando"
            default: melissa.chiParla == "melissa" ? "Pronto. Scrivi qui sotto, o tocca la luna per parlarmi"
                : "Sei con \(Personaggi.nome(melissa.chiParla)). «Ridammi Moony» per tornare da me"
            }
        }
    }

    private var pronte: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Self.pronte, id: \.0) { p in
                    Button(p.0) { melissa.scrivi(p.1) }
                        .font(.footnote.weight(.medium))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(Capsule().fill(Tinte.notteFonda))
                        .overlay(Capsule().stroke(Tinte.bordo))
                        .foregroundStyle(Tinte.testo)
                        .disabled(melissa.occupata)
                }
            }
            .padding(.horizontal, 16)
        }
    }

    // MARK: - la conversazione

    private var trascrizione: some View {
        ScrollViewReader { scorri in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if !online, let ultimo = statoVisibile, !ultimo.melissa.registro.isEmpty {
                        Text("Ultima conversazione ricevuta dal Mac alle \(Date(timeIntervalSince1970: ultimo.ora / 1000).formatted(date: .abbreviated, time: .shortened)).")
                            .font(.caption)
                            .foregroundStyle(Tinte.tinta)
                            .frame(maxWidth: .infinity)
                    }
                    ForEach(righe) { r in
                        RigaMoony(riga: r).id(r.id)
                    }
                    if let parzialeMac {
                        RispostaMoony(testo: parzialeMac, voce: false, copiabile: false)
                    }
                    if !telefono.rispostaParziale.isEmpty {
                        RispostaMoony(testo: telefono.rispostaParziale, voce: false, copiabile: false)
                    } else if melissa.sfera == .pensa && parzialeMac == nil {
                        MoonyPensa()
                    }
                    Color.clear.frame(height: 1).id("fondo")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
            .scrollDismissesKeyboard(.interactively)
            // le righe che salgono sotto la luna svaniscono invece di tagliarsi di netto
            .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.05),
                                         .init(color: .black, location: 1)], startPoint: .top, endPoint: .bottom))
            .onChange(of: righe.last?.id) { _, _ in
                withAnimation(.easeOut(duration: 0.25)) { scorri.scrollTo("fondo", anchor: .bottom) }
            }
            .onChange(of: telefono.rispostaParziale.count) { _, _ in scorri.scrollTo("fondo", anchor: .bottom) }
            .onChange(of: ponte.stato?.melissa.risposta?.count) { _, _ in scorri.scrollTo("fondo", anchor: .bottom) }
            .onChange(of: melissa.sfera) { _, _ in scorri.scrollTo("fondo", anchor: .bottom) }
            .onAppear { scorri.scrollTo("fondo", anchor: .bottom) }
        }
    }
}

// MARK: - le righe

struct RigaMoony: View {
    let riga: RigaChat

    var body: some View {
        if riga.allegato {
            Label(riga.testo, systemImage: "paperclip")
                .font(.caption)
                .lineLimit(1)
                .foregroundStyle(Tinte.tinta)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Capsule().fill(Color.white.opacity(0.08)))
                .overlay(Capsule().stroke(Tinte.bordo, lineWidth: 0.5))
                .frame(maxWidth: .infinity, alignment: .trailing)
        } else {
            switch riga.chi {
            case "azione":
                Label(riga.testo, systemImage: "bolt.fill")
                    .font(.footnote)
                    .foregroundStyle(Tinte.ambra)
            case "tu":
                HStack(alignment: .bottom, spacing: 6) {
                    Spacer(minLength: 48)
                    if riga.voce { Microfono() }
                    Text(riga.testo)
                        .font(.body)
                        .foregroundStyle(Tinte.testo)
                        .textSelection(.enabled)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.white.opacity(0.11)))
                }
            default:
                RispostaMoony(testo: riga.testo, voce: riga.voce, copiabile: true)
            }
        }
    }
}

private struct Microfono: View {
    var body: some View {
        Image(systemName: "mic.fill")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Tinte.tinta.opacity(0.8))
            .accessibilityLabel("Detto a voce")
    }
}

/// La risposta di Moony: niente fumetto, markdown, selezionabile, con il pulsante per copiarla sotto.
struct RispostaMoony: View {
    let testo: String
    let voce: Bool
    let copiabile: Bool
    @State private var copiata = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            MarkdownMoony(testo: testo)
            if copiabile {
                HStack(spacing: 10) {
                    Button {
                        UIPasteboard.general.string = testo
                        copiata = true
                        Task { try? await Task.sleep(for: .seconds(1.5)); copiata = false }
                    } label: {
                        Image(systemName: copiata ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 13))
                            .foregroundStyle(Tinte.tinta)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(copiata ? "Copiata" : "Copia la risposta")
                    if voce { Microfono() }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MoonyPensa: View {
    @State private var pulsa = false

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(Tinte.testo).frame(width: 8, height: 8).opacity(pulsa ? 0.3 : 1)
            Text("Moony sta pensando…").font(.caption).foregroundStyle(Tinte.tinta)
        }
        .onAppear { withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { pulsa = true } }
    }
}

/// Markdown come lo scrive un modello: paragrafi con grassetto, corsivo, codice e link, titoli con #, elenchi con
/// - o *, blocchi di codice fra ```. Il resto resta testo. Lo stesso di MoonyMarkdownText sul Mac.
struct MarkdownMoony: View {
    let testo: String

    enum Blocco: Equatable {
        case paragrafo(String)
        case titolo(String, livello: Int)
        case codice(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(Self.blocchi(testo).enumerated()), id: \.offset) { _, b in
                switch b {
                case .paragrafo(let p):
                    Text(Self.inline(p)).font(.body).foregroundStyle(Tinte.testo)
                case .titolo(let t, let livello):
                    Text(Self.inline(t))
                        .font(livello <= 2 ? .title3.weight(.semibold) : .body.weight(.semibold))
                        .foregroundStyle(Tinte.testo)
                        .padding(.top, 2)
                case .codice(let c):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(c)
                            .font(.system(size: 13, design: .monospaced))
                            .foregroundStyle(Tinte.testo)
                            .padding(10)
                    }
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Tinte.notteFonda.opacity(0.8)))
                }
            }
        }
        .tint(Tinte.ambra)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }

    static func inline(_ s: String) -> AttributedString {
        let opzioni = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: s, options: opzioni)) ?? AttributedString(s)
    }

    static func blocchi(_ testo: String) -> [Blocco] {
        var out: [Blocco] = []
        var paragrafo: [String] = []
        var codice: [String]?

        func chiudi() {
            let p = paragrafo.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !p.trimmingCharacters(in: .whitespaces).isEmpty { out.append(.paragrafo(p)) }
            paragrafo.removeAll()
        }

        for riga in testo.components(separatedBy: "\n") {
            let pulita = riga.trimmingCharacters(in: .whitespaces)
            if pulita.hasPrefix("```") {
                if let aperto = codice {
                    out.append(.codice(aperto.joined(separator: "\n")))
                    codice = nil
                } else {
                    chiudi()
                    codice = []
                }
                continue
            }
            if codice != nil { codice?.append(riga); continue }
            if pulita.isEmpty { chiudi(); continue }
            if pulita.hasPrefix("#") {
                let livello = pulita.prefix { $0 == "#" }.count
                let resto = pulita.dropFirst(livello)
                if livello <= 6, resto.hasPrefix(" ") {
                    chiudi()
                    out.append(.titolo(resto.trimmingCharacters(in: .whitespaces), livello: livello))
                    continue
                }
            }
            // elenchi: "- x", "* x", "+ x" diventano "• x", con il loro rientro
            let rientro = riga.prefix { $0 == " " || $0 == "\t" }
            if let primo = pulita.first, "-*+".contains(primo), pulita.dropFirst().hasPrefix(" ") {
                paragrafo.append(String(rientro) + "• " + pulita.dropFirst(2))
                continue
            }
            paragrafo.append(riga)
        }
        if let aperto = codice { out.append(.codice(aperto.joined(separator: "\n"))) }
        chiudi()
        return out
    }
}

// MARK: - la barra di scrittura

struct BarraMoony: View {
    let melissa: Melissa
    let apriCervello: () -> Void
    @State private var telefono = AssistenteTelefono.shared
    @State private var testo = ""
    @State private var allegati: [AllegatoMoony] = []
    @State private var caricando = 0
    @State private var sceltaFoto = false
    @State private var foto: [PhotosPickerItem] = []
    @State private var file = false
    @State private var fotocamera = false
    @FocusState private var scrivendo: Bool

    private var vuoto: Bool { testo.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && allegati.isEmpty }
    private var puoMandare: Bool { !vuoto && caricando == 0 && !melissa.occupata }
    private var conImmagini: Bool { allegati.contains { !$0.immagini.isEmpty } }

    var body: some View {
        VStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 8) {
                if !allegati.isEmpty || caricando > 0 { schede }
                HStack(alignment: .bottom, spacing: 8) {
                    piu
                    TextField("Chiedi a Moony", text: $testo, axis: .vertical)
                        .lineLimit(1...6)
                        .focused($scrivendo)
                        .foregroundStyle(Tinte.testo)
                        .padding(.vertical, 9)
                    microfono
                    Button(action: manda) {
                        Image(systemName: "arrow.up")
                            .font(.headline)
                            .foregroundStyle(puoMandare ? Tinte.notteFonda : Tinte.tinta)
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(puoMandare ? Tinte.testo : Color.white.opacity(0.08)))
                    }
                    .disabled(!puoMandare)
                    .accessibilityLabel("Manda")
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 26, style: .continuous).fill(Color.white.opacity(0.06)))
            .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(Tinte.bordo, lineWidth: 0.8))
            modelloECredito
            if conImmagini && telefono.configurato && telefono.modello != .vision {
                Text("Le immagini le descrive la visione, poi risponde \(telefono.modello.nome)")
                    .font(.caption2)
                    .foregroundStyle(Tinte.tinta)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .photosPicker(isPresented: $sceltaFoto, selection: $foto, maxSelectionCount: AllegatoMoony.massimoPerMessaggio, matching: .images)
        .onChange(of: foto) { _, scelte in
            guard !scelte.isEmpty else { return }
            foto = []
            for (i, item) in scelte.enumerated() { caricaFoto(item, numero: allegati.count + i + 1) }
        }
        .fileImporter(isPresented: $file, allowedContentTypes: [.item], allowsMultipleSelection: true) { esito in
            switch esito {
            case .success(let urls): for u in urls { caricaFile(u) }
            case .failure(let e): melissa.avviso = e.localizedDescription
            }
        }
        .fullScreenCover(isPresented: $fotocamera) {
            FotocameraView { immagine in aggiungi { try AllegatoMoony.immagine(immagine, nome: "Foto.jpg") } }
                .ignoresSafeArea()
        }
    }

    // MARK: pezzi

    /// Il modello (e con chi parli) a sinistra, il credito DeepSeek a destra.
    private var modelloECredito: some View {
        HStack(spacing: 8) {
            Menu {
                if telefono.configurato {
                    Picker("Modello", selection: Binding(get: { telefono.modello }, set: { telefono.scegli($0) })) {
                        ForEach(AssistenteTelefono.Modello.allCases) { m in
                            Label(m.nome, systemImage: m.simbolo).tag(m)
                        }
                    }
                    Text(telefono.modello.dettaglio)
                    if !Personaggi.ordine.isEmpty {
                        Picker("Con chi parli", selection: Binding(get: { melissa.chiParla }, set: { melissa.passaChiamata(a: $0) })) {
                            ForEach(["melissa"] + Personaggi.ordine, id: \.self) { k in Text(Personaggi.nome(k)).tag(k) }
                        }
                        .disabled(melissa.occupata)
                    }
                } else {
                    Button("Scegli il cervello sul Mac", action: apriCervello)
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: telefono.configurato ? telefono.modello.simbolo : "desktopcomputer")
                    Text(nomeModello)
                    if melissa.chiParla != "melissa" { Text("· \(Personaggi.nome(melissa.chiParla))") }
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(Tinte.testo)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Capsule().fill(Color.white.opacity(0.07)))
            }
            .accessibilityLabel("Modello di Moony: \(nomeModello)")
            Spacer(minLength: 4)
            Button { Task { await telefono.aggiornaCredito() } } label: {
                Text(credito)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(telefono.creditoBasso ? Tinte.ambra : Tinte.tinta)
                    .lineLimit(1)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Credito DeepSeek: \(credito). Tocca per aggiornarlo")
        }
        .padding(.horizontal, 6)
    }

    private var nomeModello: String {
        if telefono.configurato { return telefono.modello.nome }
        return Ponte.shared.stato?.melissa.scelta?.nome ?? "Mac"
    }

    private var credito: String {
        guard telefono.configurato else { return "Credito: chiavi sul Mac" }
        return "Credito " + (telefono.credito ?? "…")
    }

    private var piu: some View {
        Menu {
            Button { sceltaFoto = true } label: { Label("Foto", systemImage: "photo.on.rectangle") }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button { fotocamera = true } label: { Label("Fotocamera", systemImage: "camera") }
            }
            Button { file = true } label: { Label("File", systemImage: "folder") }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Tinte.testo)
                .frame(width: 36, height: 36)
                .background(Circle().fill(Color.white.opacity(0.08)))
        }
        .disabled(allegati.count >= AllegatoMoony.massimoPerMessaggio)
        .accessibilityLabel("Allega")
    }

    private var microfono: some View {
        Button {
            scrivendo = false
            melissa.tocca()
        } label: {
            Image(systemName: melissa.sfera == .ascolta ? "waveform" : "mic")
                .font(.system(size: 18))
                .foregroundStyle(melissa.sfera == .ascolta ? Tinte.ambra : Tinte.testo)
                .frame(width: 36, height: 36)
                .symbolEffect(.variableColor.iterative, isActive: melissa.sfera == .ascolta)
        }
        .accessibilityLabel(melissa.sfera == .ascolta ? "Manda la frase detta" : "Parla con Moony")
    }

    private var schede: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(allegati) { a in
                    HStack(spacing: 6) {
                        if let img = a.anteprima {
                            Image(uiImage: img).resizable().scaledToFill()
                                .frame(width: 30, height: 30)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                        } else {
                            Image(systemName: a.simbolo).foregroundStyle(Tinte.tinta).frame(width: 30, height: 30)
                        }
                        VStack(alignment: .leading, spacing: 0) {
                            Text(a.nome).font(.caption).foregroundStyle(Tinte.testo).lineLimit(1)
                            Text(a.etichetta).font(.caption2).foregroundStyle(Tinte.tinta)
                        }
                        .frame(maxWidth: 140, alignment: .leading)
                        Button { allegati.removeAll { $0.id == a.id } } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(Tinte.tinta)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Togli \(a.nome)")
                    }
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.07)))
                }
                if caricando > 0 {
                    ProgressView().padding(.horizontal, 8)
                }
            }
            .padding(.horizontal, 4)
        }
    }

    // MARK: azioni

    private func manda() {
        guard puoMandare else { return }
        let t = testo
        let a = allegati
        testo = ""
        allegati = []
        scrivendo = false
        melissa.scrivi(t, allegati: a)
    }

    /// Legge un allegato fuori dal thread principale; il pulsante invia aspetta la fine della lettura.
    private func aggiungi(_ leggi: @escaping @Sendable () throws -> AllegatoMoony) {
        guard allegati.count + caricando < AllegatoMoony.massimoPerMessaggio else {
            melissa.avviso = "Al massimo \(AllegatoMoony.massimoPerMessaggio) allegati per messaggio."
            return
        }
        caricando += 1
        Task {
            let esito = await Task.detached(priority: .userInitiated) { Result { try leggi() } }.value
            caricando -= 1
            switch esito {
            case .success(let a): allegati.append(a)
            case .failure(let e): melissa.avviso = e.localizedDescription
            }
        }
    }

    private func caricaFile(_ url: URL) {
        aggiungi { try AllegatoMoony.carica(url: url) }
    }

    private func caricaFoto(_ item: PhotosPickerItem, numero: Int) {
        caricando += 1
        Task {
            let data = try? await item.loadTransferable(type: Data.self)
            caricando -= 1
            guard let data, let immagine = UIImage(data: data) else {
                melissa.avviso = "Non riesco a leggere la foto scelta."
                return
            }
            aggiungi { try AllegatoMoony.immagine(immagine, nome: "Foto \(numero).jpg", byte: data.count) }
        }
    }
}

/// La fotocamera per allegare uno scatto.
struct FotocameraView: UIViewControllerRepresentable {
    let scatta: (UIImage) -> Void
    @Environment(\.dismiss) private var chiudi

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let c = UIImagePickerController()
        c.sourceType = .camera
        c.delegate = context.coordinator
        return c
    }

    func updateUIViewController(_ c: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinatore { Coordinatore(self) }

    @MainActor
    final class Coordinatore: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let padre: FotocameraView
        init(_ padre: FotocameraView) { self.padre = padre }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let img = info[.originalImage] as? UIImage { padre.scatta(img) }
            padre.chiudi()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { padre.chiudi() }
    }
}

// MARK: - le conversazioni

/// «Nuova chat» e le conversazioni passate, divise per giorno. Su uno schermo stretto non c'e' posto per una
/// colonna come sul Mac: e' un foglio che si apre dal pulsante in alto a sinistra.
struct ConversazioniFoglio: View {
    let nuova: () -> Void
    @State private var telefono = AssistenteTelefono.shared
    @Environment(\.dismiss) private var chiudi

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        nuova()
                        chiudi()
                    } label: {
                        Label("Nuova chat", systemImage: "square.and.pencil")
                    }
                } footer: {
                    if telefono.passate.isEmpty {
                        Text("Le conversazioni chiuse con «Nuova chat» restano qui, su questo iPhone.")
                    }
                }
                ForEach(Self.gruppi(telefono.passate), id: \.etichetta) { g in
                    Section(g.etichetta) {
                        ForEach(g.chat) { c in
                            NavigationLink {
                                ChatPassataView(chat: c)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(c.titolo).lineLimit(1)
                                    Text(Date(timeIntervalSince1970: c.inizio / 1000).formatted(date: .abbreviated, time: .shortened))
                                        .font(.caption)
                                        .foregroundStyle(Tinte.tinta)
                                }
                            }
                        }
                        .onDelete { i in i.map { g.chat[$0].id }.forEach(telefono.togli(passata:)) }
                    }
                }
            }
            .navigationTitle("Conversazioni")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fatto") { chiudi() } } }
        }
    }

    struct Gruppo { let etichetta: String; let chat: [ChatPassata] }

    static func gruppi(_ elenco: [ChatPassata], adesso: Date = .now) -> [Gruppo] {
        let cal = Calendar.current
        let oggi = cal.startOfDay(for: adesso)
        func etichetta(_ c: ChatPassata) -> String {
            let giorno = cal.startOfDay(for: Date(timeIntervalSince1970: c.inizio / 1000))
            switch cal.dateComponents([.day], from: giorno, to: oggi).day ?? 0 {
            case ..<1: return "Oggi"
            case 1: return "Ieri"
            case 2..<7: return "Ultimi 7 giorni"
            case 7..<30: return "Ultimi 30 giorni"
            default: return "Prima"
            }
        }
        var out: [Gruppo] = []
        for c in elenco {
            let e = etichetta(c)
            if let ultimo = out.last, ultimo.etichetta == e {
                out[out.count - 1] = Gruppo(etichetta: e, chat: ultimo.chat + [c])
            } else {
                out.append(Gruppo(etichetta: e, chat: [c]))
            }
        }
        return out
    }
}

/// Una conversazione passata, da leggere.
private struct ChatPassataView: View {
    let chat: ChatPassata

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                Text("Conversazione passata, letta da questo iPhone")
                    .font(.caption)
                    .foregroundStyle(Tinte.tinta)
                    .frame(maxWidth: .infinity)
                ForEach(chat.righe) { RigaMoony(riga: $0) }
            }
            .padding(16)
        }
        .background(Tinte.sfondo.ignoresSafeArea())
        .navigationTitle(chat.titolo)
        .navigationBarTitleDisplayMode(.inline)
    }
}
