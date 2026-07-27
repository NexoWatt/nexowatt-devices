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
    'lib/templates.json',
    'README.md',
    'LICENSE',
  ];

  for (const relativePath of requiredFiles) {
    if (!fs.existsSync(path.join(root, relativePath))) {
      errors.push(`${relativePath}: Pflichtdatei fehlt`);
    }
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
  verifyTemplateCopies();

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
