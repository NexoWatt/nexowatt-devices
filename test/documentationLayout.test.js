'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('technical Markdown documentation is grouped under docs and the root overview stays visible', () => {
  const rootMarkdown = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.md')
    .map(entry => entry.name)
    .sort();

  assert.deepEqual(rootMarkdown, ['README.md']);

  for (const relativePath of [
    'docs/README.md',
    'docs/CHANGELOG.md',
    'docs/ALIAS_CONTRACT_V1_0.5.144.md',
    'docs/LEGACY_COMPATIBILITY_0.5.146.md',
    'docs/RELEASE_SAFETY.md',
    'docs/THIRD_PARTY_NOTICES.md',
  ]) {
    assert.ok(fs.existsSync(path.join(root, relativePath)), `missing ${relativePath}`);
  }

  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /^#\s+nexowatt-devices\b/i);
  assert.match(readme, /\[Dokumentationsübersicht\]\(docs\/README\.md\)/);

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('docs/'));
  assert.equal(pkg.files.includes('publish-safe.cmd'), false);

  const npmIgnore = fs.readFileSync(path.join(root, '.npmignore'), 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  assert.ok(npmIgnore.includes('publish-safe.cmd'));
  assert.deepEqual(
    pkg.files.filter(entry => entry.toLowerCase().endsWith('.md')),
    ['README.md']
  );
});
