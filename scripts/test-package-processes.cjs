#!/usr/bin/env node
// Run the actual pre-copy shutdown block against fake process commands, including
// macOS pgrep's ancestor exclusion. No applications are opened, signaled or closed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(process.env.BOTTEGA_PACKAGE_SOURCE || path.join(__dirname, 'package.sh'), 'utf8');
const start = source.indexOf('\nWAS_RUNNING=0\n');
const end = source.indexOf('\nsource "$ROOT/scripts/widget-lifecycle.sh"', start);
assert.ok(start > 0 && end > start);
const block = source.slice(start, end);
const preamble = `
set -euo pipefail
typeset -i alive=1 ancestor=1 waits=0 terms=0 quits=0
[[ $MOCK_MODE == absent ]] && alive=0
pgrep() {
  local all=0 pattern="\${@[-1]}" arg
  for arg in "$@"; do [[ $arg == -a ]] && all=1; done
  (( alive && (!ancestor || all) )) || return 1
  [[ $MOCK_PROCESS =~ $pattern ]]
}
pkill() {
  local all=0 arg pattern="\${@[-1]}"
  for arg in "$@"; do [[ $arg == -a ]] && all=1; done
  (( !ancestor || all )) || return 1
  [[ $MOCK_PROCESS =~ $pattern ]] || return 1
  (( terms += 1 ))
  [[ $MOCK_MODE == term ]] && alive=0
  return 0
}
osascript() {
  (( quits += 1 ))
  [[ $MOCK_MODE == graceful ]] && alive=0
  return 0
}
sleep() { (( waits += 1 )); }
`;
function run(mode, executable = '/Applications/Bottega.app/Contents/MacOS/Bottega') {
	return spawnSync('/bin/zsh', ['-f'], { encoding: 'utf8',
		env: { ...process.env, MOCK_MODE: mode, MOCK_PROCESS: executable },
		input: `${preamble}\n${block}\nprint -r -- "COPY:$WAS_RUNNING:$alive:$quits:$terms:$waits"\n` });
}
for (const [mode, expected] of [
	['absent', 'COPY:0:0:0:0:0'],
	['graceful', 'COPY:1:0:1:1:0'],
	['term', 'COPY:1:0:1:1:30'],
]) {
	const result = run(mode); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), expected);
}
const stubborn = run('stubborn');
assert.notEqual(stubborn.status, 0); assert.ok(stubborn.stderr.includes('ancora aperta')); assert.ok(!stubborn.stdout.includes('COPY:'));
for (const executable of [
	'/Applications/Bottega.app/Contents/Frameworks/Bottega Helper.app/Contents/MacOS/Bottega Helper',
	'/tmp/Applications/Bottega.app/Contents/MacOS/Bottega',
	'/Applications/BottegaXapp/Contents/MacOS/Bottega',
	'/Applications/Bottega.app/Contents/MacOS/BottegaOther',
]) {
	const other = run('stubborn', executable);
	assert.equal(other.status, 0, other.stderr); assert.equal(other.stdout.trim(), 'COPY:0:1:0:0:0');
}
const withArguments = run('term', '/Applications/Bottega.app/Contents/MacOS/Bottega --fixture');
assert.equal(withArguments.status, 0); assert.equal(withArguments.stdout.trim(), 'COPY:0:0:1:1:30');
console.log('Package processes: ancestor, graceful quit, TERM, abort, exact scope and argument handling PASS');
