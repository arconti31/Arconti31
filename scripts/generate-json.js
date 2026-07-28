const fs = require('fs');
const path = require('path');
const {
  BASE_BEVERAGE_CATEGORIES,
  getFilenameBase,
  getCategoryFolder,
  normalizePrice,
  normalizeSlug,
  parseFrontmatter
} = require('../lib/menu-utils');
const { compareMenuItems } = require('../js/menu-order');
const { cleanupOrphanRumDir } = require('./_merge-rum-cleanup');

const ROOT = path.join(__dirname, '..');
const buildErrors = [];
const buildWarnings = [];

// DATA-001: merge legacy i-nostri-rum/ → i-nostri-rhum/ (cleanup cartella orfana)
cleanupOrphanRumDir();

// Processa categorie dinamiche PRIMA di tutto
function loadCategories() {
  const categoriesDir = path.join(ROOT, 'categorie');
  const categories = [];
  
  if (fs.existsSync(categoriesDir)) {
    const files = fs.readdirSync(categoriesDir).filter(f => f.endsWith('.md'));
    
    files.forEach(file => {
      try {
        const content = fs.readFileSync(path.join(categoriesDir, file), 'utf8');
        const cat = parseFrontmatter(content);
        if (cat === null) {
          const msg = `categorie/${file}: frontmatter assente`;
          console.error(msg);
          buildErrors.push(msg);
          return;
        }
        cat._filename = file;
        // INCLUDE TUTTE LE CATEGORIE nel JSON
        // Il filtro visibile deve essere fatto dal frontend (app.js), non qui.
        // Altrimenti il CMS non vede le categorie nascoste e non può riattivarle.
        categories.push(cat);
      } catch (error) {
        console.error(`Errore nel processare categoria ${file}:`, error.message);
        buildErrors.push(`categorie/${file}: ${error.message}`);
      }
    });
  }
  
  // Ordine canonico: order, poi filename per i pareggi.
  categories.sort(compareMenuItems);
  return categories;
}

const dynamicCategories = loadCategories();
console.log(`📁 Caricate ${dynamicCategories.length} categorie dinamiche`);

function getCategoryAliases(category = {}) {
  const aliases = new Set();
  [category.nome, category.slug, category.folder, getFilenameBase(category._filename)].forEach(value => {
    const normalizedValue = normalizeSlug(value);
    if (normalizedValue) aliases.add(normalizedValue);
  });
  return [...aliases];
}

function findCategoryByReference(categories = [], value, typeMenu = null) {
  const normalizedValue = normalizeSlug(value);
  if (!normalizedValue) return null;

  return categories.find(category =>
    (!typeMenu || category.tipo_menu === typeMenu) &&
    getCategoryAliases(category).includes(normalizedValue)
  ) || null;
}

function applyNormalizedPrice(item, relativePath) {
  if (item.prezzo === undefined || item.prezzo === null || item.prezzo === '') {
    return;
  }

  const normalized = normalizePrice(item.prezzo);
  if (normalized === null) {
    buildWarnings.push(`${relativePath}: prezzo non valido "${item.prezzo}"`);
    item.prezzo = String(item.prezzo);
    return;
  }

  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || numeric === 0) {
    buildWarnings.push(`${relativePath}: prezzo = ${normalized} (0 o non numerico)`);
  }

  item.prezzo = normalized;
}

function processCollection(dirPath, itemType) {
  const items = [];
  
  if (fs.existsSync(dirPath)) {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));
    
    files.forEach(file => {
      const fullPath = path.join(dirPath, file);
      const relativePath = path.relative(ROOT, fullPath);
      try {
        const content = fs.readFileSync(fullPath, 'utf8');

        const item = parseFrontmatter(content);
        if (item === null) {
          const msg = `${relativePath}: frontmatter assente`;
          console.error(msg);
          buildErrors.push(msg);
          return;
        }

        item._filename = file;
        applyNormalizedPrice(item, relativePath);
        items.push(item);
      } catch (error) {
        console.error(`Errore nel processare ${file}:`, error.message);
        buildErrors.push(`${relativePath}: ${error.message}`);
      }
    });
  }
  
  // Ordine canonico: indipendente dall'ordine di fs.readdirSync.
  items.sort(compareMenuItems);
  
  return items;
}

// Directory di sistema / non-collection da escludere dalla scansione orphan
const IGNORED_TOP_LEVEL_DIRS = new Set([
  'node_modules',
  'admin',
  'js',
  'css',
  'images',
  'lib',
  'scripts',
  'netlify',
  'beverages',
  'categorie',
  'beers',
  'food',
  '.git',
  '.netlify'
]);

/**
 * Warning per directory top-level che contengono .md (sembrano collection beverage)
 * ma non sono referenziate da alcuna categoria folder.
 */
