#!/usr/bin/env node
/**
 * Build statico per Cloudflare Workers + Static Assets.
 *
 * Copia in `dist/` SOLO gli asset pubblici necessari (allowlist esplicita),
 * preservando i percorsi URL esistenti (es. /food/food.json, /admin/, /images/...).
 *
 * Prerequisito: i JSON aggregati devono essere già stati generati
 * (`npm run build:data` → scripts/generate-json.js). Questo script NON
 * rigenera i dati: fallisce se i JSON obbligatori mancano.
 *
 * Esclusi per costruzione (non sono nella allowlist): .git, .github,
 * node_modules, src/ (worker), netlify/, scripts/, lib/, contenuti .md,
 * .env*, documentazione.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

// File il cui nome non deve mai finire in dist (metadati OS/editor)
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);

/** Allowlist: file singoli (path relativi alla root, copiati 1:1 in dist). */
const FILES = [
  // Pagine HTML pubbliche
  'index.html',
  'menu.html',
  'ristoranti.html',
  // JSON aggregati generati da scripts/generate-json.js
  'food/food.json',
  'beers/beers.json',
  'categorie/categorie.json',
  'beverages/beverages.json',
  // Admin CMS (PWA): niente SETUP.md
  'admin/index.html',
  'admin/cms-simple.js',
  'admin/cms-styles.css',
  'admin/manifest.json',
  'admin/sw.js',
  'admin/version.json',
];

/** Allowlist: directory copiate ricorsivamente (path preservati). */
const DIRS = ['css', 'js', 'images'];

/** File di configurazione Cloudflare: sorgente → destinazione in dist. */
const CLOUDFLARE_FILES = [
  ['cloudflare/_headers', '_headers'],
  ['cloudflare/_redirects', '_redirects'],
];

function fail(message) {
  console.error(`\n[build-cloudflare] ERRORE: ${message}`);
  process.exit(1);
}

function safeCleanDist() {
  // Guardia: mai cancellare fuori dalla root del progetto o una dir diversa da "dist"
  if (path.basename(DIST) !== 'dist' || !DIST.startsWith(ROOT + path.sep)) {
    fail(`Percorso dist non sicuro: ${DIST}`);
  }
  if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST, { recursive: true });
}

let copiedCount = 0;
let copiedBytes = 0;

function copyFile(srcAbs, destAbs) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(srcAbs, destAbs);
  copiedCount += 1;
  copiedBytes += fs.statSync(destAbs).size;
}

function copyDirRecursive(srcAbs, destAbs) {
  let count = 0;
  for (const entry of fs.readdirSync(srcAbs, { withFileTypes: true })) {
    if (JUNK_FILES.has(entry.name) || entry.name.startsWith('.')) continue;
    const from = path.join(srcAbs, entry.name);
    const to = path.join(destAbs, entry.name);
    if (entry.isDirectory()) {
      count += copyDirRecursive(from, to);
    } else if (entry.isFile()) {
      copyFile(from, to);
      count += 1;
    }
  }
  return count;
}

function main() {
  console.log('[build-cloudflare] Root:', ROOT);

  // 1. Verifica preventiva: tutti gli asset obbligatori devono esistere
  const missing = [];
  for (const rel of FILES) {
    if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
  }
  for (const rel of DIRS) {
    if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel + '/');
  }
  for (const [srcRel] of CLOUDFLARE_FILES) {
    if (!fs.existsSync(path.join(ROOT, srcRel))) missing.push(srcRel);
  }
  if (missing.length > 0) {
    fail(
      `Asset obbligatori mancanti (hai eseguito "npm run build:data"?):\n  - ${missing.join('\n  - ')}`
    );
  }

  // 2. Pulizia sicura e ricreazione di dist/
  safeCleanDist();

  // 3. Copia file singoli (allowlist)
  const summary = [];
  for (const rel of FILES) {
    copyFile(path.join(ROOT, rel), path.join(DIST, rel));
    summary.push(`  ${rel}`);
  }

  // 4. Copia directory ricorsive (allowlist)
  for (const rel of DIRS) {
    const n = copyDirRecursive(path.join(ROOT, rel), path.join(DIST, rel));
    if (n === 0) fail(`La directory "${rel}/" non contiene file copiabili`);
    summary.push(`  ${rel}/ (${n} file)`);
  }

  // 5. Copia _headers e _redirects nella root di dist
  for (const [srcRel, destRel] of CLOUDFLARE_FILES) {
    copyFile(path.join(ROOT, srcRel), path.join(DIST, destRel));
    summary.push(`  ${destRel} (da ${srcRel})`);
  }

  // 6. Verifica finale: gli asset critici devono esistere in dist
  const critical = ['index.html', 'admin/index.html', 'food/food.json', '_headers'];
  for (const rel of critical) {
    if (!fs.existsSync(path.join(DIST, rel))) {
      fail(`Verifica finale fallita: dist/${rel} mancante`);
    }
  }

  // 7. Riepilogo
  const mb = (copiedBytes / (1024 * 1024)).toFixed(2);
  console.log('[build-cloudflare] Copiati in dist/:');
  console.log(summary.join('\n'));
  console.log(`[build-cloudflare] Totale: ${copiedCount} file, ${mb} MiB`);
  console.log('[build-cloudflare] Build statica completata ✔');
}

main();
