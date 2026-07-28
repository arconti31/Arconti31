// ========================================
// ARCONTI31 - MENU DIGITALE
// Lettura da JSON statici (zero rate limiting)
// Il menù pubblico non usa GitHub: carica solo i JSON del sito deployato.
// ========================================

if (!window.MenuOrder || typeof window.MenuOrder.compareMenuItems !== 'function') {
  throw new Error('Ordinamento menu non disponibile: manca js/menu-order.js');
}
const { compareMenuItems } = window.MenuOrder;

// Icon mapping per Tags e Allergeni
const ICONS = {
  tags: {
    'Novità': '✨',
    'Senza Glutine': '🌾🚫',
    'Vegetariano': '🌿',
    'Vegano': '🌱',
    'Piccante': '🌶️',
    'Specialità': '⭐',
    'Biologico': 'bio',
    'Più venduto': '🔥',
    'default': '🏷️'
  },
  allergeni: {
    'Glutine': '🌾',
    'Crostacei': '🦐',
    'Uova': '🥚',
    'Pesce': '🐟',
    'Arachidi': '🥜',
    'Soia': '🫘',
    'Latte': '🥛',
    'Frutta a guscio': '🌰',
    'Sedano': '🥬',
    'Senape': '🟡',
    'Sesamo': '⚪',
    'Anidride solforosa e solfiti': '🍷',
    'Lupini': '🫛',
    'Molluschi': '🦪',
    'Lattosio': '🥛',
    'Senza Glutine': '✅',
    'default': '⚠️'
  }
};

// Fallback immagini categorie (usate solo se non definite nel CMS)
const DEFAULT_CATEGORY_IMAGES = {
  'Hamburger di bufala': 'images/minicard sezioni/hamburger-bufala.png',
  'Hamburger Fassona e Street food': 'images/minicard sezioni/bufala-streetfood.png',
  'OKTOBERFEST': 'images/minicard sezioni/oktoberfest.jpg',
  'Panini': 'images/minicard sezioni/panini.jpg',
  'Griglieria': 'images/minicard sezioni/picanha.jpg',
  'Piatti Speciali': 'images/minicard sezioni/piatti-speciali.jpg',
  'Piadine': 'images/minicard sezioni/piadine.jpg',
  'Fritti': 'images/minicard sezioni/fritti.jpg',
  'Dolci': 'images/minicard sezioni/dolci.jpg',
  'Aperitivo': 'images/minicard sezioni/aperitivo.jpg',
  'Birre artigianali alla spina a rotazione': 'images/minicard sezioni/birre-spina-rotazione.png',
  'Birre alla spina': 'images/minicard sezioni/birra-spina.png',
  'Birre speciali in bottiglia': 'images/minicard sezioni/speciali-bottiglia.png',
  'Frigo Birre': 'images/minicard sezioni/frigo-birre.png',
  'Cocktails': 'images/minicard sezioni/cocktail.jpg',
  'Analcolici': 'images/minicard sezioni/analcolici.jpg',
  'Bibite': 'images/minicard sezioni/bevande.jpg',
  'Caffetteria': 'images/minicard sezioni/caffetteria.jpg',
  'Bollicine': 'images/minicard sezioni/bollicine.jpg',
  'Bianchi fermi': 'images/minicard sezioni/bianchi-fermi.png',
  'Vini rossi': 'images/minicard sezioni/rossi.jpg'
};

// State
let categoriesData = [];
let foodData = [];
let beersData = [];
let beveragesData = [];
let currentView = 'home';
let currentCategory = null;
let currentCategoryType = null;

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Escape HTML per prevenire XSS (include quote per sicurezza in attributi)
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Confronta nomi categoria/item ignorando spazi iniziali/finali
 */
function namesMatch(a, b) {
  return String(a || '').trim() === String(b || '').trim();
}

/**
 * Encode path segments for relative image URLs with spaces.
 * Non tocca URL assoluti http(s)/protocol-relative/data (es. Cloudinary).
 */
