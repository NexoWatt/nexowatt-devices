'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function extractPackReport(output) {
  for (let start = output.indexOf('['); start >= 0; start = output.indexOf('[', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const char = output[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '[') depth += 1;
      else if (char === ']') {
        depth -= 1;
        if (depth === 0) {
          try {
            const value = JSON.parse(output.slice(start, index + 1));
            if (Array.isArray(value) && Array.isArray(value[0]?.files)) return value;
          } catch { /* keep scanning */ }
          break;
        }
      }
    }
  }
  throw new Error(`npm pack JSON report not found in output:\n${output}`);
}

test('release checks tolerate harmless files from an older Windows worktree without executing or publishing them', { timeout: 60_000 }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexowatt-dirty-worktree-'));
  const project = path.join(tempRoot, 'nexowatt-devices');

  try {
    fs.cpSync(root, project, {
      recursive: true,
      filter(source) {
        const name = path.basename(source);
        return name !== 'node_modules' && name !== '.git';
      },
    });

    // Reproduce the exact class of leftovers reported from the Windows folder.
    for (const name of ['CHANGELOG.md', 'NEXOWATT_REVIEW.md', 'README.de.md']) {
      fs.writeFileSync(path.join(project, name), `# local legacy file: ${name}\n`);
    }
    fs.writeFileSync(
      path.join(project, 'test', 'core.test.js'),
      "'use strict';\nconst test = require('node:test');\ntest('must never run', () => { throw new Error('foreign test executed'); });\n",
    );

    // Keep the nested test run small and prevent this isolation test from
    // recursively copying itself. The extra test sources remain in place.
    const manifestPath = path.join(project, 'test', 'test-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.tests = ['writeErrorHandling.test.js'];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const guard = run(process.execPath, ['scripts/release-guard.cjs'], project);
    assert.equal(guard.status, 0, `${guard.stdout}\n${guard.stderr}`);
    assert.match(guard.stdout, /Lokale zusätzliche Markdown-Dateien ignoriert/);
    assert.match(guard.stdout, /Lokale zusätzliche Testdateien ignoriert:[^\n]*core\.test\.js/);

    const approvedTests = run(process.execPath, ['scripts/run-tests.cjs'], project);
    assert.equal(approvedTests.status, 0, `${approvedTests.stdout}\n${approvedTests.stderr}`);
    assert.doesNotMatch(`${approvedTests.stdout}\n${approvedTests.stderr}`, /foreign test executed/);

    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const packed = run(npmCommand, ['pack', '--dry-run', '--json'], project);
    assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
    const result = extractPackReport(packed.stdout);
    const files = (result[0]?.files || []).map((entry) => String(entry.path).replaceAll('\\', '/'));

    for (const forbidden of ['CHANGELOG.md', 'NEXOWATT_REVIEW.md', 'README.de.md', 'test/core.test.js']) {
      assert.equal(files.includes(forbidden), false, `${forbidden} leaked into npm package`);
    }
    assert.ok(files.includes('README.md'));
    assert.ok(files.includes('docs/CHANGELOG.md'));

    // postpack must put the user's local files back immediately.
    for (const name of ['CHANGELOG.md', 'NEXOWATT_REVIEW.md', 'README.de.md']) {
      assert.ok(fs.existsSync(path.join(project, name)), `${name} was not restored after pack`);
    }
    assert.equal(fs.existsSync(path.join(project, '.nexowatt-release-local', 'manifest.json')), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
