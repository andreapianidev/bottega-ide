/* Lo schermo di un terminale, ridotto a righe di testo (docs/CONTRATTI.md, 9.5). Riceve l'uscita grezza di un
   lavoro della Bottega (sequenze ANSI comprese) e tiene solo il testo che si vedrebbe: Claude Code ridisegna la
   sua interfaccia spostando il cursore su e giu' e cancellando righe, quindi togliere le sequenze non basta,
   bisogna anche eseguirle. Si gestisce il minimo che serve per un'interfaccia in linea: a capo, ritorno
   carrello, cursore su/giu'/colonna, posizione assoluta, cancella riga e schermo, schermo alternativo. Colori,
   titoli (OSC) e il resto si scartano. Niente su disco: vive solo mentre qualcuno guarda dall'iPhone. */

const MAX_RIGHE = 500;

export class Schermo {
	private righe: string[][] = [[]];
	private r = 0;
	private c = 0;
	/** La prima riga dello schermo visibile, per le posizioni assolute (ESC[r;cH). */
	private base = 0;
	private salvato = { r: 0, c: 0 };
	/** Il pezzo di sequenza rimasto a meta' tra due blocchi di dati. */
	private resto = '';

	constructor(private readonly altezza = 40) {}

	scrivi(dati: string): void {
		const s = this.resto + dati;
		this.resto = '';
		let i = 0;
		while (i < s.length) {
			const ch = s[i];
			if (ch === '\x1b') {
				const fine = this.sequenza(s, i);
				if (fine < 0) {
					// sequenza tagliata: si riprende col prossimo blocco (al massimo 256 caratteri, poi si butta)
					const pezzo = s.slice(i);
					this.resto = pezzo.length < 256 ? pezzo : '';
					return;
				}
				i = fine;
				continue;
			}
			const cp = s.codePointAt(i)!;
			const n = cp > 0xffff ? 2 : 1;
			if (ch === '\n') this.giu(1);
			else if (ch === '\r') this.c = 0;
			else if (ch === '\b') this.c = Math.max(0, this.c - 1);
			else if (ch === '\t') this.c = (Math.floor(this.c / 8) + 1) * 8;
			else if (cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp < 0xa0)) this.metti(s.slice(i, i + n));
			i += n;
		}
		this.pota();
	}

	/** Le ultime `n` righe, senza spazi in coda; le righe vuote in fondo non contano. */
	testo(n = 200): string[] {
		const out = this.righe.map(r => r.join('').replace(/\s+$/, ''));
		while (out.length && !out[out.length - 1]) out.pop();
		return out.slice(-n);
	}

	private riga(r: number): string[] {
		while (this.righe.length <= r) this.righe.push([]);
		return this.righe[r];
	}

	private metti(t: string): void {
		const riga = this.riga(this.r);
		while (riga.length < this.c) riga.push(' ');
		riga[this.c] = t;
		this.c++;
	}

	private giu(n: number): void {
		this.r += n;
		this.riga(this.r);
	}

	private pota(): void {
		const via = this.righe.length - MAX_RIGHE;
		if (via <= 0) return;
		this.righe.splice(0, via);
		this.r = Math.max(0, this.r - via);
		this.base = Math.max(0, this.base - via);
		this.salvato.r = Math.max(0, this.salvato.r - via);
	}

	private pulisci(): void {
		this.righe = [[]];
		this.r = this.c = this.base = 0;
	}

	/** Esegue la sequenza che comincia in `i` (un ESC) e ritorna dove finisce; -1 se il blocco la taglia. */
	private sequenza(s: string, i: number): number {
		const t = s[i + 1];
		if (t === undefined) return -1;
		if (t === '[') {
			let j = i + 2;
			while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++;
			if (j >= s.length) return -1;
			this.csi(s.slice(i + 2, j), s[j]);
			return j + 1;
		}
		if (t === ']' || t === 'P' || t === '_' || t === '^') {
			// OSC, DCS e simili: fino a BEL o a ESC \
			for (let j = i + 2; j < s.length; j++) {
				if (s[j] === '\x07') return j + 1;
				if (s[j] === '\x1b' && s[j + 1] === '\\') return j + 2;
			}
			return -1;
		}
		if (t === '7') this.salvato = { r: this.r, c: this.c };
		else if (t === '8') ({ r: this.r, c: this.c } = this.salvato);
		else if (t === 'c') this.pulisci();
		else if (t === 'M') this.r = Math.max(0, this.r - 1);
		else if (t === '(' || t === ')' || t === '#') return i + 3 <= s.length ? i + 3 : -1;
		return i + 2;
	}

	private csi(p: string, f: string): void {
		const privata = p.startsWith('?');
		const num = (p.replace(/^[?>=<]/, '').split(';').map(x => parseInt(x, 10)));
		const a = (k: number, d = 1) => (Number.isFinite(num[k]) && num[k] > 0 ? num[k] : d);
		if (privata) {
			// schermo alternativo (1049, 1047, 47): si riparte da pulito, all'entrata e all'uscita
			if ((f === 'h' || f === 'l') && /(^|;)(1049|1047|47)(;|$)/.test(p.slice(1))) this.pulisci();
			return;
		}
		switch (f) {
			case 'A': this.r = Math.max(0, this.r - a(0)); break;
			case 'B': this.giu(a(0)); break;
			case 'C': this.c += a(0); break;
			case 'D': this.c = Math.max(0, this.c - a(0)); break;
			case 'E': this.giu(a(0)); this.c = 0; break;
			case 'F': this.r = Math.max(0, this.r - a(0)); this.c = 0; break;
			case 'G': case '`': this.c = a(0) - 1; break;
			case 'd': this.r = this.base + a(0) - 1; this.riga(this.r); break;
			case 'H': case 'f':
				this.r = this.base + a(0) - 1;
				this.c = a(1) - 1;
				this.riga(this.r);
				break;
			case 'K': {
				const riga = this.riga(this.r);
				const m = num[0] || 0;
				if (m === 0) riga.length = Math.min(riga.length, this.c);
				else if (m === 1) for (let k = 0; k <= this.c && k < riga.length; k++) riga[k] = ' ';
				else riga.length = 0;
				break;
			}
			case 'J': {
				const m = num[0] || 0;
				if (m === 2 || m === 3) {
					// schermo intero: la parte visibile riparte da qui, la storia sopra resta
					this.righe.length = Math.min(this.righe.length, this.base + 0);
					this.base = this.righe.length;
					this.r = this.base;
					this.c = 0;
					this.riga(this.r);
				} else if (m === 0) {
					this.riga(this.r).length = Math.min(this.riga(this.r).length, this.c);
					this.righe.length = this.r + 1;
				} else {
					for (let k = this.base; k < this.r; k++) this.righe[k] = [];
				}
				break;
			}
			case 'S': for (let k = 0; k < a(0); k++) this.righe.push([]); break;
			default: break; // colori (m), margini (r), modi (h, l) e il resto non cambiano il testo
		}
		// la parte visibile segue il cursore quando scende oltre l'altezza
		if (this.r - this.base >= this.altezza) this.base = this.r - this.altezza + 1;
	}
}
