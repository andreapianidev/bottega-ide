/* Live rules bridge for the native Metal Vedetta. The SVG room in the Home keeps its
   own rendering; both surfaces receive the same project and rule state. */
import type { RulesState } from './tipi';

export interface VedettaProject {
	path: string;
	name: string;
}

export interface VedettaNucleo {
	readonly available: boolean;
	request<T = any>(cmd: string, args?: Record<string, any>, timeoutMs?: number): Promise<T>;
	fireAndForget(cmd: string, args?: Record<string, any>): void;
	on(event: string, handler: (...args: any[]) => void): any;
}

/** Unknown is deliberately separate from green until the rules have been checked. */
export function datiVedetta(projects: VedettaProject[], rules?: RulesState) {
	return {
		projects: projects.map(p => {
			const result = rules?.projects[p.path];
			return {
				path: p.path,
				name: p.name,
				livello: result?.checkedAt ? result.livello : 'sconosciuto',
				hits: result?.hits ?? [],
				checkedAt: result?.checkedAt ?? 0,
			};
		}),
		global: rules?.global ?? [],
		checkedAt: rules?.checkedAt ?? 0,
		running: rules?.running ?? false,
	};
}

export class VedettaNativa {
	private open = false;
	private lastSignature = '';

	constructor(
		private readonly nucleo: VedettaNucleo,
		private readonly data: () => ReturnType<typeof datiVedetta>,
		private readonly onProject: (path: string) => void,
		private readonly onRefresh: () => void,
	) {
		nucleo.on('vedetta.ready', () => { this.open = true; this.push(true); });
		nucleo.on('vedetta.closed', () => { this.open = false; });
		nucleo.on('vedetta.project', (event: { path?: string }) => {
			if (typeof event.path === 'string') this.onProject(event.path);
		});
		nucleo.on('vedetta.refresh', () => this.onRefresh());
		nucleo.on('down', () => { this.open = false; this.lastSignature = ''; });
	}

	async show(): Promise<void> {
		if (!this.nucleo.available) throw new Error('Il Nucleo nativo non è acceso: non posso aprire la Vedetta Metal.');
		const data = this.data();
		this.lastSignature = JSON.stringify(data);
		await this.nucleo.request('vedetta.open', { data }, 15_000);
		this.open = true;
	}

	push(force = false): void {
		if (!this.open || !this.nucleo.available) return;
		const data = this.data();
		const signature = JSON.stringify(data);
		if (!force && signature === this.lastSignature) return;
		this.lastSignature = signature;
		this.nucleo.fireAndForget('vedetta.data', { data });
	}
}
