# Personaggi di Melissa

Un file per personaggio: Darlene, Elliot e Krista di Mr. Robot, a cui Melissa passa la chiamata. Fonte unica per la
mod melissa di Claude Code, la barra di Melissa nella Bottega e la Bottega per iPhone (docs/CONTRATTI.md, 9.10).

- La Bottega li porta con l'estensione e all'avvio li copia in `~/.bottega/personaggi/`, da dove li legge la mod.
- L'app iPhone li include nella build (`ios/project.yml`).
- Per aggiungere un personaggio basta un file nuovo: poi reinstalla la Bottega (`scripts/package.sh`), ricompila
  l'app iPhone e fai `/reload-plugins` in Claude Code.

Campi: `chiave` (minuscola, e' anche il segnale `@chiave`), `nome`, `ordine`, `voce` (ID ElevenLabs dell'account di
Andrea: senza la sua chiave non serve a niente), `voce_nota`, `carattere`, `saluti`, `ruolo` (nella chiacchierata),
`ruolo_cronaca`, `parole` (espressione regolare: se Andrea dice una di queste, Melissa tira dentro lui),
`parole_cronaca` (lo stesso sulle azioni di Claude), `errori_ripetuti` (quanti errori di Claude di fila lo fanno entrare
nella cronaca, 0 mai). A parita' vince chi ha `ordine` piu' basso.

Essenziali: `chiave` (non `melissa`, e una sola per file), `nome`, `voce`, `carattere`, `saluti`. Senza uno di questi il
file si salta e la Bottega lo scrive nel registro. Gli altri sono facoltativi: `ordine` 99, `ruolo` il nome,
`ruolo_cronaca` il ruolo, `parole` e `parole_cronaca` vuote (mai), `errori_ripetuti` 0. Un'espressione regolare che non
si compila vale come vuota, con un avviso. Un file tolto da qui sparisce anche da `~/.bottega/personaggi/` al prossimo
avvio della Bottega, e la barra di Melissa mostra un pulsante per ogni personaggio caricato.
