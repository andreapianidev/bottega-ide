// Tipi di redact.mjs per chi lo importa da TypeScript (l'estensione bottega-home).
export interface SecretHit { rule: string; index: number; length: number; strong: boolean }
export function findSecrets(text: string): SecretHit[];
export function redact(text: string): string;
export function accenti(text: string): string;
export function undash(text: string): string;
export function clip(text: unknown, n: number): string;
export function cleanPrompt(text: unknown): string;
