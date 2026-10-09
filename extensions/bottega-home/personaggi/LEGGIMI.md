# Personaggi di Melissa

Un file per personaggio: Darlene, Elliot e Krista di Mr. Robot, a cui Melissa passa la chiamata. Fonte unica per la
mod melissa di Claude Code, la barra di Melissa nella Bottega e la Bottega per iPhone (docs/CONTRATTI.md, 9.10).

- La Bottega li porta con l'estensione e all'avvio li copia in `~/.bottega/personaggi/`, da dove li legge la mod.
- L'app iPhone li include nella build (`ios/project.yml`).
- Per aggiungere un personaggio basta un file nuovo: poi reinstalla la Bottega (`scripts/package.sh`), ricompila
  l'app iPhone e fai `/reload-plugins` in Claude Code.

Campi: `chiave` (minuscola, e' anche il valore `a` dello strumento `passa_parola`), `nome`, `ordine`, `mestiere` (la memoria del suo mestiere nella Memoria della Bottega: `incidenti` di sicurezza, `impegni` di Andrea, `forzature` di Claude e degli agenti; uno per personaggio, docs/CONTRATTI.md 9.11), `strumenti` (quali letture puo' fare quando parla, tutte di sola lettura: `vedetta_leggi` le regole della Vedetta, `mestiere_leggi` la memoria del suo mestiere, `bacheca_leggi` sessioni aperte, ore di lavoro di fila e notti; al piu' due giri per battuta), `voce` (ID ElevenLabs dell'account di
Andrea: senza la sua chiave non serve a niente), `voce_nota`, `carattere`, `saluti`, `ruolo` (nella chiacchierata),
`ruolo_cronaca`, `parole` (espressione regolare: se Andrea dice una di queste, Melissa tira dentro lui),
`parole_cronaca` (lo stesso sulle azioni di Claude: solo parole che indicano un problema vero, non quelle di ogni
build, come "firma" o "token"), `errori_ripetuti` (quanti errori di Claude di fila lo fanno entrare nella cronaca, 0
mai), `occasioni` (in quali fatti entra: `sicurezza`, `rischio`, `errore`, `scelta`, `umore`, `attesa`, `fine`, e `chiacchiera` per la chiacchierata; tutti presenti, a ognuno si chiede dal suo `ruolo_cronaca`; le regole sono
in `docs/CONTRATTI.md`, 9.11, "Ospiti dai fatti"), `riempitivi` (le frasi che dice mentre pensa, divise per gruppo: `domanda`, `ordine`, `sfogo`,
`battuta`, `chiacchiera`, `lunga`, `eco`; le regole sono in `docs/CONTRATTI.md`, 9.11). A parita' vince chi ha
`ordine` piu' basso.

`sfera` (facoltativo): `{"forma": "...", "colore": "#RRGGBB"}`, come appare la sfera quando parla lui, cosi' Andrea
riconosce chi parla a occhio (nella barra, nella pagina di Melissa e sull'isola del Nucleo). Forme: `sfera`, `codice`,
`rombo`, `stella` (`cubo` si accetta ancora e vale `codice`). Oggi Darlene e' una stella magenta (`#FF2E9A`), Elliot una
sfera di vetro scuro con il codice verde terminale che scende come in Matrix (`codice`, `#38F27A`), Krista un rombo ambra
(`#FFB547`). Senza il campo, o con un valore non valido, forma e colore si scelgono dalla chiave, sempre
uguali per la stessa chiave e mai la sfera (che e' di Melissa): la regola e' in `docs/CONTRATTI.md`, 9.11, «La sfera di
chi parla». L'emozione della battuta (tag audio come `[laughs]` o `[sighs]`, o le parole) fa girare la forma piu' o meno
in fretta e cambia la luce del colore. `melissa.json` non lo ha: Melissa resta la sfera con i suoi colori.

Essenziali: `chiave` (non `melissa`, e una sola per file), `nome`, `voce`, `carattere`, `saluti`. Senza uno di questi il
file si salta e la Bottega lo scrive nel registro. Gli altri sono facoltativi: `ordine` 99, `ruolo` il nome,
`ruolo_cronaca` il ruolo, `parole` e `parole_cronaca` vuote (mai), `errori_ripetuti` 0, `occasioni` vuote (non entra mai da solo). Un'espressione regolare che non
si compila vale come vuota, con un avviso. Senza `riempitivi`, o con un gruppo vuoto, il personaggio usa i suoi
`chiacchiera` e poi quelli di Melissa.

`melissa.json` non e' un personaggio: e' il file di Melissa, con `chiave: "melissa"` e solo i suoi `riempitivi`. Non
entra nell'elenco, non ha pulsante e non si chiama; la sua voce e il suo carattere stanno altrove.

Un file tolto da qui sparisce anche da `~/.bottega/personaggi/` al prossimo
avvio della Bottega, e la barra di Melissa mostra un pulsante per ogni personaggio caricato.
