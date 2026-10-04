/** Una sessione osservata da Melissa, indipendente dal programma che la esegue. */
export interface AgentActivity {
	key: string;
	source: 'claude' | 'cline' | 'codex' | 'terminale';
	id: string;
	project: string;
	path?: string;
	title: string;
	status: 'in corso' | 'ti aspetta' | 'finito' | 'errore' | 'sconosciuto';
	updatedAt: number;
	startedAt?: number;
	summary?: string;
	steps?: string[];
	/** Come e' stato ottenuto lo stato: utile per non scambiare un'inferenza per un evento certo. */
	evidence: string;
}

/** I contatori attivi usano il registro osservato; le code restano quelle di Bottega. */
export function conteggiOsservati(activity: readonly AgentActivity[], legacy: import('./jobs').WorkCounts): import('./jobs').WorkCounts {
	const inCorso = activity.filter(a => a.status === 'in corso').length;
	const tiAspetta = activity.filter(a => a.status === 'ti aspetta').length;
	return { ...legacy, inCorso, tiAspetta, vive: inCorso + tiAspetta + legacy.nelTerminale };
}
