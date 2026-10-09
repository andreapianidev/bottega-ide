# Benchmark minimo Mac e iPhone

Questo diagnostico esegue davvero NaturalLanguage e Vision sui due dispositivi. Non crea una coda, non legge conversazioni o credenziali e non chiama servizi remoti. Il dataset contiene 12 testi sintetici (uno vuoto per verificare il contratto) e due immagini PNG da 1280 × 960. Le dimensioni rappresentano note e schermate, senza gonfiare il lotto per giustificare un worker.

## Prova sul Mac

Salvare i risultati fuori dal repository pubblico, in una cartella privata già creata:

```bash
bash scripts/benchmark-worker.sh --repetitions 5 \
  --dataset-out "$BENCHMARK_DIR/benchmark-worker-dataset.json" \
  --out "$BENCHMARK_DIR/mac.json"
python3 scripts/benchmark-worker-report.py "$BENCHMARK_DIR/mac.json"
```

Lo script compila soltanto due file Swift ottimizzati in una cartella temporanea e la elimina all'uscita. Non compila, firma o installa le applicazioni. `--operation embeddings` e `--operation ocr` isolano il carico. `--dataset-in` riusa lo stesso dataset invece di rigenerare le immagini. `--sustained-seconds 900` avvia esplicitamente una prova sostenuta di almeno 15 minuti; la durata massima configurabile è 1200 secondi e la pressione termica serious/critical interrompe la prova. Anche le ripetizioni sono limitate a 1000. Le prove lunghe non partono per impostazione predefinita.

Ogni campione registra durata di calcolo e codifica dell'output, CPU del processo, picco della memoria residente, termica, input/output, hash e qualità. I costi di preparazione dentro `run` sono separati; compilazione, generazione del dataset nel chiamante CLI, lettura da disco, avvio del processo e trasporto sono esclusi. Il picco di memoria del processo non misura le allocazioni GPU o i servizi Apple esterni. Il primo campione è marcato “first-in-process”: non garantisce cache di sistema fredda. Nessuna cache del sistema viene eliminata.

## Hook iPhone

I tre file `ios/Bottega/Worker/WorkerBenchmark*.swift` appartengono automaticamente al target generato con XcodeGen. `BottegaApp.swift` integra già il ramo diagnostico prima della normale UI, con questa struttura:

```swift
if WorkerBenchmarkLaunch.requested {
    WorkerBenchmarkView()
} else {
    // UI normale e relativi handler ponte/voce.
}
```

Gli handler ordinari del ponte e della voce sono esclusi durante l'avvio diagnostico, così il diagnostico non avvia un altro proprietario dell'audio. La vista usa `Task.detached`, cancella il calcolo quando passa in background e consente di ripeterlo in primo piano. Durante la prova foreground impedisce soltanto il blocco automatico dello schermo: conserva e ripristina il precedente `isIdleTimerDisabled` al termine, su errore, cancellazione, uscita dalla vista o perdita del foreground. Il ripristino non aspetta il completamento di una chiamata Vision sincrona. La cancellazione del calcolo avviene fra batch e fra immagini, non interrompe a metà quella chiamata. Prima di ogni nuova prova viene tolto il vecchio rapporto, evitando di scambiarlo per il risultato di una prova interrotta. La prova può usare NaturalLanguage e Vision su un iPhone 15 Plus; non richiede Foundation Models.

Dopo build e installazione secondo le istruzioni del repository, usare un dispositivo reale sbloccato. Sostituire `DEVICE` con il suo identificativo locale, senza salvarlo nel repository:

```bash
xcrun devicectl device copy to --device "$DEVICE" \
  --domain-type appDataContainer --domain-identifier com.andreapiani.bottega.ios \
  --source "$BENCHMARK_DIR/benchmark-worker-dataset.json" \
  --destination Documents/benchmark-worker-dataset.json
xcrun devicectl device process launch --device "$DEVICE" --terminate-existing \
  com.andreapiani.bottega.ios -- --benchmark-worker --operation all --repetitions 5
# Attendere che la vista mostri il completamento, mantenendo l'app in primo piano.
xcrun devicectl device copy from --device "$DEVICE" \
  --domain-type appDataContainer --domain-identifier com.andreapiani.bottega.ios \
  --source Documents/benchmark-worker-result.json --destination "$BENCHMARK_DIR/iphone.json"
python3 scripts/benchmark-worker-report.py "$BENCHMARK_DIR/mac.json" "$BENCHMARK_DIR/iphone.json"
```

Il dataset va copiato dal Mac per usare byte PNG identici: font e renderer locali possono variare. La copia via devicectl è soltanto un modo per fornire/raccogliere fixture diagnostiche, non il trasporto del worker e non un benchmark Tailscale. Senza fixture copiata il telefono genera dati locali; il confronto rifiuta dataset con hash diverso. Non usare il simulatore per dichiarare prestazioni iPhone.

## Qualità e decisione

NaturalLanguage riporta lingua italiana, revisione e dimensione; controlla vettori finiti, norma unitaria e vettore nullo per il testo vuoto. Le 12 sonde vengono salvate per il confronto numerico fra dispositivi. La stessa revisione e la stessa dimensione non bastano a garantire l'intercambiabilità dell'indice: il report mostra soltanto compatibilità delle sonde a tolleranza 1e-4 e mantiene `index_compatibility_proven=false`.

Vision usa la stessa API `VNRecognizeTextRequest` su Mac e iPhone, accurate, correzione abilitata, lingue it-IT/en-US. La qualità registra il richiamo delle parole attese con molteplicità, ignorando maiuscole/punteggiatura/diacritici; soglia sintetica 95%. Nucleo in produzione usa la nuova `RecognizeTextRequest`, quindi serve anche verifica separata di parità prima di sostituirne il percorso.

Il riepilogo distingue primo campione, mediana calda e intervallo; non calcola p95 su pochi campioni. Nessun confronto di questi tempi prova un guadagno completo. Restano da misurare trasporto autenticato, diretto/relay, serializzazione al confine dell'app, acquisizione, reattività del Mac durante una normale attività e qualità su dati rappresentativi. `end_to_end_benefit` resta “not measured” anche quando iPhone vince il solo calcolo. L'eventuale coda di produzione dipende da quelle misure.

Verifica isolata delle invarianti del confronto:

```bash
python3 scripts/benchmark-worker-report.py --self-test
# Verifica anche un rapporto reale contro i dati effettivamente usati:
python3 scripts/benchmark-worker-report.py "$BENCHMARK_DIR/mac.json" \
  --dataset "$BENCHMARK_DIR/benchmark-worker-dataset.json"
```
