#!/usr/bin/env node
'use strict';

/**
 * NexoWatt release guard.
 *
 * This script deliberately has no external dependencies. It can therefore be
 * executed directly with Node.js before npm reads package.json. That matters
 * because an unresolved Git merge conflict inside package.json would prevent
 * every npm lifecycle script from starting.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const excludedDirectories = new Set([
  '.git',
  'node_modules',
  'coverage',
  'dist',
  'build',
]);

const textExtensions = new Set([
  '.cjs', '.cmd', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs',
  '.ps1', '.sh', '.svg', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
]);

const errors = [];
const notices = [];

function relative(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/');
}

function walk(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function isTextFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const baseName = path.basename(filePath);
  return textExtensions.has(extension) || baseName === '.npmignore' || baseName === '.gitignore';
}

function readUtf8(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    errors.push(`${relative(filePath)}: Datei konnte nicht gelesen werden: ${error.message}`);
    return null;
  }
}

function scanMergeConflictMarkers(files) {
  const startMarker = /^\s*<{7}(?:\s|$)/;
  const ancestorMarker = /^\s*\|{7}(?:\s|$)/;
  const endMarker = /^\s*>{7}(?:\s|$)/;

  for (const filePath of files.filter(isTextFile)) {
    const content = readUtf8(filePath);
    if (content === null) {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (startMarker.test(line) || ancestorMarker.test(line) || endMarker.test(line)) {
        errors.push(`${relative(filePath)}:${index + 1}: ungelöster Git-Merge-Konflikt`);
      }
    }
  }
}

function parseJsonFiles(files) {
  const parsed = new Map();

  for (const filePath of files.filter((candidate) => path.extname(candidate).toLowerCase() === '.json')) {
    const content = readUtf8(filePath);
    if (content === null) {
      continue;
    }

    try {
      parsed.set(filePath, JSON.parse(content));
    } catch (error) {
      errors.push(`${relative(filePath)}: ungültiges JSON: ${error.message}`);
    }
  }

  return parsed;
}

function requireParsedJson(parsed, relativePath) {
  const fullPath = path.join(root, relativePath);
  if (!parsed.has(fullPath)) {
    errors.push(`${relativePath}: konnte nicht als gültiges JSON geladen werden`);
    return null;
  }
  return parsed.get(fullPath);
}

function verifyVersions(parsed) {
  const packageJson = requireParsedJson(parsed, 'package.json');
  const ioPackageJson = requireParsedJson(parsed, 'io-package.json');

  if (!packageJson || !ioPackageJson) {
    return;
  }

  const npmVersion = packageJson.version;
  const ioBrokerVersion = ioPackageJson.common?.version;

  if (typeof npmVersion !== 'string' || npmVersion.length === 0) {
    errors.push('package.json: version fehlt oder ist ungültig');
  }

  if (typeof ioBrokerVersion !== 'string' || ioBrokerVersion.length === 0) {
    errors.push('io-package.json: common.version fehlt oder ist ungültig');
  }

  if (npmVersion !== ioBrokerVersion) {
    errors.push(`Versionskonflikt: package.json=${npmVersion ?? '<fehlt>'}, io-package.json=${ioBrokerVersion ?? '<fehlt>'}`);
  } else {
    notices.push(`Versionen synchron: ${npmVersion}`);
  }

  if (packageJson.name !== 'iobroker.nexowatt-devices') {
    errors.push(`package.json: unerwarteter Paketname ${JSON.stringify(packageJson.name)}`);
  }

  if (ioPackageJson.common?.name !== 'nexowatt-devices') {
    errors.push(`io-package.json: unerwarteter Adaptername ${JSON.stringify(ioPackageJson.common?.name)}`);
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifyTemplateCopies() {
  const adminTemplate = path.join(root, 'admin', 'templates.json');
  const runtimeTemplate = path.join(root, 'lib', 'templates.json');

  if (!fs.existsSync(adminTemplate) || !fs.existsSync(runtimeTemplate)) {
    errors.push('admin/templates.json oder lib/templates.json fehlt');
    return;
  }

  const adminHash = sha256(adminTemplate);
  const runtimeHash = sha256(runtimeTemplate);

  if (adminHash !== runtimeHash) {
    errors.push(`Template-Kopien unterscheiden sich: admin=${adminHash}, lib=${runtimeHash}`);
  } else {
    notices.push(`Template-Kopien identisch: ${adminHash.slice(0, 12)}…`);
  }
}

function verifyAliasContractCopies() {
  const adminContract = path.join(root, 'admin', 'alias-contract-v1.json');
  const runtimeContract = path.join(root, 'lib', 'alias-contract-v1.json');

  if (!fs.existsSync(adminContract) || !fs.existsSync(runtimeContract)) {
    errors.push('admin/alias-contract-v1.json oder lib/alias-contract-v1.json fehlt');
    return;
  }

  const adminHash = sha256(adminContract);
  const runtimeHash = sha256(runtimeContract);
  if (adminHash !== runtimeHash) {
    errors.push(`Alias-Contract-Kopien unterscheiden sich: admin=${adminHash}, lib=${runtimeHash}`);
  } else {
    notices.push(`Alias Contract v1 identisch: ${adminHash.slice(0, 12)}…`);
  }
}

function verifyAliasContract(parsed) {
  const contract = requireParsedJson(parsed, 'lib/alias-contract-v1.json');
  const templatesDoc = requireParsedJson(parsed, 'lib/templates.json');
  if (!contract || !templatesDoc) return;

  if (contract.contractId !== 'nexowatt-device-alias-contract') {
    errors.push(`lib/alias-contract-v1.json: unerwartete contractId ${JSON.stringify(contract.contractId)}`);
  }
  if (contract.schemaVersion !== 1 || contract.namespace !== 'v1') {
    errors.push('lib/alias-contract-v1.json: schemaVersion=1 und namespace="v1" sind erforderlich');
  }
  if (contract.status !== 'stable') {
    errors.push('lib/alias-contract-v1.json: status muss "stable" sein');
  }
  if (contract.standardPath !== 'aliases.v1' || contract.metadataPath !== 'aliases.meta') {
    errors.push('lib/alias-contract-v1.json: standardPath/metadataPath sind ungültig');
  }
  if (contract.legacyAliasesPreserved !== true) {
    errors.push('lib/alias-contract-v1.json: legacyAliasesPreserved muss true sein');
  }

  const categoryMap = contract.categoryToDeviceClass || {};
  const deviceClasses = contract.deviceClasses || {};
  const templates = Array.isArray(templatesDoc.templates) ? templatesDoc.templates : [];
  if (!templates.length) {
    errors.push('lib/templates.json: templates fehlt oder ist leer');
    return;
  }

  const ids = new Set();
  const classCounts = new Map();
  for (const template of templates) {
    const id = String(template && template.id || '');
    if (!id) {
      errors.push('lib/templates.json: Template ohne id gefunden');
      continue;
    }
    if (ids.has(id)) errors.push(`lib/templates.json: doppelte Template-ID ${id}`);
    ids.add(id);

    const category = String(template.category || '').toUpperCase();
    const expectedClass = categoryMap[category] || 'generic';
    const meta = template.aliasContract || {};
    if (meta.schemaVersion !== 1 || meta.namespace !== 'v1' || meta.deviceClass !== expectedClass) {
      errors.push(`${id}: aliasContract muss {schemaVersion:1, namespace:"v1", deviceClass:"${expectedClass}"} sein`);
    }
    if (!deviceClasses[expectedClass]) {
      errors.push(`${id}: deviceClass ${expectedClass} ist im Alias Contract nicht definiert`);
    }
    classCounts.set(expectedClass, (classCounts.get(expectedClass) || 0) + 1);
  }

  const common = contract.common || {};
  const lookupSpec = (deviceClass, aliasPath) => {
    const required = common.required || {};
    const optional = common.optional || {};
    if (required[aliasPath] || optional[aliasPath]) return required[aliasPath] || optional[aliasPath];
    const classDef = deviceClasses[deviceClass] || {};
    return (classDef.required || {})[aliasPath] || (classDef.optional || {})[aliasPath] || null;
  };

  for (const [deviceClass, aliases] of Object.entries(contract.pathAliases || {})) {
    if (!deviceClasses[deviceClass]) {
      errors.push(`Alias Contract pathAliases: unbekannte deviceClass ${deviceClass}`);
      continue;
    }
    for (const [sourcePath, targetPath] of Object.entries(aliases || {})) {
      if (!sourcePath || !targetPath || !lookupSpec(deviceClass, targetPath)) {
        errors.push(`Alias Contract pathAliases ${deviceClass}: ungültige Zuordnung ${sourcePath} -> ${targetPath}`);
      }
    }
  }

  const validateSpecMap = (scope, specMap) => {
    for (const [aliasPath, spec] of Object.entries(specMap || {})) {
      if (!spec || typeof spec !== 'object') {
        errors.push(`Alias Contract ${scope}.${aliasPath}: Definition fehlt`);
        continue;
      }
      for (const key of ['type', 'role', 'capability']) {
        if (typeof spec[key] !== 'string' || !spec[key]) {
          errors.push(`Alias Contract ${scope}.${aliasPath}: ${key} fehlt`);
        }
      }
    }
  };
  validateSpecMap('common.required', common.required);
  validateSpecMap('common.optional', common.optional);
  for (const [deviceClass, classDef] of Object.entries(deviceClasses)) {
    validateSpecMap(`${deviceClass}.required`, classDef.required);
    validateSpecMap(`${deviceClass}.optional`, classDef.optional);
    for (const pattern of classDef.patterns || []) {
      try { new RegExp(pattern.pattern); } catch (error) {
        errors.push(`Alias Contract ${deviceClass}: ungültiges Pattern ${JSON.stringify(pattern.pattern)} (${error.message})`);
      }
    }
  }

  const counts = Object.fromEntries([...classCounts.entries()].sort());
  notices.push(`${templates.length} Templates mit Alias Contract v1 klassifiziert: ${JSON.stringify(counts)}`);
}


function verifyTestManifest(parsed) {
  const manifest = requireParsedJson(parsed, 'test/test-manifest.json');
  const packageJson = requireParsedJson(parsed, 'package.json');
  if (!manifest || !packageJson) return;

  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.tests) || manifest.tests.length === 0) {
    errors.push('test/test-manifest.json: schemaVersion=1 und eine nichtleere tests-Liste sind erforderlich');
    return;
  }
  if (manifest.suiteVersion !== packageJson.version) {
    errors.push(`test/test-manifest.json: suiteVersion=${manifest.suiteVersion ?? '<fehlt>'} passt nicht zu package.json=${packageJson.version}`);
  }
  if (packageJson.scripts?.test !== 'node scripts/run-tests.cjs') {
    errors.push('package.json: npm test muss über scripts/run-tests.cjs ausgeführt werden');
  }

  const listed = [];
  const seen = new Set();
  for (const item of manifest.tests) {
    const name = String(item || '');
    if (!/^[A-Za-z0-9._-]+\.test\.js$/.test(name)) {
      errors.push(`test/test-manifest.json: ungültiger Testdateiname ${JSON.stringify(item)}`);
      continue;
    }
    if (seen.has(name)) errors.push(`test/test-manifest.json: doppelte Testdatei ${name}`);
    seen.add(name);
    listed.push(name);
    if (!fs.existsSync(path.join(root, 'test', name))) {
      errors.push(`test/${name}: im Testmanifest aufgeführt, Datei fehlt`);
    }
  }

  const actual = fs.readdirSync(path.join(root, 'test'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => entry.name)
    .sort();
  const expected = [...listed].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const extra = actual.filter((name) => !expected.includes(name));
    const missing = expected.filter((name) => !actual.includes(name));
    if (extra.length) {
      errors.push(
        `test/: alte oder fremde Testdateien gefunden: ${extra.join(', ')}. ` +
        'Der Projektordner wurde wahrscheinlich über eine ältere Version kopiert. Ordner löschen und die ZIP sauber neu entpacken.'
      );
    }
    if (missing.length) errors.push(`test/: Testdateien aus Manifest fehlen: ${missing.join(', ')}`);
  } else {
    notices.push(`${expected.length} freigegebene Testdateien; keine alten Mischdateien im test/-Ordner`);
  }
}

function verifyCompatibilityFixture(parsed) {
  const fixture = requireParsedJson(parsed, 'test/fixtures/legacy-compatibility-v0.5.143.json');
  const templatesDoc = requireParsedJson(parsed, 'lib/templates.json');
  if (!fixture || !templatesDoc) return;

  const templates = Array.isArray(templatesDoc.templates) ? templatesDoc.templates : [];
  if (fixture.baselineAdapterVersion !== '0.5.143') {
    errors.push('test/fixtures/legacy-compatibility-v0.5.143.json: falsche baselineAdapterVersion');
  }
  if (fixture.templateCount !== templates.length) {
    errors.push(`Legacy-Kompatibilitätsfixture: templateCount=${fixture.templateCount} statt ${templates.length}`);
  }
  const fixtureTemplates = fixture.templates || {};
  for (const template of templates) {
    const entry = fixtureTemplates[template.id];
    if (!entry) {
      errors.push(`${template.id}: fehlt im Legacy-Kompatibilitätsfixture`);
      continue;
    }
    for (const key of ['templateHash', 'hash']) {
      if (!/^[0-9a-f]{64}$/.test(String(entry[key] || ''))) {
        errors.push(`${template.id}: ungültiger ${key} im Legacy-Kompatibilitätsfixture`);
      }
    }
    if (!Number.isInteger(entry.datapointCount) || !Number.isInteger(entry.count)) {
      errors.push(`${template.id}: ungültige Zähler im Legacy-Kompatibilitätsfixture`);
    }
  }
  const unknown = Object.keys(fixtureTemplates).filter((id) => !templates.some((template) => template.id === id));
  if (unknown.length) errors.push(`Legacy-Kompatibilitätsfixture enthält unbekannte Templates: ${unknown.join(', ')}`);
  notices.push(`Legacy-Kompatibilitätsbaseline 0.5.143 für ${Object.keys(fixtureTemplates).length} Templates geladen`);
}

function verifyJavaScriptSyntax(files) {
  const javaScriptFiles = files.filter((filePath) => ['.js', '.cjs', '.mjs'].includes(path.extname(filePath).toLowerCase()));

  for (const filePath of javaScriptFiles) {
    const result = spawnSync(process.execPath, ['--check', filePath], {
      cwd: root,
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || 'unbekannter Syntaxfehler').trim();
      errors.push(`${relative(filePath)}: JavaScript-Syntaxprüfung fehlgeschlagen\n${detail}`);
    }
  }

  notices.push(`${javaScriptFiles.length} JavaScript-Dateien syntaktisch geprüft`);
}

function verifyRequiredFiles() {
  const requiredFiles = [
    'package.json',
    'io-package.json',
    'main.js',
    'bootstrap.js',
    'admin/templates.json',
    'admin/alias-contract-v1.json',
    'lib/templates.json',
    'lib/alias-contract-v1.json',
    'lib/aliasContract.js',
    'scripts/run-tests.cjs',
    'test/test-manifest.json',
    'test/fixtures/legacy-compatibility-v0.5.143.json',
    'test/helpers/compatibilityHarness.cjs',
    'test/legacyCompatibility.test.js',
    'test/writeErrorHandling.test.js',
    'README.md',
    'LICENSE',
  ];

  for (const relativePath of requiredFiles) {
    if (!fs.existsSync(path.join(root, relativePath))) {
      errors.push(`${relativePath}: Pflichtdatei fehlt`);
    }
  }
}

function verifyDocumentationLayout(parsed) {
  const docsDirectory = path.join(root, 'docs');
  if (!fs.existsSync(docsDirectory) || !fs.statSync(docsDirectory).isDirectory()) {
    errors.push('docs/: Dokumentationsordner fehlt');
    return;
  }

  const rootMarkdownFiles = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.md')
    .map((entry) => entry.name)
    .sort();

  const unexpectedRootMarkdown = rootMarkdownFiles.filter((name) => name !== 'README.md');
  if (unexpectedRootMarkdown.length > 0) {
    errors.push(`Markdown-Dateien gehören nach docs/: ${unexpectedRootMarkdown.join(', ')}`);
  } else {
    notices.push('Dokumentationslayout sauber: im Projektstamm liegt nur README.md');
  }

  const requiredDocumentation = [
    'docs/README.md',
    'docs/CHANGELOG.md',
    'docs/ALIAS_CONTRACT_V1_0.5.144.md',
    'docs/LEGACY_COMPATIBILITY_0.5.146.md',
    'docs/RELEASE_SAFETY.md',
    'docs/THIRD_PARTY_NOTICES.md',
  ];
  for (const relativePath of requiredDocumentation) {
    if (!fs.existsSync(path.join(root, relativePath))) {
      errors.push(`${relativePath}: Dokumentationsdatei fehlt`);
    }
  }

  const readmePath = path.join(root, 'README.md');
  if (fs.existsSync(readmePath)) {
    const content = readUtf8(readmePath);
    const firstContentLine = content === null
      ? ''
      : content.split(/\r?\n/).find((line) => line.trim().length > 0) || '';
    if (!/^#\s+nexowatt-devices\b/i.test(firstContentLine.trim())) {
      errors.push('README.md: Die Adapterübersicht muss direkt mit der Hauptüberschrift beginnen');
    }
  }

  const packageJson = requireParsedJson(parsed, 'package.json');
  if (!packageJson) return;
  const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
  if (!packageFiles.includes('docs/')) {
    errors.push('package.json: files muss den Ordner docs/ enthalten');
  }

  const rootMarkdownEntries = packageFiles.filter((entry) =>
    typeof entry === 'string' && entry.toLowerCase().endsWith('.md') && entry !== 'README.md'
  );
  if (rootMarkdownEntries.length > 0) {
    errors.push(`package.json: technische Markdown-Dateien einzeln eingetragen: ${rootMarkdownEntries.join(', ')}`);
  }
}

function main() {
  console.log('NexoWatt Release Guard');
  console.log(`Projekt: ${root}`);

  const files = walk(root);
  verifyRequiredFiles();
  scanMergeConflictMarkers(files);
  const parsedJson = parseJsonFiles(files);
  verifyVersions(parsedJson);
  verifyDocumentationLayout(parsedJson);
  verifyTemplateCopies();
  verifyAliasContractCopies();
  verifyAliasContract(parsedJson);
  verifyTestManifest(parsedJson);
  verifyCompatibilityFixture(parsedJson);

  const packageJsonPath = path.join(root, 'package.json');
  if (parsedJson.has(packageJsonPath)) {
    verifyJavaScriptSyntax(files);
  } else {
    notices.push('JavaScript-Syntaxprüfung übersprungen, weil package.json ungültig ist');
  }

  for (const notice of notices) {
    console.log(`OK  ${notice}`);
  }

  if (errors.length > 0) {
    console.error(`\nABBRUCH: ${errors.length} Release-Fehler gefunden:`);
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`\nFREIGABE: ${files.length} Projektdateien geprüft, keine Release-Blocker gefunden.`);
}

main();
