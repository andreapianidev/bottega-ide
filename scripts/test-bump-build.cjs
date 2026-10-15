#!/usr/bin/env node
// Run the actual release script in isolated fixtures. Never touch the workspace versions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-version-'));
try {
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'ios'));
  fs.copyFileSync(path.join(__dirname, 'bump-build.sh'), path.join(root, 'scripts/bump-build.sh'));
  for (const extension of ['bottega-home', 'bottega-theme']) {
    fs.mkdirSync(path.join(root, 'extensions', extension), { recursive: true });
    fs.writeFileSync(path.join(root, 'extensions', extension, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  }
  for (const [mac, mobile, expected] of [[95, 98, 99], [98, 95, 99], [99, 99, 100]]) {
    fs.writeFileSync(path.join(root, 'bottega.json'), JSON.stringify({ version: '0.1.0', build: mac }));
    fs.writeFileSync(path.join(root, 'ios/Version.xcconfig'), `CURRENT_PROJECT_VERSION = ${mobile}\n`);
    const result = spawnSync('/bin/zsh', [path.join(root, 'scripts/bump-build.sh'), '0.1.1'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'bottega.json'))).build, expected);
    assert.match(fs.readFileSync(path.join(root, 'ios/Version.xcconfig'), 'utf8'), new RegExp(`CURRENT_PROJECT_VERSION = ${expected}\\n`));
    for (const extension of ['bottega-home', 'bottega-theme']) {
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'extensions', extension, 'package.json'))).version, '0.1.1');
    }
  }
  // Moony AI per iPhone ha la sua versione (quella di Moony AI per Mac), la build resta in comune
  fs.writeFileSync(path.join(root, 'bottega.json'), JSON.stringify({ version: '0.2.0', build: 170 }));
  let r = spawnSync('/bin/zsh', [path.join(root, 'scripts/bump-build.sh'), '--moony', '4.0.1'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  let d = JSON.parse(fs.readFileSync(path.join(root, 'bottega.json')));
  assert.equal(d.version, '0.2.0');
  assert.equal(d.moonyAI, '4.0.1');
  assert.match(fs.readFileSync(path.join(root, 'ios/Version.xcconfig'), 'utf8'), /MARKETING_VERSION = 4\.0\.1\nCURRENT_PROJECT_VERSION = 171\n/);
  // un bump normale la conserva
  r = spawnSync('/bin/zsh', [path.join(root, 'scripts/bump-build.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(root, 'ios/Version.xcconfig'), 'utf8'), /MARKETING_VERSION = 4\.0\.1\nCURRENT_PROJECT_VERSION = 172\n/);
  console.log('Build versions: mobile ahead, Mac ahead, same build, marketing version, Moony AI per iPhone PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
