import type { AgentActivity } from './attivita-tipi';

const RISERVATO = /\b(?:api[ _-]?key|secret|token|password|passwd|credenzial[ei]|chiave|bearer|authorization|private[ _-]?key)\b|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|[A-Za-z0-9+/_-]{40,})\b|\.env\b|-----BEGIN [^-]*PRIVATE KEY-----/i;

/** La Home e i cervelli ricevono solo metadati brevi; una riga sensibile viene omessa interamente. */
export function pulisciTesto(raw: unknown, max = 180): string {
	if (typeof raw !== 'string') return '';
	const line = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
	if (!line) return '';
	if (RISERVATO.test(line) || /:\/\/[^\s/@]+:[^\s/@]+@/.test(line) || /\bexport\s+\w+\s*=/.test(line)) return '[contenuto riservato]';
	const clean = line.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]');
	return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
}

export function pulisciAttivita(item: AgentActivity): AgentActivity {
	const evidence = item.source === 'cline' && item.evidence.startsWith('Cline SDK:')
		? 'Cline SDK: metadati e messaggi locali'
		: item.source === 'cline' && item.evidence.startsWith('Cline legacy:')
			? 'Cline: cronologia locale dei task'
			: item.evidence;
	return {
		...item,
		project: pulisciTesto(item.project, 80) || 'Progetto sconosciuto',
		title: pulisciTesto(item.title, 160) || 'Sessione',
		...(item.summary ? { summary: pulisciTesto(item.summary, 220) } : {}),
		...(item.steps ? { steps: item.steps.slice(-8).map(s => pulisciTesto(s, 120)).filter(Boolean) } : {}),
		evidence: pulisciTesto(evidence, 180),
	};
}
