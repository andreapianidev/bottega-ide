#!/usr/bin/env node
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

const outfile = path.join(__dirname, 'test-out', 'attivita-sicurezza.js');
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'attivita-sicurezza.ts')], outfile, format: 'cjs', platform: 'node', target: 'node20', logLevel: 'silent' });
const { pulisciAttivita, pulisciTesto } = require(outfile);

assert.equal(pulisciTesto('Controlla il token abcdefgh12345678'), '[contenuto riservato]');
assert.equal(pulisciTesto('Scrivi a nome@example.com'), 'Scrivi a [email]');
const activity = pulisciAttivita({ key: 'cline:1', source: 'cline', id: '1', project: 'Bottega', title: 'Leggi .env', status: 'finito', updatedAt: 1, summary: 'Pronto', steps: ['API_KEY=abcdef'], evidence: 'trascrizione locale' });
assert.equal(activity.title, '[contenuto riservato]');
assert.deepEqual(activity.steps, ['[contenuto riservato]']);
assert.equal(activity.summary, 'Pronto');
console.log('attivita-sicurezza: ok');