function warnOrphanBeverageDirs(referencedFolders) {
  let entries;
  try {
    entries = fs.readdirSync(ROOT, { withFileTypes: true });
  } catch {
    return;
  }

  const referenced = new Set(
    [...referencedFolders].map(f => normalizeSlug(f)).filter(Boolean)
  );

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
    if (!referenced.has(folderSlug)) {
      const msg = `Directory beverage-like non referenziata da categorie: ${entry.name}/`;
      console.warn(`⚠️  ${msg}`);
      buildWarnings.push(msg);
    }
  });
}

// Processa birre
const beersDir = path.join(ROOT, 'beers');
const beers = processCollection(beersDir, 'beer');
const beverageCategoriesList = dynamicCategories.filter(c => c.tipo_menu === 'beverage');

beers.forEach(beer => {
  const match = findCategoryByReference(beverageCategoriesList, beer.sezione, 'beverage');
  if (match) {
    beer.sezione = match.nome;
    beer.sezione_slug = normalizeSlug(beer.sezione_slug || match.slug || match.nome);
  } else if (beer.sezione_slug) {
    beer.sezione_slug = normalizeSlug(beer.sezione_slug);
  }
});

// Raggruppa birre per sezione
const beersBySection = {};
beers.forEach(beer => {
  const section = beer.sezione || 'Birre alla spina';
  if (!beersBySection[section]) {
    beersBySection[section] = [];
  }
  beersBySection[section].push(beer);
});

// Processa food (NUOVO)
const foodDir = path.join(ROOT, 'food');
const foodItems = processCollection(foodDir, 'food');
const foodCategoriesList = dynamicCategories.filter(c => c.tipo_menu === 'food');

foodItems.forEach(item => {
  const match = findCategoryByReference(foodCategoriesList, item.category, 'food');
  if (match) {
    item.category = match.nome;
    item.category_slug = normalizeSlug(item.category_slug || match.slug || match.nome);
  } else if (item.category_slug) {
    item.category_slug = normalizeSlug(item.category_slug);
  }
});

// Raggruppa food per categoria
const foodByCategory = {};

// Prima inizializza tutte le categorie food dinamiche (anche vuote)
dynamicCategories
  .filter(c => c.tipo_menu === 'food')
  .forEach(cat => {
    foodByCategory[cat.nome] = [];
  });

// Poi aggiungi i piatti
foodItems.forEach(item => {
  const category = item.category || 'Altro';
  if (!foodByCategory[category]) {
    foodByCategory[category] = [];
  }
  foodByCategory[category].push(item);
});

// Ordina le categorie secondo l'ordine definito nelle categorie dinamiche
const foodCategoryOrder = {};
dynamicCategories
  .filter(c => c.tipo_menu === 'food')
  .forEach((cat, idx) => {
    foodCategoryOrder[cat.nome] = cat.order || idx;
  });


// Processa tutte le categorie di bevande (hardcoded + dinamiche da categorie/*.md)

// Discover dynamic beverage folders from categories
const knownFolders = new Set(BASE_BEVERAGE_CATEGORIES.map(c => c.folder));
const allBeverageFolders = BASE_BEVERAGE_CATEGORIES.map(category => ({
  ...category,
  slug: category.folder
}));

dynamicCategories
  .filter(c => c.tipo_menu === 'beverage')
  .forEach(cat => {
    const folder = getCategoryFolder(cat);
    if (folder && !knownFolders.has(folder)) {
      allBeverageFolders.push({ name: cat.nome, folder, slug: normalizeSlug(cat.slug || cat.nome) });
      knownFolders.add(folder);
      console.log(`📦 Dynamic beverage folder discovered: ${folder} → "${cat.nome}"`);
    }
  });

const beveragesByType = {};
let totalBeverages = 0;

allBeverageFolders.forEach(category => {
  const dir = path.join(ROOT, category.folder);
  const items = processCollection(dir, 'beverage');
  
  // Aggiungi il tipo a ogni item
  items.forEach(item => {
    item.tipo = category.name;
    item.tipo_slug = normalizeSlug(item.tipo_slug || category.slug || category.folder || category.name);
  });
  
  if (items.length > 0) {
    beveragesByType[category.name] = items;
    totalBeverages += items.length;
  }
});

// Warning: directory top-level beverage-like non referenziate da un folder di categoria
// (solo folder reali usati dal build — non slug/alias di naming)
const referencedFolders = new Set(allBeverageFolders.map(c => c.folder));
dynamicCategories
  .filter(c => c.tipo_menu === 'beverage')
  .forEach(cat => {
    const folder = getCategoryFolder(cat);
    if (folder) referencedFolders.add(folder);
    if (cat.folder) referencedFolders.add(cat.folder);
  });
