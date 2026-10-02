# Screenshot del README

Gli script che hanno preparato le immagini in `docs/screenshot/` (Python 3 con Pillow e numpy).

- `edit.py`: ritaglio sulla finestra, sfocatura dei dati dei clienti, rimozione dei tooltip.
  Le coordinate delle zone da sfocare valgono per le catture del 1 ottobre 2026: con catture nuove
  vanno ricontrollate una per una, guardando le immagini.
- `frame.py`: angoli arrotondati, ombra, sfondo nei colori della Bottega (notte e lampade al sodio).
- `hero.py`: l'immagine con due finestre sovrapposte (la plancia).
- `catture-2-ottobre.py`: le catture del 2 ottobre 2026 (`ide`, `cruscotto`, `settimana`, `vedetta`), con le
  etichette dei clienti tolte dal cielo dei progetti (`erase_text` in `edit_lib.py`).
  Uso: `python3 catture-2-ottobre.py ~/Desktop <cartella di uscita>`.
- `edit_lib.py`: le funzioni di sfocatura, da importare senza rifare il lavoro di `edit.py`.

Prima di pubblicare un'immagine: niente nomi di clienti, email, telefoni, chiavi o percorsi con nomi
di clienti. Se c'e' il dubbio, si sfoca.
