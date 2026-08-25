/**
 * Validazione integrità contenuti markdown del menù.
 * exit 1 se errori critici (no frontmatter, YAML throw)
 * exit 0 se solo warning o tutto ok
 */
const fs = require('fs');
const path = require('path');
const {
  BASE_BEVERAGE_CATEGORIES,
  getCategoryFolder,
  normalizePrice,
  normalizeSlug,
  parseFrontmatter
} = require('../lib/menu-utils');

const ROOT = path.join(__dirname, '..');
const errors = [];
const warnings = [];

const IGNORED_TOP_LEVEL_DIRS = new Set([
  'node_modules',
  'admin',
  'js',
  'css',
  'images',
  'lib',
  'scripts',
  'beverages',
  'categorie',
  '.git'
]);

function loadCategories() {
  const categoriesDir = path.join(ROOT, 'categorie');
  const categories = [];
  if (!fs.existsSync(categoriesDir)) return categories;

  fs.readdirSync(categoriesDir)
    .filter(f => f.endsWith('.md'))
    .forEach(file => {
      const relativePath = path.join('categorie', file);
      try {
        const content = fs.readFileSync(path.join(categoriesDir, file), 'utf8');
        const cat = parseFrontmatter(content);
        if (cat === null) {
          errors.push(`${relativePath}: frontmatter assente`);
          return;
        }
        cat._filename = file;
        categories.push(cat);
      } catch (error) {
        errors.push(`${relativePath}: ${error.message}`);
      }
    });

  return categories;
}

function validateCollectionDir(dirPath, label) {
  if (!fs.existsSync(dirPath)) return;

  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));
  files.forEach(file => {
    const fullPath = path.join(dirPath, file);
    const relativePath = path.relative(ROOT, fullPath);

    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const item = parseFrontmatter(content);

      if (item === null) {
        errors.push(`${relativePath}: frontmatter assente`);
        return;
      }

      if (item.prezzo !== undefined && item.prezzo !== null && item.prezzo !== '') {
        const normalized = normalizePrice(item.prezzo);
        if (normalized === null) {
          warnings.push(`${relativePath}: prezzo non valido "${item.prezzo}"`);
        } else {
          const numeric = Number(normalized);
          if (!Number.isFinite(numeric) || numeric === 0) {
            warnings.push(`${relativePath}: prezzo = ${normalized} (0 o non numerico)`);
          }
        }
      }
    } catch (error) {
      errors.push(`${relativePath}: ${error.message}`);
    }
  });
}

function getReferencedFolders(categories) {
  // Solo folder reali usati dal build (non slug/alias di naming)
  const referenced = new Set(BASE_BEVERAGE_CATEGORIES.map(c => c.folder));

  categories
    .filter(c => c.tipo_menu === 'beverage')
    .forEach(cat => {
      const folder = getCategoryFolder(cat);
      if (folder) referenced.add(folder);
      if (cat.folder) referenced.add(cat.folder);
    });

  // Collection note processate dal build (non orphan)
  referenced.add('beers');
  referenced.add('food');

  return new Set([...referenced].map(f => normalizeSlug(f)).filter(Boolean));
}

function findOrphanBeverageDirs(referencedFolders) {
  let entries;
  try {
    entries = fs.readdirSync(ROOT, { withFileTypes: true });
  } catch {
    return;
  }

  entries.forEach(entry => {
    if (!entry.isDirectory()) return;
    if (entry.name.startsWith('.')) return;
    if (IGNORED_TOP_LEVEL_DIRS.has(entry.name)) return;

    const dirPath = path.join(ROOT, entry.name);
    let hasMd = false;
    try {
      hasMd = fs.readdirSync(dirPath).some(f => f.endsWith('.md'));
    } catch {
      return;
    }
    if (!hasMd) return;

    const folderSlug = normalizeSlug(entry.name);
    if (!referencedFolders.has(folderSlug)) {
      warnings.push(`Directory beverage-like non referenziata da categorie: ${entry.name}/`);
    }
  });
}

// --- main ---
console.log('🔍 Validazione contenuti menù...\n');

const categories = loadCategories();
const referencedFolders = getReferencedFolders(categories);

// Collection processate dal build
const collectionDirs = new Set(['beers', 'food']);
BASE_BEVERAGE_CATEGORIES.forEach(c => collectionDirs.add(c.folder));
categories
  .filter(c => c.tipo_menu === 'beverage')
  .forEach(cat => {
    const folder = getCategoryFolder(cat);
    if (folder) collectionDirs.add(folder);
  });

// Valida categorie già fatto in loadCategories; valida .md nelle collection
collectionDirs.forEach(folder => {
  validateCollectionDir(path.join(ROOT, folder), folder);
});

// Orphan dirs
findOrphanBeverageDirs(referencedFolders);

// Report
console.log('=== REPORT validate-content ===\n');

if (errors.length === 0 && warnings.length === 0) {
  console.log('✅ Nessun problema trovato.');
  process.exit(0);
}

if (errors.length > 0) {
  console.log(`❌ Errori critici (${errors.length}):`);
  errors.forEach(e => console.log(`  - ${e}`));
  console.log('');
}

if (warnings.length > 0) {
  console.log(`⚠️  Warning (${warnings.length}):`);
  warnings.forEach(w => console.log(`  - ${w}`));
  console.log('');
}

if (errors.length > 0) {
  console.log('Risultato: FAIL (errori critici)');
  process.exit(1);
}

console.log('Risultato: OK (solo warning o nessuno)');
process.exit(0);
