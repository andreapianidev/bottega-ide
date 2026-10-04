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
