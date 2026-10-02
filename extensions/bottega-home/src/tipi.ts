/* Tipi condivisi della sezione 4 del contratto (docs/CONTRATTI.md): regole e radar. Una sola definizione,
   importata da regole.ts, radar.ts, briefing.ts ed extension.ts. */

export type Livello = 'rosso' | 'giallo' | 'verde';

/** Un pulsante: `act` e' un messaggio plancia -> estensione, `args` i suoi campi. */
export interface RuleAction {
	act: string;
	label: string;
	args?: Record<string, string>;
}

export interface RuleHit {
	id: 'build' | 'push' | 'remoto' | 'pubblico' | 'rilascio' | 'segreti' | 'app-ads';
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
}
