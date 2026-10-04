// Executes the patched upstream formatter, including the native Copy path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { transformSync } = require('../extensions/bottega-home/node_modules/esbuild');
const root = path.join(__dirname, '../vendor/vscode');
const text = fs.readFileSync(path.join(root, 'src/vs/platform/dialogs/electron-browser/dialog.ts'), 'utf8');
const code = transformSync(text, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
const module_ = { exports: {} };
vm.runInNewContext(code, {
  module: module_, exports: module_.exports,
  require: () => ({
    localize: (_key, format, ...args) => format.replace(/\{(\d+)\}/g, (_, n) => String(args[n])),
    fromNow: () => '5 giorni fa', isLinuxSnap: false,
    process: { versions: { electron: '43.7.3', chrome: '150', node: '24', v8: '15' } },
  }),
});
const format = module_.exports.createNativeAboutDialogDetails;
const base = { nameLong: 'Bottega', version: '1.140.0', commit: 'upstream', date: '2026-09-30T10:38:38Z' };
for (const build of [99, 101, 102]) {
  const result = format({ ...base, bottegaVersion: '0.1.1', bottegaBuild: build }, { type: 'Darwin', arch: 'arm64', release: '27' });
  for (const detail of [result.details, result.detailsToCopy]) {
    assert.ok(detail.startsWith(`Versione Bottega: 0.1.1\nBuild: ${build}\n\nBase VS Code\nVersion: 1.140.0`));
    assert.ok(detail.includes('Commit: upstream'));
  }
  assert.ok(result.details.includes('5 giorni fa'));
  assert.ok(!result.detailsToCopy.includes('5 giorni fa'));
}
const fallback = format(base, { type: 'Darwin', arch: 'arm64', release: '27' });
assert.ok(fallback.details.startsWith('Version: 1.140.0'));
assert.ok(!fallback.details.includes('Build: undefined'));
console.log('About: runtime build 99/101/102, native Copy, upstream compatibility and missing metadata PASS');
