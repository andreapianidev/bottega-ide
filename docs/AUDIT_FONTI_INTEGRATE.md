# Fonti integrate, verifica build 103

Il difetto era ripetuto: il registro delle attivita' comprendeva quattro fonti, ma
diverse funzioni derivate leggevano ancora esclusivamente le sessioni Claude.
La build 103 corregge quei collegamenti e aggiunge le fonti mancanti alla Memoria.

| Funzione | Copertura e comportamento |
| --- | --- |
| Memoria, ricerca, linea del tempo, grafici dei ricordi | Claude, Codex, Cline, Melissa e comandi/esiti dei terminali osservati. Note con fonte e data originale. |
| CLI, MCP, bacheca e contesto | Acquisizione comune prima delle letture. L'estensione sincronizza anche ogni minuto con la stanza chiusa. |
| Spotlight | Riassunti, decisioni, note e fatti di tutte le fonti presenti in Memoria; aggiornamento ogni cinque minuti. |
| Continua e Da fare, anche via Melissa/iPhone | Ultimo esito Claude/Codex/Cline/Melissa. Solo liste esplicite; nessun recupero di liste obsolete da esiti precedenti. |
| Home, Lavori, grafici di stato, schede progetto e barra laterale | Registro comune Claude, Codex, Cline e terminali. Un array vuoto cancella i conteggi precedenti. |
| Briefing, annunci di attesa e progetti dimenticati | Attivita' di tutte le quattro fonti; un progetto con Cline attivo non e' dimenticato. |
| Melissa: situazione progetto e lettura delle sessioni | Stato e dettagli osservati di tutte le quattro fonti, con provenienza. |
| Widget, ponte iPhone, Live Activity e Watch | Conteggi del registro comune; scadenza e orario del dato restano quelli del ponte. |
| Osservatorio Metal nativo | Progetti e attivita' delle quattro fonti, aggiornati anche a Home chiusa. Progetti senza metriche Claude visibili con ore non disponibili. |
| Ore Home, widget, briefing e Cruscotto generale letto da Melissa | Intervalli osservati Claude e Codex, uniti senza sommare sessioni parallele. |
| Clienti | Intervalli Claude e Codex attribuiti ai progetti e worktree; deduplicazione delle sovrapposizioni nello stesso progetto. |
| Consumi nel Cruscotto | Separati per fonte secondo i registri: un valore assente resta non disponibile. |
| Categorie, OCR e metriche storiche Claude dell'Osservatorio | Copertura specifica Claude dichiarata; non viene dedotta una misura per le altre fonti. |
| App Store, AdMob, Vedetta, Posta e connettori | Usano le rispettive sorgenti di servizio; non derivano dai registri degli agenti. |

## Limiti reali

- Cline non offre una durata confrontabile per le ore del rendiconto; i terminali non
  hanno uno storico di consumi. La loro presenza nei lavori non autorizza a inventare
  ore, costi o categorie.
- Importazione Codex limitata ai file recenti e incrementale; Cline controlla fino a
  100 file modificati negli ultimi 45 giorni, 8 MiB ciascuno. La Memoria non e' una
  copia integrale di tutti i file di trascrizione: esclude ragionamenti, risultati degli
  strumenti, immagini e parti riservate. Testo massimo 8.000 caratteri per nota.
- Il terminale conserva comando ed esito da quando il monitor e' registrato. Output
  precedente ed eventi dei terminali esterni non sono ricostruibili. Melissa recupera
  solo la cronologia locale conservata, senza assegnarla al progetto aperto adesso.
- Avvio, coda, finestra notturna, input e resume restano azioni degli esecutori gia'
  supportati. Osservare una sessione Cline o Codex non equivale a poterla comandare
  tramite il resume di Claude.
- Importazione locale gia' eseguita; aggiornamento continuo e viste corrette richiedono
  l'installazione della 103. Il pacchetto pronto non cambia la copia Mac 99 in esecuzione.

## Verifica

Prove offline dedicate: Cline SDK/legacy, file parziali, date, redazione,
deduplicazione, CLI e processo MCP; spool privato; briefing e registro vuoto;
Da fare e Continua con esiti di fonti diverse; progetti dimenticati; schede progetto;
adattatore Osservatorio e decoder Swift; ore Clienti con due sessioni Codex parallele
nel progetto principale e nel worktree. Suite completa dell'estensione, typecheck e
162 layout Osservatorio. Pacchetto macOS 103 compilato e firmato.

La verifica fisica sul Watch resta aperta: dispositivo installato alla 100 ma bloccato
all'ultimo tentativo di avvio. Non dichiarare verificato il quadrante dalla sola build.