function safeImageUrl(url) {
  if (!url) return '';
  const s = String(url).trim();
  if (!s) return '';
  if (/^(https?:)?\/\//i.test(s) || /^data:/i.test(s) || /^blob:/i.test(s)) {
    return s;
  }
  try {
    const match = s.match(/^([^?#]*)(.*)$/);
    const path = match[1];
    const rest = match[2] || '';
    const encoded = path.split('/').map(seg => {
      if (!seg) return seg;
      try {
        return encodeURIComponent(decodeURIComponent(seg));
      } catch {
        return encodeURIComponent(seg);
      }
    }).join('/');
    return encoded + rest;
  } catch {
    return s;
  }
}

function normalizeSlugValue(value) {
  if (!value) return '';

  return String(value)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function getFilenameBase(filename) {
  if (!filename) return '';
  return String(filename).replace(/\.md$/i, '');
}

function getCategoryAliases(category) {
  const aliases = new Set();
  [category?.nome, category?.slug, category?.folder, getFilenameBase(category?._filename || category?.filename)].forEach(value => {
    const normalized = normalizeSlugValue(value);
    if (normalized) aliases.add(normalized);
  });
  return [...aliases];
}

function matchesCategoryValue(value, category) {
  const normalizedValue = normalizeSlugValue(value);
  if (!normalizedValue || !category) return false;
  return getCategoryAliases(category).includes(normalizedValue);
}

function matchesItemToCategory(item, category, legacyField, stableField) {
  const stableValue = normalizeSlugValue(item?.[stableField]);
  if (stableValue) {
    if (matchesCategoryValue(stableValue, category)) return true;
    if (normalizeSlugValue(category?.slug) === stableValue) return true;
  }
  return matchesCategoryValue(item?.[legacyField], category);
}

function getCategoryHash(category) {
  return normalizeSlugValue(category?.slug || category?.nome || '');
}

// ========================================
// FORMATTAZIONE PREZZI (Locale IT)
// ========================================

/**
 * Formatta un prezzo con localizzazione italiana (virgola come separatore decimale)
 * @param {string|number} price - Il prezzo da formattare (accetta sia punto che virgola)
 * @returns {string} - Prezzo formattato (es: "14,50")
 */
function formatPrice(price) {
  if (price === undefined || price === null || price === '') return '0,00';
  
  // Converti in stringa e normalizza: sostituisci virgola con punto per parsing
  let normalized = String(price).replace(',', '.');
  
  // Rimuovi eventuali caratteri non numerici (tranne punto e segno)
  normalized = normalized.replace(/[^\d.-]/g, '');
  
  // Parsa come float
  const numValue = parseFloat(normalized);
  
  // Se non è un numero valido, ritorna '0,00'
  if (isNaN(numValue)) return '0,00';
  
  // Usa Intl.NumberFormat per formattazione italiana
  return new Intl.NumberFormat('it-IT', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(numValue);
}

// ========================================
// CARICAMENTO DATI DA JSON STATICI
// ========================================

/**
 * Carica un file JSON con cache buster aggressivo (sempre dati freschi)
 */
async function loadFromJSON(jsonPath) {
  try {
    const cacheBuster = `?_=${Date.now()}`;
    const res = await fetch(jsonPath + cacheBuster, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    if (!res.ok) {
      console.warn(`⚠️ Errore caricamento ${jsonPath}: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error(`❌ Errore fetch ${jsonPath}:`, e);
    return null;
  }
}

// ========================================
// DATA LOADING
// ========================================

function navigateFromHash(hash) {
  if (hash) {
    const category = findCategoryBySlug(hash);
    if (category) {
      showCategory(category.name, category.type, { skipHistory: true });
    } else {
      showCategoriesView({ skipHistory: true });
    }
  } else {
    showCategoriesView({ skipHistory: true });
  }
}

function showCacheModeBanner() {
  console.warn('⚠️ Modalità cache: menù da dati locali (rete non disponibile)');
  if (document.getElementById('cache-mode-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'cache-mode-banner';
  banner.setAttribute('role', 'status');
  banner.textContent = 'Modalità cache — connessione assente, mostro l\'ultima versione salvata';
  banner.style.cssText = 'background:#664d03;color:#fff3cd;padding:0.5rem 1rem;text-align:center;font-size:0.875rem;z-index:9999;';
  document.body.prepend(banner);
}

function showLoadError() {
  const el = document.getElementById('categories-view');
  if (!el) return;
  el.style.display = 'block';
  const detail = document.getElementById('detail-view');
  if (detail) detail.style.display = 'none';
  el.innerHTML = `
    <div class="loading" style="text-align:center;padding:2rem;">
      <p>Impossibile caricare il menù. Controlla la connessione e riprova.</p>
      <button type="button" onclick="location.reload()" style="margin-top:1rem;padding:0.75rem 1.5rem;cursor:pointer;font-size:1rem;border-radius:8px;border:1px solid #ccc;background:#fff;">
        Riprova
      </button>
    </div>
  `;
}

/**
 * Unisce rete + cache per collezione.
 * REGOLA ANTI-SPARIZIONE: se un JSON non arriva, NON svuotare quella collezione —
 * tieni i dati in cache (o skeleton). Solo le collezioni scaricate con successo
 * diventano source of truth e aggiornano IndexedDB.
 */
function buildMenuItemsFromSources({ categoriesRes, foodRes, beersRes, beveragesRes, cacheItems }) {
  const fromCache = (collection) =>
    (cacheItems || [])
      .filter(i => i._collection === collection && !i._deleted)
      .map(i => ({ ...i }));

  const parts = [];
  let usedCacheFallback = false;
  const networkCollections = [];

  if (categoriesRes?.categories) {
    parts.push(...categoriesRes.categories.map(i => ({ ...i, _collection: 'categorie' })));
    networkCollections.push({ name: 'categorie', items: categoriesRes.categories });
  } else {
    const cached = fromCache('categorie');
    if (cached.length) {
      parts.push(...cached);
      usedCacheFallback = true;
    }
  }

  if (foodRes?.food) {
    parts.push(...foodRes.food.map(i => ({ ...i, _collection: 'food' })));
    networkCollections.push({ name: 'food', items: foodRes.food });
  } else {
    const cached = fromCache('food');
    if (cached.length) {
      parts.push(...cached);
      usedCacheFallback = true;
    }
  }

  if (beersRes?.beers) {
    parts.push(...beersRes.beers.map(i => ({ ...i, _collection: 'beers' })));
    networkCollections.push({ name: 'beers', items: beersRes.beers });
  } else {
    const cached = fromCache('beers');
    if (cached.length) {
      parts.push(...cached);
      usedCacheFallback = true;
    }
  }

  if (beveragesRes?.beverages) {
    parts.push(...beveragesRes.beverages.map(i => ({ ...i, _collection: 'beverages' })));
    networkCollections.push({ name: 'beverages', items: beveragesRes.beverages });
  } else {
    const cached = fromCache('beverages');
    if (cached.length) {
      parts.push(...cached);
      usedCacheFallback = true;
    }
  }

  return { allItems: parts, usedCacheFallback, networkCollections };
}

async function loadAllData() {
  showLoading();
  
  // Salva l'hash PRIMA di qualsiasi operazione (per il restore dopo)
  const initialHash = window.location.hash.slice(1);
  let hadCacheSkeleton = false;
  let cacheItems = [];

  // Init SmartCache — skeleton offline/istantaneo (non è source of truth se la rete risponde)
  if (window.SmartCache) {
    await window.SmartCache.init();
    
    cacheItems = (await window.SmartCache.getAll('items')).filter(i => !i._deleted);
    
    if (cacheItems.length > 0) {
      console.log('⚡ Loaded items from SmartCache (skeleton)');
      processItems(cacheItems);
      hadCacheSkeleton = true;
      navigateFromHash(initialHash);
      hideLoading();
    }

    // Subscribe DOPO lo skeleton: re-render solo su notify espliciti (admin multi-tab / sync non silent)
    window.SmartCache.subscribe((changes) => {
      console.log('🔄 SmartCache update received:', changes);
      window.SmartCache.getAll('items').then(items => {
        processItems(items.filter(i => !i._deleted));
        if (currentView === 'home') {
          showCategoriesView({ skipHistory: true });
        } else if (currentView === 'detail' && currentCategory) {
          showCategory(currentCategory, currentCategoryType, { skipHistory: true });
        }
      });
    });
  }

  try {
    // Carica tutti i JSON in parallelo
    const [categoriesRes, foodRes, beersRes, beveragesRes] = await Promise.all([
      loadFromJSON('/categorie/categorie.json'),
      loadFromJSON('/food/food.json'),
      loadFromJSON('/beers/beers.json'),
      loadFromJSON('/beverages/beverages.json')
    ]);

    const { allItems, usedCacheFallback, networkCollections } = buildMenuItemsFromSources({
      categoriesRes,
      foodRes,
      beersRes,
      beveragesRes,
      cacheItems
    });

    const anyNetwork = networkCollections.length > 0;
    const allNetworkOk = networkCollections.length === 4;

    if (allItems.length > 0) {
      // Aggiorna IDB SOLO per le collezioni scaricate con successo (mai "svuotare" le altre)
      // silent: niente notify a metà sync → niente prodotti che spariscono per un frame
      if (window.SmartCache && networkCollections.length) {
        const pubOpts = { preferRemote: true, silent: true };
        for (const col of networkCollections) {
          await window.SmartCache.syncCollection(col.items, col.name, 'static', pubOpts);
        }
      }

      processItems(allItems);
      console.log(
        `✅ Dati caricati: ${foodData.length} piatti, ${beersData.length} birre, ${beveragesData.length} bevande` +
        (allNetworkOk ? ' (rete completa)' : anyNetwork ? ' (rete parziale + cache)' : ' (solo cache)')
      );
      navigateFromHash(initialHash);

      if (!anyNetwork || usedCacheFallback) {
        showCacheModeBanner();
      }
    } else if (hadCacheSkeleton) {
      showCacheModeBanner();
    } else {
      showLoadError();
    }
  } catch (error) {
    console.error('Errore nel caricamento:', error);
    // Fallback cache se possibile
    try {
      if (window.SmartCache) {
        const fallback = (await window.SmartCache.getAll('items')).filter(i => !i._deleted);
        if (fallback.length > 0) {
          if (!hadCacheSkeleton) {
            processItems(fallback);
            navigateFromHash(initialHash);
          }
          showCacheModeBanner();
          return;
        }
      }
    } catch (_) { /* ignore */ }
    showLoadError();
  } finally {
    hideLoading();
  }
}

function processItems(items) {
  // Filter by collection/type
  categoriesData = items.filter(i => i._collection === 'categorie' || (!i._collection && i.tipo_menu))
    .filter(c => c.visibile !== false)
    .sort(compareMenuItems);

  foodData = items.filter(i => i._collection === 'food' || (!i._collection && i.category))
    .sort(compareMenuItems);

  beersData = items.filter(i => i._collection === 'beers' || (!i._collection && i.sezione))
    .sort(compareMenuItems);

  beveragesData = items.filter(i => i._collection === 'beverages' || (!i._collection && i.tipo))
    .sort(compareMenuItems);
}

function showLoading() {
  document.getElementById('categories-view').innerHTML =
    '<div class="loading">Caricamento Menù...</div>';
}

function hideLoading() {
  // Loading viene sostituito dal contenuto
}

// ========================================
// VIEWS
// ========================================

// Helper: get subcategories of a parent category
function getSubcategories(parentSlug) {
  const normalizedParent = normalizeSlugValue(parentSlug);
  return categoriesData.filter(c => normalizeSlugValue(c.parent_category) === normalizedParent);
}

// Helper: count products for a category (including subcategories)
function countCategoryProducts(cat) {
  let count = 0;
  if (cat.tipo_menu === 'food') {
    count = foodData.filter(f => matchesItemToCategory(f, cat, 'category', 'category_slug') && f.disponibile !== false).length;
  } else {
    // Beers
    count = beersData.filter(b => matchesItemToCategory(b, cat, 'sezione', 'sezione_slug') && b.disponibile !== false).length;
    // Beverages
    if (count === 0) {
      count = beveragesData.filter(b => matchesItemToCategory(b, cat, 'tipo', 'tipo_slug') && b.disponibile !== false).length;
    }
  }
  // Add subcategory products
  const subcats = getSubcategories(cat.slug);
  subcats.forEach(sub => { count += countCategoryProducts(sub); });
  return count;
}

// Helper: determine type for a beverage category
function resolveBevType(cat) {
  if (beersData.some(b => matchesItemToCategory(b, cat, 'sezione', 'sezione_slug'))) return 'beer';
  return 'beverage';
}

function showCategoriesView(options = {}) {
  const { skipHistory = false } = options;
  currentView = 'home';
  currentCategory = null;
  currentCategoryType = null;
  
  // Aggiorna URL senza hash
  if (!skipHistory && window.location.hash) {
    history.pushState(null, '', window.location.pathname);
  }
  
  document.getElementById('breadcrumb').style.display = 'none';
  document.getElementById('categories-view').style.display = 'block';
  document.getElementById('detail-view').style.display = 'none';

  const categoriesView = document.getElementById('categories-view');
  let html = '';

  // 1. CUCINA (Food) — only top-level (no parent_category)
  const foodCategories = categoriesData.filter(c => c.tipo_menu === 'food' && !c.parent_category);
  
  if (foodCategories.length > 0) {
    html += '<h2 class="section-header">Cucina</h2><div class="categories-grid">';
    foodCategories.forEach(cat => {
      const count = countCategoryProducts(cat);
      html += createCategoryCard(cat, count, 'food');
    });
    html += '</div>';
  }

  // 2. BEVERAGE (Beers + Beverages) — only top-level (no parent_category)
  const beverageCategories = categoriesData.filter(c => c.tipo_menu === 'beverage' && !c.parent_category);
  
  if (beverageCategories.length > 0) {
    html += '<h2 class="section-header">Beverage</h2><div class="categories-grid">';
    
    beverageCategories.forEach(cat => {
      const count = countCategoryProducts(cat);
      const type = resolveBevType(cat);
      html += createCategoryCard(cat, count, type);
    });
    
    html += '</div>';
  }
  
  // Fallback se non ci sono categorie caricate (es. errore o tutto nascosto)
  if (foodCategories.length === 0 && beverageCategories.length === 0) {
     html = '<div class="empty-state" style="text-align:center; padding: 2rem;">Nessuna categoria disponibile al momento.</div>';
  }

  categoriesView.innerHTML = html;
  
  // Event delegation per le category card (evita inline onclick)
  categoriesView.querySelectorAll('.category-card').forEach(card => {
    card.addEventListener('click', () => {
      const categoryName = card.dataset.category;
      const type = card.dataset.type;
      if (categoryName && type) {
        showCategory(categoryName, type);
      }
    });
  });
}

function createCategoryCard(cat, count, type) {
  // Priorità: immagine dalla categoria dinamica > fallback hardcoded
  const catNameKey = String(cat.nome || '').trim();
  let imageUrl = cat.immagine || DEFAULT_CATEGORY_IMAGES[catNameKey] || null;
  
  // Sanitizza per prevenire XSS
  const safeName = escapeHtml(cat.nome);
  const safeType = escapeHtml(type);

  const hasImageClass = imageUrl ? 'has-bg-image' : '';
  const imageHtml = imageUrl
    ? `<img src="${escapeHtml(safeImageUrl(imageUrl))}" alt="${safeName}" class="category-bg-img" loading="lazy" decoding="async">`
    : '';

  return `
    <div class="category-card ${hasImageClass}" data-category="${safeName}" data-type="${safeType}">
      <div class="category-bg-layer">${imageHtml}</div>
      <div class="category-overlay-layer"></div>
      <div class="category-content-wrapper">
        <div class="category-info">
          <div class="category-title">${safeName}</div>
          <div class="category-count">${count} prodotti</div>
        </div>
        <div class="category-arrow">→</div>
      </div>
    </div>
  `;
}

function showCategory(categoryName, type, options = {}) {
  const { skipHistory = false } = options;
  currentView = 'detail';
  currentCategory = categoryName;
  currentCategoryType = type;
  
  // Aggiorna URL con hash per permettere refresh e condivisione
  const category = categoriesData.find(cat => namesMatch(cat.nome, categoryName));
  const slug = category ? getCategoryHash(category) : slugifyCategory(categoryName);
  if (!skipHistory) {
    history.pushState({ category: categoryName, type: type }, '', `#${slug}`);
  }
  
  document.getElementById('breadcrumb').style.display = 'flex';
  document.getElementById('categories-view').style.display = 'none';
  document.getElementById('detail-view').style.display = 'block';

  // Check if this category has subcategories
  const thisCat = categoriesData.find(c => namesMatch(c.nome, categoryName));
  const subcats = thisCat ? getSubcategories(thisCat.slug) : [];

  const detailContent = document.getElementById('detail-content');

  if (subcats.length > 0) {
    // Parent category with subcategories → show subcategory cards
    // Also include direct products of the parent (if any)
    let directItems = [];
    if (type === 'beer') {
      directItems = beersData.filter(b => matchesItemToCategory(b, thisCat, 'sezione', 'sezione_slug') && b.disponibile !== false);
    } else if (type === 'beverage') {
      directItems = beveragesData.filter(b => matchesItemToCategory(b, thisCat, 'tipo', 'tipo_slug') && b.disponibile !== false);
    } else if (type === 'food') {
      directItems = foodData.filter(f => matchesItemToCategory(f, thisCat, 'category', 'category_slug') && f.disponibile !== false);
    }
    directItems.sort(compareMenuItems);

    let html = `<h2 class="section-title">${escapeHtml(categoryName)}</h2>`;

    // Subcategory cards grid
    html += '<div class="categories-grid">';
    subcats.forEach(sub => {
      const subCount = countCategoryProducts(sub);
      const subType = sub.tipo_menu === 'food' ? 'food' : resolveBevType(sub);
      html += createCategoryCard(sub, subCount, subType);
    });
    html += '</div>';

    // Direct products of the parent (shown below subcategory cards)
    if (directItems.length > 0) {
      html += `<div class="beer-grid" style="margin-top: 1.5rem;">`;
      html += directItems.map((item, index) => renderCard(item, index, type)).join('');
      html += '</div>';
    }

    detailContent.innerHTML = html;

    // Event delegation for subcategory cards
    detailContent.querySelectorAll('.category-card').forEach(card => {
      card.addEventListener('click', () => {
        const catName = card.dataset.category;
        const catType = card.dataset.type;
        if (catName && catType) {
          showCategory(catName, catType);
        }
      });
    });

    // Event delegation for direct product cards
    detailContent.querySelectorAll('.beer-card').forEach(card => {
      card.addEventListener('click', () => {
        const itemName = card.dataset.itemName;
        const itemType = card.dataset.itemType;
        if (itemName && itemType) {
          openModal(itemName, itemType);
        }
      });
    });
  } else {
    // Leaf category → show products directly
    let items = [];

    if (type === 'beer') {
      items = beersData.filter(b => matchesItemToCategory(b, thisCat, 'sezione', 'sezione_slug') && b.disponibile !== false);
    } else if (type === 'beverage') {
      items = beveragesData.filter(b => matchesItemToCategory(b, thisCat, 'tipo', 'tipo_slug') && b.disponibile !== false);
    } else if (type === 'food') {
      items = foodData.filter(f => matchesItemToCategory(f, thisCat, 'category', 'category_slug') && f.disponibile !== false);
    }

    // Ordina per order
    items.sort(compareMenuItems);

    detailContent.innerHTML = `
      <h2 class="section-title">${escapeHtml(categoryName)}</h2>
      <div class="beer-grid">
        ${items.map((item, index) => renderCard(item, index, type)).join('')}
      </div>
    `;
    
    // Event delegation per le beer-card (evita inline onclick)
    detailContent.querySelectorAll('.beer-card').forEach(card => {
      card.addEventListener('click', () => {
        const itemName = card.dataset.itemName;
        const itemType = card.dataset.itemType;
        if (itemName && itemType) {
          openModal(itemName, itemType);
        }
      });
    });
  }

  window.scrollTo(0, 0);
}

/**
 * Converte il nome categoria in uno slug URL-friendly
 */
function slugifyCategory(name) {
  return normalizeSlugValue(name);
}

/**
 * Trova una categoria dal suo slug
 */
function findCategoryBySlug(slug) {
  if (!slug) return null;
  
  const normalizedSlug = normalizeSlugValue(slug);
  
  // Cerca in tutte le categorie
  for (const cat of categoriesData) {
    if (getCategoryAliases(cat).includes(normalizedSlug)) {
      // Determina il tipo
      let type = 'food';
      if (cat.tipo_menu === 'beverage') {
        // Controlla se è birra o altra bevanda
        const isBeer = beersData.some(b => matchesItemToCategory(b, cat, 'sezione', 'sezione_slug'));
        type = isBeer ? 'beer' : 'beverage';
      }
      return { name: cat.nome, type: type };
    }
  }
  
  return null;
}

/**
 * Gestisce la navigazione da URL hash (refresh o link diretto)
 */
function handleHashNavigation() {
  const hash = window.location.hash.slice(1); // Rimuovi il #
  
  if (!hash) {
    // Nessun hash, mostra home
    if (currentView !== 'home') {
      showCategoriesView({ skipHistory: true });
    }
    return;
  }
  
  // Cerca la categoria corrispondente
  const category = findCategoryBySlug(hash);
  
  if (category) {
    showCategory(category.name, category.type, { skipHistory: true });
  } else {
    // Hash non valido, vai alla home
    showCategoriesView({ skipHistory: true });
  }
}

function goHome() {
  // Aggiorna URL rimuovendo l'hash
  history.pushState(null, '', window.location.pathname);
  showCategoriesView();
  window.scrollTo(0, 0);
}

// ========================================
// CARD RENDERING
// ========================================

function renderCard(item, index, type) {
  // Sanitizza per prevenire XSS
  const safeName = escapeHtml(item.nome);
  const safeType = escapeHtml(type);
  const safeDescription = item.descrizione ? escapeHtml(item.descrizione) : '';
  const safeCategoryLabel = type === 'beer' ? escapeHtml(item.sezione || '') : (type === 'food' ? escapeHtml(item.category || '') : escapeHtml(item.tipo || ''));
  
  // Immagine copertina (opzionale)
  const hasImage = item.immagine || item.immagine_copertina;
  const imageUrl = item.immagine_copertina || item.immagine;

  const imageHtml = hasImage
    ? `<div class="card-image-container"><img src="${escapeHtml(safeImageUrl(imageUrl))}" alt="${safeName}" class="beer-image" loading="lazy" decoding="async"></div>`
    : '';

  const noImageClass = !hasImage ? 'no-image-card' : '';

  // Avatar/Logo (opzionale)
  const logoUrl = item.immagine_avatar || item.logo;
  const logoHtml = logoUrl
    ? `<img src="${escapeHtml(safeImageUrl(logoUrl))}" alt="${safeName}" class="beer-logo">`
    : '';

  // Tags
  let tagsHtml = '';
  if (item.tags) {
    let tagsList = Array.isArray(item.tags) ? item.tags : [item.tags];
    tagsList = tagsList.filter(t => t && t !== 'Nessuno');
    if (tagsList.length > 0) {
      tagsHtml = `<div class="card-badges">
        ${tagsList.map(tag => {
        const icon = ICONS.tags[tag] || ICONS.tags['default'];
        const className = escapeHtml(tag).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        return `<span class="badge badge-${className}">${icon} ${escapeHtml(tag)}</span>`;
      }).join('')}
      </div>`;
    }
  }

  const description = safeDescription ? `<p class="beer-description">${safeDescription}</p>` : '';

  return `
    <div class="beer-card ${noImageClass}" style="animation-delay: ${(index % 10) * 0.05}s" data-item-name="${safeName}" data-item-type="${safeType}">
      ${imageHtml}
      <div class="beer-content">
        <div class="card-header">
          <div class="header-left">
            ${logoHtml}
            <div class="title-group">
              ${safeCategoryLabel ? `<span class="tiny-category">${safeCategoryLabel}</span>` : ''}
              <h3 class="beer-name">${safeName}</h3>
            </div>
          </div>
          <div class="price-tag">€${formatPrice(item.prezzo)}</div>
        </div>
        ${description}
        <div class="card-footer">
          ${tagsHtml}
          <div class="availability-dot ${item.disponibile !== false ? 'available' : 'unavailable'}" title="${item.disponibile !== false ? 'Disponibile' : 'Non disponibile'}"></div>
        </div>
      </div>
    </div>
  `;
}

// ========================================
// MODAL
// ========================================

function openModal(itemName, type) {
  let allItems = [];
  if (type === 'beer') allItems = beersData;
  else if (type === 'beverage') allItems = beveragesData;
  else if (type === 'food') allItems = foodData;

  const item = allItems.find(i => namesMatch(i.nome, itemName.replace(/\\'/g, "'")));
  if (!item) return;

  const modal = document.getElementById('beer-modal');
  const modalBody = document.getElementById('modal-body');

  // Sanitizza tutti i campi per prevenire XSS
  const safeName = escapeHtml(item.nome);
  const safeDescription = escapeHtml(item.descrizione_dettagliata || item.descrizione || 'Nessuna descrizione aggiuntiva.');
  const safeGradazione = item.gradazione ? escapeHtml(item.gradazione) : '';
  const safeFormato = item.formato ? escapeHtml(item.formato) : '';

  // Immagine copertina
  const imageUrl = item.immagine_copertina || item.immagine;
  const imageHtml = imageUrl ? `<div class="modal-hero-wrapper"><img src="${escapeHtml(safeImageUrl(imageUrl))}" class="modal-hero-img" alt="${safeName}"></div>` : '';

  // Avatar
  const avatarUrl = item.immagine_avatar || item.logo;
  const avatarHtml = avatarUrl ? `<img src="${escapeHtml(safeImageUrl(avatarUrl))}" class="modal-logo-small" alt="Logo">` : '';

  // Tags (sanitizzati)
  let tagsHtml = '';
  if (item.tags) {
    let tagsList = Array.isArray(item.tags) ? item.tags : [item.tags];
    tagsList = tagsList.filter(t => t && t !== 'Nessuno');
    if (tagsList.length > 0) {
      tagsHtml = `<div class="modal-tags-list">
        ${tagsList.map(tag => {
        const icon = ICONS.tags[tag] || ICONS.tags['default'];
        return `<span class="modal-tag">${icon} ${escapeHtml(tag)}</span>`;
      }).join('')}
      </div>`;
    }
  }

  // Allergeni (sanitizzati)
  let allergeniHtml = '';
  if (item.allergeni) {
    let allList = Array.isArray(item.allergeni) ? item.allergeni : [item.allergeni];
    allList = allList.filter(a => a);
    if (allList.length > 0) {
      allergeniHtml = `
        <div class="modal-allergens-section">
          <h4>Allergeni</h4>
          <div class="allergens-grid">
            ${allList.map(a => {
        const icon = ICONS.allergeni[a] || ICONS.allergeni['default'];
        return `<div class="allergen-item"><span class="allergen-icon">${icon}</span> ${escapeHtml(a)}</div>`;
      }).join('')}
          </div>
        </div>`;
    }
  }

  modalBody.innerHTML = `
    ${imageHtml}
    <div class="modal-content-scroll">
      <div class="modal-header-row">
        <h2 class="modal-title">${safeName}</h2>
        <span class="modal-price-big">€${formatPrice(item.prezzo)}</span>
      </div>
      ${avatarHtml}
      <div class="modal-desc-text">
        ${safeDescription}
      </div>
      ${tagsHtml}
      <div class="modal-meta-info">
        ${safeGradazione ? `<div class="meta-box"><strong>Alcol</strong> ${safeGradazione}</div>` : ''}
        ${safeFormato ? `<div class="meta-box"><strong>Formato</strong> ${safeFormato}</div>` : ''}
      </div>
      ${allergeniHtml}
    </div>
    <div class="modal-close-btn-wrapper">
      <button class="modal-close-action">Chiudi</button>
    </div>
  `;
  
  // Event listener per chiusura (evita inline onclick)
  modalBody.querySelector('.modal-close-action').addEventListener('click', closeModal);

  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('beer-modal').classList.remove('active');
  document.body.style.overflow = '';
}

// Event listeners
document.getElementById('beer-modal').addEventListener('click', (e) => {
  if (e.target.id === 'beer-modal') closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

function toggleCompactView() {
  const grid = document.querySelector('.beer-grid');
  const toggleText = document.querySelector('.toggle-text');
  if (grid) {
    grid.classList.toggle('compact-view');
    toggleText.textContent = grid.classList.contains('compact-view') ? 'Lista' : 'Griglia';
  }
}

// Init
document.addEventListener('DOMContentLoaded', loadAllData);

// Gestione navigazione browser (back/forward)
window.addEventListener('popstate', (event) => {
  if (event.state && event.state.category) {
    // Naviga alla categoria salvata nello state
    showCategory(event.state.category, event.state.type, { skipHistory: true });
  } else {
    // Nessuno state o hash vuoto = home
    handleHashNavigation();
  }
});

// Gestione hash change (per link diretti)
window.addEventListener('hashchange', handleHashNavigation);
