/* Tipi condivisi della sezione 4 del contratto (docs/CONTRATTI.md): regole, radar e siti su Vercel. Una sola definizione,
   importata da regole.ts, radar.ts, briefing.ts ed extension.ts. */

export type Livello = 'rosso' | 'giallo' | 'verde';

/** Un pulsante: `act` e' un messaggio plancia -> estensione, `args` i suoi campi. */
export interface RuleAction {
	act: string;
	label: string;
	args?: Record<string, string>;
}

export interface RuleHit {
	id: 'build' | 'push' | 'remoto' | 'pubblico' | 'rilascio' | 'segreti' | 'app-ads' | 'vercel';
	livello: 'rosso' | 'giallo';
	frase: string;
	rimedio: string;
	azione?: RuleAction;
	dettagli?: string[];
}

export interface ProjectRules {
	path: string;
	livello: Livello;
	hits: RuleHit[];
	checkedAt: number;
}

export interface RulesState {
	projects: Record<string, ProjectRules>;
	global: RuleHit[];
	appAds: { checkedAt: number; identical: boolean; hosts: { host: string; md5: string | null; error?: string }[] } | null;
	counts: { rosso: number; giallo: number; verde: number };
	checkedAt: number;
	running: boolean;
}

export interface RadarApp {
	ascId: string;
	bundleId: string;
	name: string;
	projectPath?: string;
	version?: { string: string; state: string; label: string; tone: 'ok' | 'attesa' | 'male'; build?: string; releaseType?: string; at?: number };
	live?: string;
	reviews: { stars: number; title: string; body: string; territory?: string; at: number }[];
	money?: { yesterday: number; last7: number; daily: number[]; currency: string };
}

export interface RadarState {
	apps: RadarApp[];
	totals: { yesterday: number; last7: number; daily: number[]; currency: string } | null;
	ascAt: number;
	admobAt: number;
	ascError?: string;
	admobError?: string;
	refreshing: boolean;
	/** I siti su Vercel (src/vercel.ts); assente se il radar non legge Vercel. */
	vercel?: VercelState;
}

/** Un sito su Vercel collegato a un progetto: l'ultima pubblicazione di produzione (src/vercel.ts). */
export interface VercelSito {
	projectId: string;
	name: string; // nome del progetto su Vercel
	projectPath: string; // progetto collegato
	via: 'project.json' | 'repo.json' | 'github' | 'nome';
	state: string; // READY, ERROR, BUILDING, INITIALIZING, QUEUED, CANCELED
	label: string; // "pubblicata", "fallita", "in costruzione", "in coda", "annullata"
	tone: 'ok' | 'attesa' | 'male';
	at: number; // quando e' partita
	readyAt?: number;
	domain?: string;
	url: string; // il dettaglio della pubblicazione su vercel.com
	commit?: { sha: string; message: string; ref?: string };
	error?: string; // solo per le fallite
	lastReady?: { at: number; url: string }; // se l'ultima non e' pronta: quella che resta online
}

/** Inventario remoto, inclusi i progetti senza cartella o pubblicazioni. Solo metadati pubblicabili nel ponte. */
export interface VercelProject {
	id: string;
	name: string;
	orgId: string;
	repo?: string;
	framework?: string;
	rootDirectory?: string;
	productionBranch?: string;
	localPaths: string[];
	state: string;
	label: string;
	tone: 'ok' | 'attesa' | 'male';
	at: number;
	domain?: string;
	url: string;
	commit?: { sha: string; message: string; ref?: string };
}

export interface VercelState {
	catalog?: VercelProject[];
	catalogAt?: number;
	catalogError?: string;
	catalogPartial?: boolean;
	sites: VercelSito[];
	at: number; // ultima lettura riuscita, 0 = mai
	error?: string;
	refreshing: boolean;
}
