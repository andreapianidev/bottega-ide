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
  console.log('Build versions: mobile ahead, Mac ahead, same build, marketing version PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