// beers/food processati separatamente — non orphan
referencedFolders.add('beers');
referencedFolders.add('food');
BASE_BEVERAGE_CATEGORIES.forEach(c => referencedFolders.add(c.folder));

warnOrphanBeverageDirs(referencedFolders);

// Crea array piatto di tutte le bevande
const allBeverages = [];
Object.values(beveragesByType).forEach(items => {
  allBeverages.push(...items);
});

if (buildWarnings.length > 0) {
  console.warn(`\n⚠️  ${buildWarnings.length} warning(s):`);
  buildWarnings.forEach(w => console.warn(`- ${w}`));
}

if (buildErrors.length > 0) {
  console.error(`\n⚠️  ${buildErrors.length} file markdown non valido/i: saltato/i (il resto del menù viene comunque pubblicato).`);
  buildErrors.forEach(error => console.error(`- ${error}`));
  console.error('   → Correggi i file elencati sopra per reintegrarli nel menù. Il deploy prosegue con i contenuti validi.');
}

// BUILD-002: Rete di sicurezza anti-corruzione di massa.
// Un singolo .md rotto viene saltato (sopra) e il resto pubblicato, così un errore
// isolato NON congela tutti gli aggiornamenti durante il servizio. Ma se una collection
// crolla drasticamente rispetto al JSON già pubblicato MENTRE ci sono file non validi,
// è sintomo di corruzione estesa → interrompiamo il deploy per preservare l'ultimo menù valido.
function assertNoMassWipe(jsonRelPath, arrayKey, newLength) {
  if (buildErrors.length === 0) return;
  let previous;
  try {
    previous = JSON.parse(fs.readFileSync(path.join(ROOT, jsonRelPath), 'utf8'));
  } catch {
    return; // nessun JSON precedente valido con cui confrontare
  }
  const previousLength = Array.isArray(previous && previous[arrayKey]) ? previous[arrayKey].length : 0;
  if (previousLength >= 4 && newLength < previousLength * 0.5) {
    console.error(
      `\n❌ Anti-wipe build: "${jsonRelPath}" passerebbe da ${previousLength} a ${newLength} elementi ` +
      `con ${buildErrors.length} file non validi. Deploy interrotto per preservare l'ultimo menù valido. ` +
      `Correggi i file sopra e ripubblica.`
    );
    process.exit(1);
  }
}

// Scrivi i file JSON
const beersOutput = { 
  beers,
  beersBySection 
};
assertNoMassWipe('beers/beers.json', 'beers', beers.length);
fs.writeFileSync(
  path.join(ROOT, 'beers/beers.json'),
  JSON.stringify(beersOutput, null, 2)
);

// Scrivi food.json con categorie ordinate
const foodOutput = {
  food: foodItems,
  foodByCategory,
  categoryOrder: foodCategoryOrder
};
if (!fs.existsSync(foodDir)) fs.mkdirSync(foodDir);
assertNoMassWipe('food/food.json', 'food', foodItems.length);
fs.writeFileSync(
  path.join(ROOT, 'food/food.json'),
  JSON.stringify(foodOutput, null, 2)
);

// Scrivi categorie.json per il frontend
const categoriesOutput = {
  categories: dynamicCategories,
  foodCategories: dynamicCategories.filter(c => c.tipo_menu === 'food'),
  beverageCategories: dynamicCategories.filter(c => c.tipo_menu === 'beverage')
};
const categoriesDir = path.join(ROOT, 'categorie');
if (!fs.existsSync(categoriesDir)) fs.mkdirSync(categoriesDir);
assertNoMassWipe('categorie/categorie.json', 'categories', dynamicCategories.length);
fs.writeFileSync(
  path.join(categoriesDir, 'categorie.json'),
  JSON.stringify(categoriesOutput, null, 2)
);

const beveragesOutput = { 
  beverages: allBeverages,
  beveragesByType 
};
// Ensure beverages dir exists
const beveragesDir = path.join(ROOT, 'beverages');
if (!fs.existsSync(beveragesDir)) fs.mkdirSync(beveragesDir);

assertNoMassWipe('beverages/beverages.json', 'beverages', allBeverages.length);
fs.writeFileSync(
  path.join(beveragesDir, 'beverages.json'),
  JSON.stringify(beveragesOutput, null, 2)
);

console.log(`✅ Generato beers.json con ${beers.length} birre in ${Object.keys(beersBySection).length} sezioni`);
console.log(`✅ Generato food.json con ${foodItems.length} piatti in ${Object.keys(foodByCategory).length} categorie`);
console.log(`✅ Generato beverages.json con ${totalBeverages} bevande in ${Object.keys(beveragesByType).length} categorie`);
console.log(`✅ Generato categorie.json con ${dynamicCategories.length} categorie dinamiche`);
