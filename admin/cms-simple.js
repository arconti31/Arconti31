/* ========================================
   ARCONTI31 CMS - CON UPLOAD IMMAGINI
   Sincronizzazione diretta con GitHub
   Upload immagini via Cloudinary
   ======================================== */

// CMS parla solo con le API del Worker Cloudflare (/api/*).
// Il repo GitHub target è definito dalle env del Worker (REPO_OWNER, REPO_NAME, GITHUB_TOKEN).
const API = {
  saveData: '/api/save-data',
  readData: '/api/read-data',
  bumpCacheVersion: '/api/bump-cache-version',
  cloudinarySignature: '/api/cloudinary-signature',
  uploadImage: '/api/upload-image' // legacy relay Base64, usato solo come fallback
};

const CONFIG = {
  // Cloudinary config - valorizzata a runtime da get-cloudinary-config
  cloudinary: {
    cloudName: '',
    uploadPreset: ''
  }
};

if (!window.MenuOrder || typeof window.MenuOrder.compareMenuItems !== 'function') {
  throw new Error('Ordinamento menu non disponibile: manca js/menu-order.js');
}
const { compareMenuItems } = window.MenuOrder;

// Vincoli immagine applicati prima di toccare la rete: stessi formati che il
// preset firmato Cloudinary dovrebbe accettare lato server.
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// Deve restare <= MAX_BATCH_PER_REQUEST del Worker (src/worker/routes/save-data.ts).
// Il Worker legge i .md di un batch in blocco via GraphQL, quindi un riordino
// dell'intera carta birre resta UNA richiesta e UN commit: lo spezzettamento
// qui è solo una rete di sicurezza per selezioni fuori scala.
const MAX_BATCH_ITEMS = 500;

/**
 * Invia un'operazione batch, spezzandola in blocchi solo se supera il tetto.
 * Ogni blocco è un commit atomico e coerente lato Worker: un'interruzione a
 * metà lascia i blocchi già applicati validi, mai uno stato ibrido.
 * Lancia al primo blocco fallito, con `status`/`body` della risposta.
 */
async function postBatchChunked(basePayload, items, onProgress) {
  let updated = 0;
  let target = null;
  const chunks = Math.max(1, Math.ceil(items.length / MAX_BATCH_ITEMS));

  for (let i = 0; i < items.length; i += MAX_BATCH_ITEMS) {
    const slice = items.slice(i, i + MAX_BATCH_ITEMS);
    if (onProgress) onProgress(Math.floor(i / MAX_BATCH_ITEMS) + 1, chunks);

    const res = await fetch(API.saveData, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...basePayload, items: slice })
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      const error = new Error(body.error || 'Errore operazione batch');
      error.status = res.status;
      error.body = body;
      error.partialUpdated = updated;
      throw error;
    }

    updated += body.updated || 0;
    target = body.target || target;
  }

  return { updated, target, chunks };
}


const LEGACY_BEVERAGE_FOLDER_ALIASES = {
  'amari-distillati': 'ammazza-caffe',
  'i-nostri-rum': 'i-nostri-rhum'
};

const SESSION_KEY = 'cms_session';

const COLLECTIONS = {
  food: {
    label: 'Piatti',
    folder: 'food',
    groupByCategory: true,
    fields: [
      { name: 'nome', label: 'Nome Piatto', type: 'text', required: true },
      { name: 'category', label: 'Categoria', type: 'dynamic-select', categoryType: 'food' },
      { name: 'prezzo', label: 'Prezzo (€)', type: 'text', required: true },
      { name: 'descrizione', label: 'Descrizione', type: 'textarea' },
      { name: 'immagine_copertina', label: 'Immagine Copertina', type: 'image', hint: 'Immagine grande del piatto' },
      { name: 'immagine_avatar', label: 'Immagine Avatar', type: 'image', hint: 'Icona piccola (opzionale)' },
      { name: 'allergeni', label: 'Allergeni', type: 'tags', options: ['Glutine', 'Crostacei', 'Uova', 'Pesce', 'Arachidi', 'Soia', 'Latte', 'Frutta a guscio', 'Sedano', 'Senape', 'Sesamo', 'Anidride solforosa e solfiti', 'Lupini', 'Molluschi'] },
      { name: 'tags', label: 'Tag Speciali', type: 'tags', options: ['Novità', 'Vegetariano', 'Vegano', 'Piccante', 'Più venduto', 'Specialità'] },
      { name: 'disponibile', label: 'Disponibile', type: 'toggle', default: true },
      { name: 'order', label: 'Ordine', type: 'number', default: 0 }
    ]
  },
  beers: {
    label: 'Birre',
    folder: 'beers',
    fields: [
      { name: 'nome', label: 'Nome Birra', type: 'text', required: true },
      { name: 'sezione', label: 'Sezione', type: 'select', options: ['Birre artigianali alla spina a rotazione', 'Birre alla spina', 'Birre speciali in bottiglia', 'Frigo Birre'] },
      { name: 'prezzo', label: 'Prezzo (€)', type: 'text', required: true },
      { name: 'descrizione', label: 'Descrizione', type: 'textarea' },
      { name: 'immagine_copertina', label: 'Immagine Copertina', type: 'image' },
      { name: 'immagine_avatar', label: 'Logo/Avatar', type: 'image' },
      { name: 'formato', label: 'Formato', type: 'text', hint: 'Es: 50cl' },
      { name: 'gradazione', label: 'Gradazione (%)', type: 'text' },
      { name: 'disponibile', label: 'Disponibile', type: 'toggle', default: true },
      { name: 'order', label: 'Ordine', type: 'number', default: 0 }
    ]
  },
  cocktails: {
    label: 'Cocktails',
    folder: 'cocktails',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true },
      { name: 'prezzo', label: 'Prezzo (€)', type: 'text', required: true },
      { name: 'descrizione', label: 'Descrizione', type: 'textarea' },
      { name: 'immagine_copertina', label: 'Immagine Copertina', type: 'image' },
      { name: 'immagine_avatar', label: 'Avatar', type: 'image' },
      { name: 'disponibile', label: 'Disponibile', type: 'toggle', default: true },
      { name: 'order', label: 'Ordine', type: 'number', default: 0 }
    ]
  },
  analcolici: {
    label: 'Analcolici',
    folder: 'analcolici',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true },
      { name: 'prezzo', label: 'Prezzo (€)', type: 'text', required: true },
      { name: 'descrizione', label: 'Descrizione', type: 'textarea' },
      { name: 'immagine_copertina', label: 'Immagine Copertina', type: 'image' },
      { name: 'immagine_avatar', label: 'Avatar', type: 'image' },
      { name: 'disponibile', label: 'Disponibile', type: 'toggle', default: true },
      { name: 'order', label: 'Ordine', type: 'number', default: 0 }
    ]
  },
  bibite: {
    label: 'Bibite',
    folder: 'bibite',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true },
      { name: 'prezzo', label: 'Prezzo (€)', type: 'text', required: true },
      { name: 'descrizione', label: 'Descrizione', type: 'textarea' },
      { name: 'immagine_copertina', label: 'Immagine Copertina', type: 'image' },
      { name: 'disponibile', label: 'Disponibile', type: 'toggle', default: true },
      { name: 'order', label: 'Ordine', type: 'number', default: 0 }
    ]
  },
  caffetteria: {
    label: 'Caffetteria',
    folder: 'caffetteria',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true },
      { name: 'prezzo', label: 'Prezzo (€)', type: 'text', required: true },
      { name: 'descrizione', label: 'Descrizione', type: 'textarea' },
      { name: 'immagine_copertina', label: 'Immagine Copertina', type: 'image' },
      { name: 'disponibile', label: 'Disponibile', type: 'toggle', default: true },
      { name: 'order', label: 'Ordine', type: 'number', default: 0 }
    ]
  },
  bollicine: {
    label: 'Bollicine',
    folder: 'bollicine',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true },
      { name: 'prezzo', label: 'Prezzo (€)', type: 'text', required: true },
      { name: 'descrizione', label: 'Descrizione', type: 'textarea' },
      { name: 'immagine_copertina', label: 'Immagine', type: 'image' },
      { name: 'formato', label: 'Formato', type: 'text' },
      { name: 'disponibile', label: 'Disponibile', type: 'toggle', default: true },
      { name: 'order', label: 'Ordine', type: 'number', default: 0 }
    ]
  },
  'bianchi-fermi': {
    label: 'Vini Bianchi',
    folder: 'bianchi-fermi',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true },
      { name: 'prezzo', label: 'Prezzo (€)', type: 'text', required: true },
      { name: 'descrizione', label: 'Descrizione', type: 'textarea' },
      { name: 'immagine_copertina', label: 'Immagine', type: 'image' },
      { name: 'formato', label: 'Formato', type: 'text' },
      { name: 'disponibile', label: 'Disponibile', type: 'toggle', default: true },
      { name: 'order', label: 'Ordine', type: 'number', default: 0 }
    ]
  },
  'vini-rossi': {
    label: 'Vini Rossi',
    folder: 'vini-rossi',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true },
      { name: 'prezzo', label: 'Prezzo (€)', type: 'text', required: true },
      { name: 'descrizione', label: 'Descrizione', type: 'textarea' },
      { name: 'immagine_copertina', label: 'Immagine', type: 'image' },
      { name: 'formato', label: 'Formato', type: 'text' },
      { name: 'disponibile', label: 'Disponibile', type: 'toggle', default: true },
      { name: 'order', label: 'Ordine', type: 'number', default: 0 }
    ]
  },
  categorie: {
    label: 'Categorie',
    folder: 'categorie',
    fields: [
      { name: 'nome', label: 'Nome Categoria', type: 'text', required: true },
      { name: 'slug', label: 'Slug', type: 'text', required: true, hint: 'ID univoco', autoSlug: true },
      { name: 'tipo_menu', label: 'Tipo Menù', type: 'select', options: ['food', 'beverage'], required: true },
      { name: 'parent_category', label: 'Categoria Padre', type: 'parent-category-select', hint: 'Lascia vuoto per categoria principale' },
      { name: 'icona', label: 'Icona', type: 'text', hint: 'Es: 🍔 🍺' },
      { name: 'immagine', label: 'Immagine Sfondo', type: 'image', hint: 'Sfondo della card categoria' },
      { name: 'descrizione', label: 'Descrizione', type: 'textarea' },
      { name: 'visibile', label: 'Visibile', type: 'toggle', default: true },
      { name: 'order', label: 'Ordine', type: 'number', default: 0 }
    ]
  }
};


// State
let state = {
  token: null,
  email: null,
  isLoggedIn: false,
  currentCollection: 'food',
  currentCategory: null,
  currentBeerSection: null,
  items: [],
  categories: [],
  allFood: [],
  allItems: {}, // Cache for global search
  currentItem: null,
  isNew: false,
  cloudinaryConfigured: false,
  searchTimeout: null,
  globalSearchTimeout: null,
  categoryFilters: { tipo: null, image: null },
  selectedItems: [], // For bulk selection
  isSaving: false,
  isDeleting: false,
  formDirty: false,
  isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
  repoTarget: null // { owner, repo, branch } se whoami/save lo espongono
};

// DOM helpers
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

function normalizeSlug(value) {
  if (!value) return '';

  return String(value)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[àáâãäå]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function getFilenameBase(filename) {
  if (!filename) return '';
  return String(filename).replace(/\.md$/i, '');
}

function getCategoryCollectionKey(category) {
  return normalizeSlug(category?.slug || category?.nome || '');
}

function getCategoryFolder(category) {
  if (category?.folder) return category.folder;
  const collectionKey = getCategoryCollectionKey(category);
  return LEGACY_BEVERAGE_FOLDER_ALIASES[collectionKey] || collectionKey;
}

function getCategoryAliases(category) {
  const aliases = new Set();
  [category?.nome, category?.slug, category?.folder, getFilenameBase(category?._filename || category?.filename)].forEach(value => {
    const normalized = normalizeSlug(value);
    if (normalized) aliases.add(normalized);
  });
  return [...aliases];
}

function matchesCategoryValue(value, category) {
  const normalizedValue = normalizeSlug(value);
  if (!normalizedValue || !category) return false;
  return getCategoryAliases(category).includes(normalizedValue);
}

function matchesItemToCategory(item, category, legacyField, stableField) {
  const stableValue = normalizeSlug(item?.[stableField]);
  if (stableValue) {
    if (matchesCategoryValue(stableValue, category)) return true;
    if (normalizeSlug(category?.slug) === stableValue) return true;
  }
  return matchesCategoryValue(item?.[legacyField], category);
}

function getSearchCollectionKeys() {
  return Object.keys(COLLECTIONS).filter(key => key !== 'categorie');
}

function clearStoredSessions() {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
}

function getStoredSession() {
  for (const storage of [localStorage, sessionStorage]) {
    const rawSession = storage.getItem(SESSION_KEY);
    if (!rawSession) continue;

    try {
      return { session: JSON.parse(rawSession), storage };
    } catch (error) {
      storage.removeItem(SESSION_KEY);
    }
  }

  return { session: null, storage: null };
}

function persistSession(session, rememberMe) {
  const targetStorage = rememberMe ? localStorage : sessionStorage;
  const otherStorage = rememberMe ? sessionStorage : localStorage;
  otherStorage.removeItem(SESSION_KEY);
  targetStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function updateStoredSession(patch) {
  const { session, storage } = getStoredSession();
  if (!session || !storage) return;
  storage.setItem(SESSION_KEY, JSON.stringify({ ...session, ...patch }));
}

// ========================================
// GESTIONE PREZZI (Sanitizzazione & Formattazione)
// ========================================

/**
 * Sanitizza l'input del prezzo: accetta sia punto che virgola come separatore decimale
 * Normalizza al formato con punto per salvataggio (es: "14,50" o "14.50" -> "14.50")
 * @param {string} input - L'input dell'utente
 * @returns {string} - Prezzo normalizzato con punto (es: "14.50")
 */
function sanitizePrice(input) {
  if (!input) return '';

  // Converti in stringa e rimuovi spazi
  let value = String(input).trim();

  // Rimuovi eventuali simboli di valuta
  value = value.replace(/[€$]/g, '').trim();

  // Gestione formato italiano: 1.234,50 -> 1234.50
  // Se contiene sia punto che virgola, il punto è separatore migliaia
  if (value.includes('.') && value.includes(',')) {
    value = value.replace(/\./g, ''); // Rimuovi punti (migliaia)
    value = value.replace(',', '.'); // Virgola diventa punto decimale
  } else {
    // Altrimenti sostituisci semplicemente virgola con punto
    value = value.replace(',', '.');
  }

  // Rimuovi caratteri non validi
  value = value.replace(/[^\d.]/g, '');

  // Parsa e riformatta per garantire max 2 decimali
  const num = parseFloat(value);
  if (isNaN(num)) return '';

  // Ritorna con sempre 2 decimali
  return num.toFixed(2);
}

/**
 * Formatta un prezzo per la visualizzazione nel CMS (formato italiano)
 * @param {string|number} price - Il prezzo
 * @returns {string} - Prezzo formattato (es: "14,50")
 */
function formatPriceDisplay(price) {
  if (price === undefined || price === null || price === '') return '0,00';

  let normalized = String(price).replace(',', '.');
  const num = parseFloat(normalized);
  if (isNaN(num)) return '0,00';

  return new Intl.NumberFormat('it-IT', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(num);
}

// Init
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Init SmartCache
  if (window.SmartCache) {
    await window.SmartCache.init();
    // Subscribe to updates
    window.SmartCache.subscribe(async (changes) => {
      console.log('🔄 SmartCache update received:', changes);
      
      // Ignora se stiamo già facendo un'operazione (evita race condition)
      if (state._isUpdating) {
        console.log('⏳ Skipping update - operation in progress');
        return;
      }
      
      if (changes.collection === state.currentCollection) {
        // Refresh current view from CACHE ONLY (no network)
        const cachedItems = await window.SmartCache.getAll('items');
        let collectionItems = cachedItems
          .filter(i => i._collection === state.currentCollection && !i._deleted)
          .sort(compareMenuItems);
        
        // Dedup solo per filename (mai per nome)
        const seenFiles = new Set();
        collectionItems = collectionItems.filter(item => {
          const key = (item.filename || item._filename || item.id || '').toString();
          if (!key) return true;
          if (seenFiles.has(key)) return false;
          seenFiles.add(key);
          return true;
        });

        // Solo se abbiamo effettivamente item da mostrare
        if (collectionItems.length > 0 || changes.removed?.length > 0) {
          state.items = collectionItems;
          renderItems();
        }
      }
      // Refresh sidebar counts if food changed
      if (changes.collection === 'food') {
        // Update sidebar counts from cache
        const cachedItems = await window.SmartCache.getAll('items');
        state.allFood = cachedItems.filter(i => i._collection === 'food' && !i._deleted);
        renderSidebar();
        setupSidebarEvents(); // Re-attach events after re-render
      }
    });
  }

  setupEventListeners();
  setupOfflineHandling();

  // Check for saved session (Ricordami)
  const { session: savedSession } = getStoredSession();
  if (savedSession) {
    const verified = await verifyStoredSession(savedSession);
    if (verified === true) {
      // Cloudinary config richiede auth: solo dopo sessione valida
      await checkCloudinaryConfig();
      return;
    }
    if (verified === 'network') {
      // Network error: NON clear session — mostra retry
      showSessionRetry(savedSession);
      return;
    }
    // verified === false → sessione invalida già pulita
  }

  showLoginScreen();
}

/**
 * Verifica sessione salvata.
 * @returns {true|false|'network'} true = ok e app avviata; false = invalida; 'network' = rete assente
 */
async function verifyStoredSession(savedSession) {
  try {
    const res = await fetch(API.saveData, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify-token', token: savedSession.token })
    });

    let result = {};
    try {
      result = await res.json();
    } catch (_) { /* body non JSON */ }

    // Clear SOLO su 401 esplicito o valid:false
    if (res.status === 401 || result.valid === false) {
      console.log('🔄 Sessione scaduta, richiesto nuovo login');
      clearStoredSessions();
      return false;
    }

    if (res.ok && result.valid !== false) {
      state.token = savedSession.token;
      state.email = savedSession.email || result.email || '';
      state.isLoggedIn = true;
      state.currentCollection = savedSession.lastCollection || 'food';
      hideSessionRetry();
      showMainApp();
      loadAllData();
      fetchRepoTarget();
      checkCloudinaryConfig();
      toast('Bentornato!', 'success');
      return true;
    }

    // Altri errori HTTP (5xx, ecc.): non invalidare sessione
    console.log('🔄 Verifica sessione non riuscita (HTTP ' + res.status + '), sessione conservata');
    toast('Rete non disponibile, riprova', 'error');
    return 'network';
  } catch (e) {
    // Network / fetch fail: NON clearStoredSessions
    console.log('🔄 Errore rete verifica sessione, sessione conservata', e);
    toast('Rete non disponibile, riprova', 'error');
    return 'network';
  }
}

function showSessionRetry(savedSession) {
  const overlay = $('#loading-overlay');
  if (!overlay) {
    showLoginScreen();
    return;
  }
  showLoading();
  const p = overlay.querySelector('p');
  if (p) p.textContent = 'Rete non disponibile';

  let retryBtn = overlay.querySelector('#session-retry-btn');
  if (!retryBtn) {
    retryBtn = document.createElement('button');
    retryBtn.id = 'session-retry-btn';
    retryBtn.type = 'button';
    retryBtn.className = 'btn btn-primary';
    retryBtn.style.marginTop = '16px';
    retryBtn.textContent = 'Riprova';
    overlay.appendChild(retryBtn);
  }
  retryBtn.style.display = 'inline-flex';
  retryBtn.onclick = async () => {
    if (p) p.textContent = 'Caricamento...';
    retryBtn.style.display = 'none';
    const verified = await verifyStoredSession(savedSession);
    if (verified === true) return;
    if (verified === 'network') {
      if (p) p.textContent = 'Rete non disponibile';
      retryBtn.style.display = 'inline-flex';
      return;
    }
    hideSessionRetry();
    showLoginScreen();
  };
}

function hideSessionRetry() {
  const overlay = $('#loading-overlay');
  if (!overlay) return;
  const p = overlay.querySelector('p');
  if (p) p.textContent = 'Caricamento...';
  const retryBtn = overlay.querySelector('#session-retry-btn');
  if (retryBtn) retryBtn.style.display = 'none';
  hideLoading();
}

async function checkCloudinaryConfig() {
  // Richiede token (action protetta): non chiamare prima del login
  if (!state.token) {
    state.cloudinaryConfigured = false;
    return;
  }
  try {
    const res = await fetch(API.saveData, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get-cloudinary-config', token: state.token })
    });
    if (res.status === 401) {
      // Sessione non ancora pronta / scaduta — silenzioso
      state.cloudinaryConfigured = false;
      return;
    }
    if (res.ok) {
      const data = await res.json();
      // L'upload firmato usa cloudName + API key/secret lato Worker: il vecchio
      // CLOUDINARY_UPLOAD_PRESET serve solo al relay legacy, quindi non deve più
      // decidere se l'upload è disponibile.
      if (data.cloudName) {
        CONFIG.cloudinary.cloudName = data.cloudName;
        CONFIG.cloudinary.uploadPreset = data.uploadPreset || '';
        state.cloudinaryConfigured = true;
        console.log('✅ Cloudinary configurato:', data.cloudName);
      } else {
        console.log('⚠️ Cloudinary non configurato - usa URL immagini');
      }
    }
  } catch (e) {
    console.log('⚠️ Cloudinary non disponibile - usa URL immagini');
  }
}

function setupEventListeners() {
  $('#login-form').addEventListener('submit', handleLogin);
  $('#menu-toggle').addEventListener('click', toggleSidebar);
  // Sidebar events are set up dynamically in setupSidebarEvents()
  $('#add-new-btn').addEventListener('click', createNew);
  $('#back-btn').addEventListener('click', showListView);
  $('#save-btn').addEventListener('click', saveItem);
  $('#delete-btn').addEventListener('click', deleteItem);
  $('#sync-btn').addEventListener('click', () => {
    loadAllData();
  });
  $('#refresh-devices-btn')?.addEventListener('click', refreshAllDevices);
  $('#logout-btn').addEventListener('click', logout);

  // Search with live suggestions
  $('#search-input').addEventListener('input', handleSearchInput);
  $('#search-input').addEventListener('keydown', handleSearchKeydown);
  $('#search-input').addEventListener('focus', () => {
    if ($('#search-input').value.length >= 2) showSearchSuggestions();
  });
  $('#search-clear').addEventListener('click', clearSearch);

  // Close suggestions when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrapper')) {
      hideSearchSuggestions();
    }
  });

  $('#filter-category').addEventListener('change', filterItems);
  $('#filter-status').addEventListener('change', filterItems);

  // Category filters (for Categorie section)
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => toggleCategoryFilter(chip));
  });
  $('#filters-reset')?.addEventListener('click', resetCategoryFilters);

  // Global search in navbar
  setupGlobalSearch();
}


// ========================================
// AUTH
// ========================================

async function handleLogin(e) {
  e.preventDefault();
  const email = $('#email-input').value.trim();
  const password = $('#password-input').value;
  const rememberMe = $('#remember-me')?.checked === true;

  if (!email) { toast('Inserisci email', 'error'); return; }
  if (!password) { toast('Inserisci password', 'error'); return; }

  showLoading();

  try {
    const res = await fetch(API.saveData, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'login',
        email: email,
        password: password
      })
    });

    const result = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(mapApiError(res.status, result) || result.error || 'Errore login');
    }

    // Store token
    state.token = result.token;
    state.email = result.user?.email || result.email || email;
    state.isLoggedIn = true;

    persistSession({
      token: result.token,
      email: state.email,
      lastCollection: state.currentCollection
    }, rememberMe);

    toast('Accesso effettuato!', 'success');
    showMainApp();
    loadAllData();
    fetchRepoTarget();
    checkCloudinaryConfig();
  } catch (e) {
    console.error(e);
    toast(mapApiError(0, { error: e.message }) || 'Errore login', 'error');
  } finally {
    hideLoading();
  }
}

function logout() {
  state.token = null;
  state.email = null;
  state.isLoggedIn = false;
  clearStoredSessions();
  showLoginScreen();
  toast('Logout effettuato', 'info');
}

/**
 * Aggiorna il codice del gestionale su TUTTI i dispositivi dei soci.
 * Pubblica una nuova cacheVersion (admin/version.json): al successivo caricamento
 * ogni dispositivo svuota SOLO la cache del Service Worker (shell HTML/JS/CSS) e ricarica.
 * NON tocca la SmartCache dei prodotti (IndexedDB) ne' la sessione: i soci restano loggati.
 */
async function refreshAllDevices() {
  if (!confirm('Aggiornare il gestionale su tutti i dispositivi dei soci?\n\nVerra\' ricaricato il codice dell\'app (nessun dato dei prodotti viene toccato e nessuno viene disconnesso).')) {
    return;
  }
  const btn = $('#refresh-devices-btn');
  if (btn) btn.disabled = true;
  try {
    const response = await fetch(API.bumpCacheVersion, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: state.token })
    });
    let body = {};
    try { body = await response.json(); } catch (_) { /* no-op */ }
    if (!response.ok || !body.success) {
      toast(mapApiError(response.status, body), 'error');
      return;
    }
    toast('Aggiornamento inviato: i dispositivi si aggiorneranno alla prossima apertura.', 'success', 6000);
  } catch (error) {
    toast('Rete non disponibile: riprova quando sei online.', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ========================================
// UI
// ========================================

function showLoginScreen() {
  $('#login-screen').classList.add('active');
  $('#main-app').classList.remove('active');
}

function showMainApp() {
  $('#login-screen').classList.remove('active');
  $('#main-app').classList.add('active');
}

function showListView(force = false) {
  if (!force && state.formDirty && $('#edit-view')?.classList.contains('active')) {
    if (!confirm('Modifiche non salvate. Uscire?')) return false;
  }
  state.formDirty = false;
  $('#list-view').classList.add('active');
  $('#edit-view').classList.remove('active');
  return true;
}

function showEditView() {
  $('#list-view').classList.remove('active');
  $('#edit-view').classList.add('active');
  updateOfflineUI();
}

function toggleSidebar() {
  $('#sidebar').classList.toggle('open');
  let overlay = $('.sidebar-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    overlay.addEventListener('click', closeSidebar);
    document.body.appendChild(overlay);
  }
  overlay.classList.toggle('active');
}

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  const overlay = $('.sidebar-overlay');
  if (overlay) overlay.classList.remove('active');
}

function showLoading() { $('#loading-overlay').classList.add('active'); }
function hideLoading() { $('#loading-overlay').classList.remove('active'); }

/** Toast: errori 8s, altri 3s */
function toast(message, type = 'info', durationMs) {
  const container = $('#toast-container');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = message;
  container.appendChild(t);
  const ms = durationMs != null ? durationMs : (type === 'error' ? 8000 : 3000);
  setTimeout(() => t.remove(), ms);
}

/** Mappa errori API comuni in messaggi IT user-friendly */
function mapApiError(status, body = {}) {
  const err = String(body.error || body.message || body.code || '');
  const lower = err.toLowerCase();

  if (status === 401 || lower.includes('sessione scaduta') || lower.includes('non valida') || lower.includes('unauthorized')) {
    return 'Sessione scaduta. Accedi di nuovo.';
  }
  if (status === 403 || lower.includes('forbidden') || lower.includes('permess')) {
    return 'Non hai i permessi per questa operazione.';
  }
  if (
    status === 409 ||
    lower.includes('conflitto') ||
    lower.includes('already exists') ||
    lower.includes('gia usata') ||
    lower.includes('già usata') ||
    lower.includes('esiste gia') ||
    lower.includes('esiste già')
  ) {
    return 'Un altro ha modificato questo elemento. Ricarica e riprova.';
  }
  if (status === 429 || lower.includes('rate limit') || lower.includes('too many')) {
    return 'Troppe richieste. Attendi un momento e riprova.';
  }
  if (
    err.includes('REPO_CONFIG_MISSING') ||
    err.includes('REPO_OWNER') ||
    err.includes('REPO_NAME') ||
    lower.includes('repo non configurat')
  ) {
    return 'Configurazione repository mancante. Contatta l\'amministratore.';
  }
  if (err.includes('GITHUB_TOKEN') || lower.includes('github_token') || lower.includes('token github')) {
    return 'Token GitHub non configurato. Contatta l\'amministratore.';
  }
  if (!navigator.onLine || lower.includes('failed to fetch') || lower.includes('networkerror')) {
    return 'Rete non disponibile, riprova';
  }
  return err || 'Errore imprevisto. Riprova.';
}

function isConflictResponse(status, body = {}) {
  const err = String(body.error || body.message || '');
  return status === 409 || /conflitto/i.test(err);
}

function notifyTargetRepo(target, prefix = 'Salvato su') {
  if (target && target.owner && target.repo) {
    state.repoTarget = target;
    updateRepoBadge();
    toast(`${prefix} ${target.owner}/${target.repo}`, 'info');
    console.log(`[CMS] ${prefix} ${target.owner}/${target.repo}`, target.branch || '');
  }
}

async function fetchRepoTarget() {
  if (!state.token) return;
  for (const action of ['whoami', 'health']) {
    try {
      const res = await fetch(API.saveData, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, token: state.token })
      });
      if (!res.ok) continue;
      const data = await res.json();
      const target = data.target || data.repo || null;
      if (target && target.owner && target.repo) {
        state.repoTarget = target;
        updateRepoBadge();
        return;
      }
    } catch (_) {
      /* opzionale: ignora */
    }
  }
}

function updateRepoBadge() {
  let badge = $('#repo-target-badge');
  if (!state.repoTarget?.owner || !state.repoTarget?.repo) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'repo-target-badge';
    badge.className = 'repo-target-badge';
    badge.title = 'Repository di destinazione';
    const header = $('.app-header');
    if (header) header.appendChild(badge);
    else return;
  }
  badge.textContent = `Repo: ${state.repoTarget.owner}/${state.repoTarget.repo}`;
}

// ========================================
// OFFLINE
// ========================================

function setupOfflineHandling() {
  state.isOffline = !navigator.onLine;
  updateOfflineUI();

  window.addEventListener('online', () => {
    state.isOffline = false;
    updateOfflineUI();
    toast('Connessione ripristinata', 'success');
  });

  window.addEventListener('offline', () => {
    state.isOffline = true;
    updateOfflineUI();
    toast('Sei offline. Salvataggio non disponibile.', 'error');
  });
}

function updateOfflineUI() {
  const offline = state.isOffline || !navigator.onLine;
  state.isOffline = offline;

  const banner = $('#offline-banner');
  if (banner) {
    banner.classList.toggle('show', offline);
    if (!banner.textContent.trim()) {
      banner.textContent = 'Sei offline — salvataggio e modifiche non disponibili';
    }
  }
  document.body.classList.toggle('is-offline', offline);

  const busy = state.isSaving || state.isDeleting;
  const blockWrite = offline || busy;

  const saveBtn = $('#save-btn');
  const deleteBtn = $('#delete-btn');
  if (saveBtn) {
    saveBtn.disabled = blockWrite || state.isSaving;
    saveBtn.title = offline ? 'Offline: salvataggio non disponibile' : '';
  }
  if (deleteBtn) {
    deleteBtn.disabled = blockWrite || state.isDeleting;
    deleteBtn.title = offline ? 'Offline: eliminazione non disponibile' : '';
  }

  document.querySelectorAll('.image-upload-btn').forEach(btn => {
    btn.disabled = offline;
    btn.title = offline ? 'Offline: upload non disponibile' : '';
  });

  ['#bulk-enable-btn', '#bulk-disable-btn'].forEach(sel => {
    const el = $(sel);
    if (el) {
      el.disabled = offline;
      el.title = offline ? 'Offline: operazione non disponibile' : '';
    }
  });

  document.querySelectorAll('.item-card[draggable]').forEach(card => {
    card.setAttribute('draggable', offline ? 'false' : 'true');
  });
}

function guardOnline(actionLabel = 'operazione') {
  if (state.isOffline || !navigator.onLine) {
    toast(`Offline: ${actionLabel} non disponibile`, 'error');
    return false;
  }
  return true;
}


// ========================================
// DATA LOADING (via Worker /api/* to avoid rate limits)
// ========================================

async function loadCategories() {
  try {
    const res = await fetch(API.readData, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: 'categorie' })
    });

    if (!res.ok) { state.categories = []; return; }

    const data = await res.json();
    // Usa parsedItem se disponibile (da JSON), altrimenti parse markdown
    const categories = data.items.map(item =>
      item.parsedItem
        ? { ...item.parsedItem, filename: item.filename, sha: item.sha }
        : parseMarkdown(item.content, item.filename, item.sha)
    );
    // Nel CMS mostra TUTTE le categorie (anche nascoste), ordinate
    state.categories = categories.sort(compareMenuItems);
  } catch (e) {
    console.error('Error loading categories:', e);
    state.categories = [];
  }
}

async function loadItems(collectionName, silent = false, forceApi = false) {
  if (!silent) showLoading();
  const collection = COLLECTIONS[collectionName];
  try {
    // 1. Try SmartCache first (instant load)
    if (window.SmartCache && !forceApi) {
      const cachedItems = await window.SmartCache.getAll('items');
      const collectionItems = cachedItems.filter(i => i._collection === collectionName && !i._deleted);

      if (collectionItems.length > 0) {
        console.log(`⚡ Loaded ${collectionItems.length} items from SmartCache`);
        state.items = collectionItems.sort(compareMenuItems);
        state.allItems[collectionName] = [...state.items];
        renderItems();
        if (!silent) hideLoading();
        // Continue to fetch fresh data in background...
        silent = true;
      }
    }

    // Se forceApi=true, usa API GitHub per avere dati freschi (dopo salvataggio)
    const requestBody = { folder: collection.folder };
    if (forceApi) {
      requestBody.mode = 'api';
      requestBody.token = state.token;
    }

    const res = await fetch(API.readData, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    // 503 json-miss: tieni cache (anti-wipe) — non azzerare la lista
    if (res.status === 503) {
      const errBody = await res.json().catch(() => ({}));
      if (errBody.source === 'json-miss' || !forceApi) {
        if (window.SmartCache) {
          const cachedItems = await window.SmartCache.getAll('items');
          const fromCache = cachedItems
            .filter(i => i._collection === collectionName && !i._deleted)
            .sort(compareMenuItems);
          if (fromCache.length > 0) {
            state.items = fromCache;
            state.allItems[collectionName] = [...state.items];
            renderItems();
            if (!silent) toast('Dati temporaneamente non disponibili: mostro ultima versione in cache', 'info');
            if (!silent) hideLoading();
            return;
          }
        }
        if (!silent) toast('Impossibile caricare i prodotti. Riprova.', 'error');
        if (!silent) hideLoading();
        return;
      }
    }

    if (!res.ok) {
      // 404 = folder doesn't exist yet (new category, no products) → treat as empty
      if (res.status === 404) {
        console.log(`Folder for "${collectionName}" not found — showing empty list`);
        state.items = [];
        renderItems();
        if (!silent) hideLoading();
        return;
      }
      throw new Error('Errore caricamento');
    }

    const data = await res.json();

    // json-miss / lista vuota sospetta: NON svuotare SmartCache né UI (anti-wipe prodotti)
    if (data.source === 'json-miss' || (Array.isArray(data.items) && data.items.length === 0 && !forceApi)) {
      if (window.SmartCache) {
        const cachedItems = await window.SmartCache.getAll('items');
        const fromCache = cachedItems
          .filter(i => i._collection === collectionName && !i._deleted)
          .sort(compareMenuItems);
        if (fromCache.length > 0) {
          console.warn(`[loadItems] ${collectionName}: remoto vuoto/json-miss — tengo ${fromCache.length} item in cache`);
          state.items = fromCache;
          state.allItems[collectionName] = [...state.items];
          renderItems();
          if (!silent) toast('Dati temporaneamente non disponibili: mostro ultima versione in cache', 'info');
          if (!silent) hideLoading();
          return;
        }
      }
      // Cache vuota e remoto vuoto → lista vuota legittima (nuova categoria)
      if (data.source === 'json-miss') {
        if (!silent) toast('Impossibile caricare i prodotti (JSON non disponibile). Riprova.', 'error');
        if (!silent) hideLoading();
        return;
      }
    }

    // Usa parsedItem se disponibile (da JSON), altrimenti parse markdown
    const items = (data.items || []).map(item =>
      item.parsedItem
        ? { ...item.parsedItem, filename: item.filename, sha: item.sha }
        : parseMarkdown(item.content, item.filename, item.sha)
    );
    state.items = items.sort(compareMenuItems);

    // Update SmartCache (silent: un solo render a fine load)
    if (window.SmartCache) {
      await window.SmartCache.syncCollection(
        state.items,
        collectionName,
        forceApi ? 'live' : 'static',
        { silent: true, allowEmptyRemote: forceApi === true }
      );

      const cachedItems = await window.SmartCache.getAll('items');
      state.items = cachedItems
        .filter(i => i._collection === collectionName && !i._deleted)
        .sort(compareMenuItems);

      // Dedup SOLO per filename (mai per nome: omonimi legittimi / Romagnola vs arnate-calcio)
      const seenFiles = new Set();
      state.items = state.items.filter(item => {
        const key = (item.filename || item._filename || item.id || '').toString();
        if (!key) return true;
        if (seenFiles.has(key)) return false;
        seenFiles.add(key);
        return true;
      });

      console.log('🔄 SmartCache synced & loaded. Items:', state.items.length);
    }

    state.allItems[collectionName] = [...state.items];
    renderItems();
  } catch (e) {
    console.error(e);
    if (!silent) toast('Errore nel caricamento', 'error');
  } finally {
    if (!silent) hideLoading();
  }
}

function parseMarkdown(content, filename, sha) {
  const match = content.match(/---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { filename, sha };
  const data = { filename, sha };
  let currentKey = null, inArray = false, arrayValues = [];
  match[1].split('\n').forEach(line => {
    line = line.replace(/\r$/, '');
    if (line.startsWith('  - ')) {
      arrayValues.push(line.replace('  - ', '').replace(/"/g, '').trim());
    } else if (line.includes(':')) {
      if (currentKey && inArray) { data[currentKey] = arrayValues; arrayValues = []; inArray = false; }
      const [key, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      currentKey = key.trim();
      if (value === '') { inArray = true; }
      else {
        let parsed = value.replace(/^["']|["']$/g, '');
        if (parsed === 'true') parsed = true;
        else if (parsed === 'false') parsed = false;
        // IMPORTANTE: Non convertire 'prezzo' in Number per preservare i decimali
        // (es: "14.50" rimarrebbe "14.50" come stringa invece di 14.5)
        else if (currentKey !== 'prezzo' && !isNaN(parsed) && parsed !== '') parsed = Number(parsed);
        data[currentKey] = parsed;
      }
    }
  });
  if (currentKey && inArray) data[currentKey] = arrayValues;
  return data;
}


// ========================================
// FILENAME MATCHING HELPER
// ========================================

function findFreshItem(freshItems, targetFilename, targetNome) {
  if (!freshItems || !freshItems.length) return null;
  // Primary: match by filename
  let found = freshItems.find(i => i.filename === targetFilename);
  if (found) return found;
  // Fallback: match by nome in markdown content
  if (!targetNome) return null;
  const normalizedTarget = targetNome.trim().toLowerCase();
  return freshItems.find(i => {
    if (!i.content) return false;
    const match = i.content.match(/nome:\s*"?([^"\n]+)"?/);
    return match && match[1].trim().toLowerCase() === normalizedTarget;
  });
}

// ========================================
// COLLECTION & RENDERING
// ========================================

function selectCollection(name, categoryFilter = null, beerSection = null) {
  const collection = COLLECTIONS[name];
  if (!collection) {
    console.warn(`Collection "${name}" not found in COLLECTIONS`);
    toast(`Collezione "${name}" non configurata nel CMS`, 'error');
    return;
  }

  // Dirty form: conferma prima di cambiare collection / uscire da edit
  if (state.formDirty && $('#edit-view')?.classList.contains('active')) {
    if (!confirm('Modifiche non salvate. Uscire?')) return;
    state.formDirty = false;
    $('#list-view').classList.add('active');
    $('#edit-view').classList.remove('active');
  }

  state.currentCollection = name;
  state.currentCategory = categoryFilter;
  state.currentBeerSection = beerSection;
  // Set title based on context
  let title = collection.label;
  if (beerSection) {
    title = beerSection;
  } else if (categoryFilter) {
    title = categoryFilter;
  }
  $('#collection-title').textContent = title;
  updateCategoryFilter(name);
  if (categoryFilter) {
    $('#filter-category').value = categoryFilter;
  }

  // Show/hide category-specific filters
  const catFilters = $('#category-filters');
  if (catFilters) {
    catFilters.style.display = name === 'categorie' ? 'flex' : 'none';
  }

  // Reset category filters when switching
  if (name !== 'categorie') {
    state.categoryFilters = { tipo: null, image: null };
    $$('.filter-chip').forEach(c => c.classList.remove('active'));
  }

  // Save last collection for session restore
  updateStoredSession({ lastCollection: name });

  loadItems(name);
  showListView();
}

// ========================================
// SIDEBAR TREE
// ========================================

async function loadAllData(silent = false) {
  if (!silent) showLoading();
  try {
    // Load categories first
    await loadCategories();

    // Load all food items for tree counts (usa JSON, no API)
    const res = await fetch(API.readData, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: 'food' })
    });
    if (res.ok) {
      const data = await res.json();
      // Usa parsedItem se disponibile (da JSON), altrimenti parse markdown
      state.allFood = data.items.map(item =>
        item.parsedItem
          ? { ...item.parsedItem, filename: item.filename, sha: item.sha }
          : parseMarkdown(item.content, item.filename, item.sha)
      );
    }

    // Clear cached items for global search to force refresh
    state.allItems = {};

    // Register dynamic COLLECTIONS for new beverage categories
    ensureDynamicCollections();
    if (!COLLECTIONS[state.currentCollection]) {
      state.currentCollection = 'food';
      updateStoredSession({ lastCollection: state.currentCollection });
    }

    renderSidebar();
    setupSidebarEvents();

    // Load current collection items (usa JSON per velocità)
    await loadItems(state.currentCollection, silent);

    // Pre-carica dati per ricerca globale in background (non blocca UI)
    preloadGlobalSearchData();
  } catch (e) {
    console.error('Error loading data:', e);
    if (!silent) toast('Errore caricamento dati', 'error');
  } finally {
    if (!silent) hideLoading();
  }
}

// Pre-carica tutti i dati per la ricerca globale in background
async function preloadGlobalSearchData() {
  const searchCollections = getSearchCollectionKeys();

  // Carica tutte le collezioni in parallelo in background
  const fetchPromises = searchCollections
    .filter(collName => !state.allItems[collName])
    .map(async (collName) => {
      try {
        const res = await fetch(API.readData, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: COLLECTIONS[collName].folder })
        });
        if (res.ok) {
          const data = await res.json();
          // Usa parsedItem se disponibile (da JSON), altrimenti parse markdown
          state.allItems[collName] = data.items.map(item =>
            item.parsedItem
              ? { ...item.parsedItem, filename: item.filename, sha: item.sha }
              : parseMarkdown(item.content, item.filename, item.sha)
          );
        }
      } catch (e) {
        console.error(`Preload error ${collName}:`, e);
      }
    });

  await Promise.all(fetchPromises);
  console.log('✅ Dati ricerca globale pre-caricati');
}

// Silent refresh - updates data without visual loading indicators
// Usa JSON statici (veloce, no rate limit)
async function silentRefresh() {
  try {
    await loadAllData(true);
    console.log('✅ Silent refresh completed');
  } catch (e) {
    console.error('Silent refresh error:', e);
  }
}

function renderSidebar() {
  const nav = $('#sidebar-nav');

  // Build parent→children map from parent_category field
  const childrenOf = {};
  state.categories.forEach(c => {
    if (c.parent_category) {
      if (!childrenOf[c.parent_category]) childrenOf[c.parent_category] = [];
      childrenOf[c.parent_category].push(c);
    }
  });
  Object.values(childrenOf).forEach(arr => arr.sort(compareMenuItems));

  // Top-level categories only (no parent_category)
  const foodCategories = state.categories.filter(c => c.tipo_menu === 'food' && !c.parent_category);
  const beverageCategories = state.categories.filter(c => c.tipo_menu === 'beverage' && !c.parent_category);

  // Separate beer categories from other beverages
  const beerCategories = beverageCategories.filter(c =>
    c.nome.toLowerCase().includes('birr') || c.nome.toLowerCase().includes('frigo')
  );
  const otherBeverages = beverageCategories.filter(c =>
    !c.nome.toLowerCase().includes('birr') && !c.nome.toLowerCase().includes('frigo')
  );

  // Count items per food category
  const foodCounts = {};
  (state.allFood || []).forEach(item => {
    const matchedCategory = state.categories.find(category =>
      category.tipo_menu === 'food' && matchesItemToCategory(item, category, 'category', 'category_slug')
    );
    const cat = matchedCategory?.nome || item.category || 'Altro';
    foodCounts[cat] = (foodCounts[cat] || 0) + 1;
  });

  // Helper: resolve beverage category → COLLECTIONS key
  const resolveBevCollection = (cat) => {
    const knownMap = {
      'Cocktails': 'cocktails', 'Analcolici': 'analcolici', 'Bibite': 'bibite',
      'Caffetteria': 'caffetteria', 'Bollicine': 'bollicine',
      'Bianchi fermi': 'bianchi-fermi', 'Vini rossi': 'vini-rossi'
    };
    const collectionKey = getCategoryCollectionKey(cat);
    return knownMap[cat.nome]
      || (COLLECTIONS[collectionKey] ? collectionKey : null)
      || (COLLECTIONS[slugify(cat.nome)] ? slugify(cat.nome) : null);
  };

  // Helper to render category image
  const renderCatThumb = (cat) => {
    let img = safeUrl(cat.immagine || '');
    if (img && !img.startsWith('http') && !img.startsWith('../')) {
      img = '../' + img;
    }
    const safeIcon = escapeHtml(cat.icona || '📦');
    return img
      ? `<img src="${escapeHtml(img)}" class="tree-item-thumb" alt="" onerror="this.outerHTML='<div class=\\'tree-item-thumb-placeholder\\'>${safeIcon}</div>'">`
      : `<div class="tree-item-thumb-placeholder">${safeIcon}</div>`;
  };

  // Helper per indicare se una categoria è nascosta nel frontend
  const hiddenBadge = (cat) => cat.visibile === false ? '<span class="hidden-badge" title="Nascosto nel menu">👁️‍🗨️</span>' : '';

  // Render a single food category (flat or with subcategories)
  const renderFoodCat = (cat) => {
    const subcats = childrenOf[cat.slug] || [];
    if (subcats.length > 0) {
      return `
        <div class="tree-subsection-inline">
          <div class="tree-header tree-header-inline${cat.visibile === false ? ' is-hidden' : ''}" data-collection="food" data-category="${escapeHtml(cat.nome)}" data-expandable="true">
            <span class="tree-toggle">▶</span>
            ${renderCatThumb(cat)}
            <span class="tree-label">${escapeHtml(cat.nome)}</span>
            ${hiddenBadge(cat)}
            <span class="tree-count">${foodCounts[cat.nome] || 0}</span>
          </div>
          <div class="tree-children tree-subsection">
            ${subcats.map(sub => `
              <div class="tree-item${sub.visibile === false ? ' is-hidden' : ''}" data-collection="food" data-category="${escapeHtml(sub.nome)}">
                ${renderCatThumb(sub)}
                <span class="tree-item-name">${escapeHtml(sub.nome)}</span>
                ${hiddenBadge(sub)}
                <span class="tree-item-count">${foodCounts[sub.nome] || 0}</span>
              </div>
            `).join('')}
          </div>
        </div>`;
    }
    return `
      <div class="tree-item${cat.visibile === false ? ' is-hidden' : ''}" data-collection="food" data-category="${escapeHtml(cat.nome)}">
        ${renderCatThumb(cat)}
        <span class="tree-item-name">${escapeHtml(cat.nome)}</span>
        ${hiddenBadge(cat)}
        <span class="tree-item-count">${foodCounts[cat.nome] || 0}</span>
      </div>`;
  };

  // Render a single beverage category (flat or with subcategories)
  const renderBevCat = (cat) => {
    const collection = resolveBevCollection(cat);
    const subcats = childrenOf[cat.slug] || [];

    if (subcats.length > 0) {
      // Parent with subcategories — expandable tree
      return `
        <div class="tree-section">
          <div class="tree-header${cat.visibile === false ? ' is-hidden' : ''}" ${collection ? `data-collection="${escapeHtml(collection)}"` : ''} data-expandable="true">
            <span class="tree-toggle">▶</span>
            ${renderCatThumb(cat)}
            <span class="tree-label">${escapeHtml(cat.nome)}</span>
            ${hiddenBadge(cat)}
          </div>
          <div class="tree-children tree-subsection">
            ${subcats.map(sub => {
              const subColl = resolveBevCollection(sub);
              if (!subColl) return `
                <div class="tree-item disabled${sub.visibile === false ? ' is-hidden' : ''}">
                  ${renderCatThumb(sub)}
                  <span class="tree-item-name">${escapeHtml(sub.nome)} ⚠️</span>
                  ${hiddenBadge(sub)}
                </div>`;
              return `
                <div class="tree-item${sub.visibile === false ? ' is-hidden' : ''}" data-collection="${escapeHtml(subColl)}">
                  ${renderCatThumb(sub)}
                  <span class="tree-item-name">${escapeHtml(sub.nome)}</span>
                  ${hiddenBadge(sub)}
                </div>`;
            }).join('')}
          </div>
        </div>`;
    }

    // No subcategories — flat item
    if (!collection) {
      return `
        <div class="tree-section">
          <div class="tree-item disabled${cat.visibile === false ? ' is-hidden' : ''}" title="Collezione non configurata">
            ${renderCatThumb(cat)}
            <span class="tree-item-name">${escapeHtml(cat.nome)} ⚠️</span>
            ${hiddenBadge(cat)}
          </div>
        </div>`;
    }
    return `
      <div class="tree-section">
        <div class="tree-item${cat.visibile === false ? ' is-hidden' : ''}" data-collection="${escapeHtml(collection)}">
          ${renderCatThumb(cat)}
          <span class="tree-item-name">${escapeHtml(cat.nome)}</span>
          ${hiddenBadge(cat)}
        </div>
      </div>`;
  };

  // Build tree HTML
  let html = `
    <!-- SEZIONE FOOD -->
    <div class="tree-section-title">🍽️ FOOD</div>
    
    <div class="tree-section">
      <div class="tree-header expanded" data-collection="food" data-expandable="true">
        <span class="tree-toggle">▶</span>
        <span class="tree-icon">🍽️</span>
        <span class="tree-label">Piatti</span>
        <span class="tree-count">${state.allFood?.length || 0}</span>
      </div>
      <div class="tree-children">
        ${foodCategories.map(renderFoodCat).join('')}
      </div>
    </div>
    
    <div class="tree-divider"></div>
    <div class="tree-section-title">🍺 BEVERAGE</div>
    
    <!-- Birre con sottosezioni -->
    <div class="tree-section">
      <div class="tree-header" data-collection="beers" data-expandable="true">
        <span class="tree-toggle">▶</span>
        <span class="tree-icon">🍺</span>
        <span class="tree-label">Birre</span>
      </div>
      <div class="tree-children tree-subsection">
        ${beerCategories.map(cat => `
          <div class="tree-item${cat.visibile === false ? ' is-hidden' : ''}" data-collection="beers" data-beer-section="${escapeHtml(cat.nome)}">
            ${renderCatThumb(cat)}
            <span class="tree-item-name">${escapeHtml(cat.nome)}</span>
            ${hiddenBadge(cat)}
          </div>
        `).join('')}
      </div>
    </div>
    
    <!-- Altre bevande (con supporto sotto-categorie) -->
    ${otherBeverages.map(renderBevCat).join('')}
    
    <div class="tree-divider"></div>
    <div class="tree-section-title">⚙️ IMPOSTAZIONI</div>
    
    <div class="tree-section">
      <div class="tree-item" data-collection="categorie">
        <div class="tree-item-thumb-placeholder">📁</div>
        <span class="tree-item-name">Categorie</span>
      </div>
    </div>
  `;

  nav.innerHTML = html;
}

function setupSidebarEvents() {
  // Expandable headers (both .tree-header and .tree-header-inline)
  document.querySelectorAll('[data-expandable]').forEach(header => {
    header.addEventListener('click', (e) => {
      e.stopPropagation();
      header.classList.toggle('expanded');

      // If clicking on collection header, also select it
      const collection = header.dataset.collection;
      if (collection) {
        const category = header.dataset.category || null;
        selectTreeItem(collection, category);
      }
    });
  });

  // Non-expandable headers (direct collection)
  document.querySelectorAll('.tree-header:not([data-expandable])').forEach(header => {
    header.addEventListener('click', () => {
      const collection = header.dataset.collection;
      if (collection) {
        selectTreeItem(collection, null);
        closeSidebar();
      }
    });
  });

  // Tree items (categories or collections)
  document.querySelectorAll('.tree-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const collection = item.dataset.collection;
      const category = item.dataset.category || null;
      const beerSection = item.dataset.beerSection || null;
      selectTreeItem(collection, category, beerSection);
      closeSidebar();
    });
  });
}

function selectTreeItem(collection, category, beerSection = null) {
  // Remove all active states
  document.querySelectorAll('.tree-header.active, .tree-header-inline.active, .tree-item.active').forEach(el => el.classList.remove('active'));

  // Set active state
  if (beerSection) {
    // Per le sottocategorie birre (usa data-beer-section)
    const item = $(`.tree-item[data-collection="${collection}"][data-beer-section="${beerSection}"]`);
    if (item) item.classList.add('active');
  } else if (category) {
    // Per le categorie food/beverage — check tree-item, tree-header, and tree-header-inline
    const item = $(`.tree-item[data-collection="${collection}"][data-category="${category}"]`);
    const header = $(`.tree-header[data-collection="${collection}"][data-category="${category}"]`);
    const inlineHeader = $(`.tree-header-inline[data-collection="${collection}"][data-category="${category}"]`);
    if (item) item.classList.add('active');
    if (header) header.classList.add('active');
    if (inlineHeader) inlineHeader.classList.add('active');
  } else {
    // Per le collezioni principali senza sottocategoria
    const header = $(`.tree-header[data-collection="${collection}"]`);
    const item = $(`.tree-item[data-collection="${collection}"]:not([data-category]):not([data-beer-section])`);
    if (header) header.classList.add('active');
    if (item) item.classList.add('active');
  }

  selectCollection(collection, category, beerSection);
}

function updateCategoryFilter(name) {
  const select = $('#filter-category');
  select.innerHTML = '<option value="">Tutte</option>';
  const collection = COLLECTIONS[name];
  const field = collection.fields.find(f => f.type === 'dynamic-select' || f.name === 'category' || f.name === 'sezione');
  if (field) {
    const options = field.type === 'dynamic-select' ? getCategoriesForType(field.categoryType) : field.options;
    if (options) options.forEach(opt => select.innerHTML += `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`);
  }
}

function getCategoriesForType(type) {
  const dynamic = state.categories.filter(c => c.tipo_menu === type).map(c => c.nome);
  if (type === 'food') {
    // Include any legacy category names still in use by existing products
    const legacyInUse = (state.allFood || [])
      .map(item => item.category)
      .filter(category => category && !dynamic.includes(category));
    return [...new Set([...dynamic, ...legacyInUse])];
  }
  return dynamic;
}

// Template fields for dynamically-created beverage collections
const BEVERAGE_FIELD_TEMPLATE = [
  { name: 'nome', label: 'Nome', type: 'text', required: true },
  { name: 'prezzo', label: 'Prezzo (€)', type: 'text', required: true },
  { name: 'descrizione', label: 'Descrizione', type: 'textarea' },
  { name: 'immagine_copertina', label: 'Immagine Copertina', type: 'image' },
  { name: 'immagine_avatar', label: 'Avatar', type: 'image' },
  { name: 'disponibile', label: 'Disponibile', type: 'toggle', default: true },
  { name: 'order', label: 'Ordine', type: 'number', default: 0 }
];

// Scans state.categories for beverage categories and dynamically registers
// COLLECTIONS entries for those that don't have a hardcoded collection.
// This enables the CMS to navigate to, create, and manage products in new beverage folders.
function ensureDynamicCollections() {
  const beverageCats = state.categories.filter(c => c.tipo_menu === 'beverage');

  for (const cat of beverageCats) {
    const collectionKey = getCategoryCollectionKey(cat);
    const folder = getCategoryFolder(cat);
    if (!collectionKey || !folder) continue;

    // Skip if a COLLECTIONS entry already exists
    if (COLLECTIONS[collectionKey]) continue;

    // Also check by name-derived slug
    const nameSlug = slugify(cat.nome);
    if (nameSlug && COLLECTIONS[nameSlug]) continue;

    // Register a new dynamic collection for this beverage category
    COLLECTIONS[collectionKey] = {
      label: cat.nome,
      folder,
      _dynamic: true,
      fields: [...BEVERAGE_FIELD_TEMPLATE]
    };
    console.log(`📦 Dynamic collection registered: ${collectionKey} → folder "${folder}" ("${cat.nome}")`);
  }
}

/** Riordino sicuro solo senza filtri (ordine = intera collection) */
function canReorderList() {
  if (state.isOffline || !navigator.onLine) return false;
  const search = ($('#search-input')?.value || '').trim();
  const category = $('#filter-category')?.value || '';
  const status = $('#filter-status')?.value || '';
  const chipActive = !!document.querySelector('#category-filters .filter-chip.active');
  return !search && !category && !status && !chipActive;
}

function renderItems() {
  const list = $('#items-list');
  if (!list) return;
  const items = getFilteredItems();
  const reorderOk = canReorderList();

  // Clear selection state
  state.selectedItems = [];
  updateBulkActionsBar();

  if (!items.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon" aria-hidden="true">📋</div>
        <h3>Nessun elemento</h3>
        <p>Clicca <strong>Nuovo</strong> per aggiungere il primo, oppure azzera i filtri di ricerca.</p>
      </div>`;
    updateOfflineUI();
    return;
  }
  const collection = COLLECTIONS[state.currentCollection];
  const isCategorie = state.currentCollection === 'categorie';

  let hint = '';
  if (!reorderOk && !state.isOffline) {
    hint = `<div class="reorder-hint" role="note">Per riordinare con trascina o frecce, azzera ricerca e filtri.</div>`;
  } else if (reorderOk) {
    hint = `<div class="reorder-hint reorder-hint--ok" role="note">Trascina dalla maniglia <span class="reorder-hint-grip">⋮⋮</span> oppure usa ↑ ↓ per cambiare l’ordine.</div>`;
  }

  if (collection.groupByCategory && state.currentCollection === 'food') {
    renderGroupedItems(items, reorderOk);
    list.insertAdjacentHTML('afterbegin', hint);
  } else {
    let html = hint;
    if (isCategorie) {
      html += `<div class="bulk-select-header">
        <label class="bulk-checkbox-label">
          <input type="checkbox" id="select-all-items" class="bulk-checkbox">
          <span>Seleziona tutto</span>
        </label>
      </div>`;
    }
    html += items.map(item => renderItemCard(item, isCategorie, reorderOk)).join('');
    list.innerHTML = html;

    if (isCategorie) {
      const selectAll = $('#select-all-items');
      if (selectAll) {
        selectAll.addEventListener('change', (e) => {
          const checkboxes = document.querySelectorAll('.item-checkbox');
          checkboxes.forEach(cb => {
            cb.checked = e.target.checked;
            toggleItemSelection(cb.dataset.filename, e.target.checked);
          });
        });
      }
    }
  }

  // Click / checkbox / freccia: delegation una sola volta via setupListInteractions
  setupListInteractions();
  setupDragAndDrop();
  updateOfflineUI();
}

function renderGroupedItems(items, reorderOk = canReorderList()) {
  const list = $('#items-list');
  const grouped = {};
  items.forEach(item => {
    const matchedCategory = state.categories.find(category =>
      category.tipo_menu === 'food' && matchesItemToCategory(item, category, 'category', 'category_slug')
    );
    const cat = matchedCategory?.nome || item.category || 'Altro';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  });
  let html = '';
  Object.keys(grouped).sort().forEach(cat => {
    const catData = state.categories.find(c => c.nome === cat);
    html += `<div class="category-group">
      <div class="category-header">
        <span class="category-icon">${escapeHtml(catData?.icona || '📦')}</span>
        <span class="category-name">${escapeHtml(cat)}</span>
        <span class="category-count">${grouped[cat].length}</span>
      </div>
      <div class="category-items" data-reorder-scope="group">${grouped[cat].map(item => renderItemCard(item, false, reorderOk)).join('')}</div>
    </div>`;
  });
  list.innerHTML = html;
}

function renderItemCard(item, showCheckbox = false, reorderOk = canReorderList()) {
  let thumb = item.immagine_avatar || item.immagine_copertina || item.immagine || '';

  // Fix relative paths for CMS (which is in /admin/)
  if (thumb && !thumb.startsWith('http') && !thumb.startsWith('../')) {
    thumb = '../' + thumb;
  }

  const safeThumb = safeUrl(thumb);
  const thumbHtml = safeThumb
    ? `<img src="${escapeHtml(safeThumb)}" class="item-thumb" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">`
    : '<div class="item-thumb-placeholder" aria-hidden="true">📷</div>';

  // For categories, show icon instead of price
  const isCategory = state.currentCollection === 'categorie';
  const metaHtml = isCategory
    ? `<span class="item-icon">${escapeHtml(item.icona || '📦')}</span>`
    : `<span class="item-price">€${formatPriceDisplay(item.prezzo)}</span>`;

  const statusOn = item.disponibile !== false && item.visibile !== false;
  const statusLabel = isCategory
    ? (item.visibile === false ? 'Nascosta' : 'Visibile')
    : (item.disponibile === false ? 'Non disponibile' : 'Disponibile');

  const safeFilename = escapeHtml(item.filename || '');

  // Checkbox for bulk selection (categories only)
  const checkboxHtml = showCheckbox
    ? `<label class="item-check-wrap" onclick="event.stopPropagation()">
        <input type="checkbox" class="item-checkbox" data-filename="${safeFilename}" aria-label="Seleziona ${escapeHtml(item.nome || '')}">
      </label>`
    : '';

  const reorderHtml = reorderOk
    ? `<div class="item-reorder">
        <button type="button" class="btn-reorder btn-reorder-up" data-filename="${safeFilename}" title="Sposta su" aria-label="Sposta su">↑</button>
        <div class="drag-handle" title="Trascina per riordinare" aria-label="Trascina per riordinare" role="button">
          <span></span><span></span><span></span>
        </div>
        <button type="button" class="btn-reorder btn-reorder-down" data-filename="${safeFilename}" title="Sposta giù" aria-label="Sposta giù">↓</button>
      </div>`
    : '';

  return `<div class="item-card ${statusOn ? '' : 'unavailable'}" data-filename="${safeFilename}" data-order="${escapeHtml(String(item.order || 0))}" draggable="false">
    ${reorderHtml}
    ${checkboxHtml}
    ${thumbHtml}
    <div class="item-info">
      <div class="item-name">${escapeHtml(item.nome || 'Senza nome')}</div>
      <div class="item-meta">
        ${metaHtml}
        <span class="item-status-pill ${statusOn ? 'is-on' : 'is-off'}">
          <span class="status-dot ${statusOn ? 'available' : 'unavailable'}"></span>
          ${statusLabel}
        </span>
      </div>
    </div>
    <span class="item-chevron" aria-hidden="true">›</span>
  </div>`;
}

function getFilteredItems() {
  let items = [...state.items];
  const search = $('#search-input').value.toLowerCase();
  const category = $('#filter-category').value;
  const status = $('#filter-status').value;

  // Text search
  if (search) {
    items = items.filter(i => {
      const nome = (i.nome || '').toLowerCase();
      const desc = (i.descrizione || '').toLowerCase();
      const tags = Array.isArray(i.tags) ? i.tags.join(' ').toLowerCase() : '';
      return nome.includes(search) || desc.includes(search) || tags.includes(search);
    });
  }

  // Category/section filter
  if (category) {
    const selectedCategory = state.categories.find(cat => cat.nome === category);
    items = items.filter(item => {
      if (selectedCategory?.tipo_menu === 'food') {
        return matchesItemToCategory(item, selectedCategory, 'category', 'category_slug');
      }

      return matchesItemToCategory(item, selectedCategory, 'sezione', 'sezione_slug')
        || matchesItemToCategory(item, selectedCategory, 'tipo', 'tipo_slug')
        || item.category === category
        || item.sezione === category
        || item.tipo === category;
    });
  }

  // Beer section filter (for beer subsections in sidebar)
  if (state.currentBeerSection && state.currentCollection === 'beers') {
    items = items.filter(i => i.sezione === state.currentBeerSection);
  }

  // Status filter
  if (status !== '') items = items.filter(i => (i.disponibile !== false) === (status === 'true'));

  // Category-specific filters (for Categorie section)
  if (state.currentCollection === 'categorie') {
    if (state.categoryFilters.tipo) {
      items = items.filter(i => i.tipo_menu === state.categoryFilters.tipo);
    }
    if (state.categoryFilters.image === 'yes') {
      items = items.filter(i => i.immagine && i.immagine.length > 0);
    } else if (state.categoryFilters.image === 'no') {
      items = items.filter(i => !i.immagine || i.immagine.length === 0);
    }
  }

  return items;
}

function filterItems() { renderItems(); }

// ========================================
// DRAG & DROP + FRECCE REORDERING
// ========================================

let draggedItem = null;
let dragArmed = false; // true solo dopo mousedown sulla maniglia
let listInteractionsBound = false;
let dndBound = false;

/** Event delegation lista: click card, checkbox, frecce (una sola volta) */
function setupListInteractions() {
  const list = $('#items-list');
  if (!list || listInteractionsBound) return;
  listInteractionsBound = true;

  list.addEventListener('click', (e) => {
    const up = e.target.closest('.btn-reorder-up');
    const down = e.target.closest('.btn-reorder-down');
    if (up || down) {
      e.preventDefault();
      e.stopPropagation();
      const filename = (up || down).dataset.filename;
      moveItemByDelta(filename, up ? -1 : 1);
      return;
    }

    if (e.target.closest('.item-checkbox') || e.target.closest('.item-check-wrap') || e.target.closest('.item-reorder')) {
      return;
    }

    const card = e.target.closest('.item-card');
    if (card && card.dataset.filename) {
      editItem(card.dataset.filename);
    }
  });

  list.addEventListener('change', (e) => {
    if (e.target.classList.contains('item-checkbox')) {
      e.stopPropagation();
      toggleItemSelection(e.target.dataset.filename, e.target.checked);
    }
  });
}

function setupDragAndDrop() {
  const list = $('#items-list');
  if (!list || dndBound) return;
  dndBound = true;

  // Arma il drag solo dalla maniglia (poi draggable sulla card)
  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || !canReorderList()) {
      dragArmed = false;
      return;
    }
    const card = handle.closest('.item-card');
    if (!card) return;
    dragArmed = true;
    card.setAttribute('draggable', 'true');
  });
  const disarm = () => {
    dragArmed = false;
    list.querySelectorAll('.item-card[draggable="true"]').forEach(c => {
      c.setAttribute('draggable', 'false');
    });
  };
  list.addEventListener('pointerup', disarm);
  list.addEventListener('pointercancel', disarm);
  list.addEventListener('dragstart', handleDragStart);
  list.addEventListener('dragend', handleDragEnd);
  list.addEventListener('dragover', handleDragOver);
  list.addEventListener('drop', handleDrop);
  list.addEventListener('dragenter', (e) => e.preventDefault());
}

function handleDragStart(e) {
  if (!canReorderList() || !dragArmed) {
    e.preventDefault();
    return;
  }
  const card = e.target.closest('.item-card');
  if (!card) {
    e.preventDefault();
    return;
  }

  draggedItem = card;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', card.dataset.filename);
  try {
    e.dataTransfer.setDragImage(card, 40, 28);
  } catch (_) { /* ignore */ }
}

function handleDragEnd(e) {
  const card = e.target.closest('.item-card') || draggedItem;
  if (card) {
    card.classList.remove('dragging');
    card.setAttribute('draggable', 'false');
  }
  document.querySelectorAll('.item-card.drag-over').forEach(el => el.classList.remove('drag-over'));
  draggedItem = null;
  dragArmed = false;
}

function handleDragOver(e) {
  if (!draggedItem || !canReorderList()) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const overCard = e.target.closest('.item-card');
  if (!overCard || overCard === draggedItem) return;

  // Stesso contenitore (lista piatta o category-items)
  const parent = overCard.parentNode;
  if (!parent || parent !== draggedItem.parentNode) return;

  const rect = overCard.getBoundingClientRect();
  const before = e.clientY < rect.top + rect.height / 2;
  if (before) {
    parent.insertBefore(draggedItem, overCard);
  } else {
    parent.insertBefore(draggedItem, overCard.nextSibling);
  }
}

async function handleDrop(e) {
  e.preventDefault();
  if (!draggedItem) return;
  if (!guardOnline('riordino') || !canReorderList()) {
    renderItems();
    return;
  }

  // Ordine finale = ordine DOM delle card nello stesso scope del drag
  const parent = draggedItem.parentNode;
  const cards = [...parent.querySelectorAll(':scope > .item-card')];
  const newOrderFilenames = cards.map(c => c.dataset.filename).filter(Boolean);

  const changed = applyFilenameOrderToState(newOrderFilenames, parent.classList.contains('category-items'));
  draggedItem.classList.remove('dragging');
  draggedItem = null;

  renderItems();
  if (changed.length > 0) {
    await saveNewOrder(changed);
  }
}

/**
 * Applica un nuovo ordine di filename a state.items.
 * Se scopeGroup: ricalcola solo l'ordine relativo di quel sottoinsieme (food per categoria).
 */
function applyFilenameOrderToState(orderedFilenames, scopeGroup = false) {
  if (!orderedFilenames.length) return [];

  if (scopeGroup) {
    // Riordina solo questi item tra loro mantenendo le posizioni globali min/max
    const subset = orderedFilenames
      .map(fn => state.items.find(i => i.filename === fn))
      .filter(Boolean);
    if (subset.length < 2) return [];

    const indices = subset
      .map(item => state.items.findIndex(i => i.filename === item.filename))
      .filter(i => i >= 0)
      .sort((a, b) => a - b);

    // Rimuovi subset e reinserisci nell'ordine DOM nelle stesse slot
    const byFile = new Map(subset.map(i => [i.filename, i]));
    const reordered = orderedFilenames.map(fn => byFile.get(fn)).filter(Boolean);
    indices.forEach((idx, i) => {
      state.items[idx] = reordered[i];
    });
  } else {
    // Lista piatta: ordine completo = DOM order; item non in lista restano in coda
    const byFile = new Map(state.items.map(i => [i.filename, i]));
    const next = [];
    orderedFilenames.forEach(fn => {
      if (byFile.has(fn)) {
        next.push(byFile.get(fn));
        byFile.delete(fn);
      }
    });
    byFile.forEach(item => next.push(item));
    state.items = next;
  }

  const changedItems = [];
  state.items.forEach((item, idx) => {
    if (Number(item.order) !== idx) {
      item.order = idx;
      changedItems.push(item);
    }
  });
  return changedItems;
}

async function moveItemByDelta(filename, delta) {
  if (!canReorderList() || !guardOnline('riordino')) {
    if (!canReorderList() && !state.isOffline) {
      toast('Azzera ricerca e filtri per riordinare', 'info');
    }
    return;
  }

  const idx = state.items.findIndex(i => i.filename === filename);
  if (idx < 0) return;
  const target = idx + delta;
  if (target < 0 || target >= state.items.length) return;

  const [moved] = state.items.splice(idx, 1);
  state.items.splice(target, 0, moved);

  const changedItems = [];
  state.items.forEach((item, i) => {
    if (Number(item.order) !== i) {
      item.order = i;
      changedItems.push(item);
    }
  });

  renderItems();
  if (changedItems.length) {
    await saveNewOrder(changedItems);
  }
}

async function saveNewOrder(changedItems) {
  if (!changedItems || changedItems.length === 0) return;
  if (!guardOnline('riordino')) {
    await loadItems(state.currentCollection, true);
    return;
  }

  // Evita salvataggi paralleli
  if (state._isUpdating) return;
  state._isUpdating = true;

  const saveIndicator = document.createElement('div');
  saveIndicator.className = 'order-save-indicator';
  saveIndicator.innerHTML = `<span class="order-save-spinner"></span> Salvando ordine (${changedItems.length})…`;
  document.body.appendChild(saveIndicator);

  try {
    const collection = COLLECTIONS[state.currentCollection];

    let result;
    try {
      result = await postBatchChunked(
        { token: state.token, action: 'batch-save-order', collection: collection.folder },
        changedItems.map(item => ({
          filename: item.filename,
          nome: item.nome,
          order: item.order
        })),
        (chunk, total) => {
          if (total > 1) {
            saveIndicator.innerHTML =
              `<span class="order-save-spinner"></span> Salvando ordine (blocco ${chunk}/${total})…`;
          }
        }
      );
    } catch (batchError) {
      if (isConflictResponse(batchError.status, batchError.body || {})) {
        toast(mapApiError(batchError.status, batchError.body || {}), 'error');
        if (confirm('Conflitto sull’ordine. Ricaricare la lista?')) {
          await loadItems(state.currentCollection, false, true);
        }
        saveIndicator.remove();
        return;
      }
      throw new Error(
        mapApiError(batchError.status, batchError.body || {}) || batchError.message || 'Errore salvataggio ordine'
      );
    }

    notifyTargetRepo(result.target);

    if (window.SmartCache) {
      for (const item of changedItems) {
        await window.SmartCache.set('items', {
          ...item,
          id: item.filename,
          _collection: state.currentCollection,
          _hash: window.SmartCache.generateHash(item),
          _lastUpdated: Date.now(),
          _writeTime: Date.now()
        });
      }
    }

    state.allItems[state.currentCollection] = [...state.items];

    saveIndicator.innerHTML = `✅ Ordine salvato (${result.updated || changedItems.length})`;
    saveIndicator.classList.add('success');
    setTimeout(() => saveIndicator.remove(), 1800);
    toast('Ordine aggiornato', 'success', 2500);
  } catch (e) {
    console.error('Error saving order:', e);
    saveIndicator.innerHTML = '❌ Errore salvataggio ordine';
    saveIndicator.classList.add('error');
    setTimeout(() => saveIndicator.remove(), 3200);
    toast(mapApiError(0, { error: e.message }), 'error');
    // Riallinea da server
    await loadItems(state.currentCollection, true);
  } finally {
    state._isUpdating = false;
  }
}

// ========================================
// SEARCH LIVE SUGGESTIONS
// ========================================

function handleSearchInput(e) {
  const query = e.target.value;

  // Show/hide clear button
  const clearBtn = $('#search-clear');
  clearBtn.classList.toggle('visible', query.length > 0);

  // Debounce search
  clearTimeout(state.searchTimeout);

  if (query.length < 2) {
    hideSearchSuggestions();
    filterItems();
    return;
  }

  state.searchTimeout = setTimeout(() => {
    showSearchSuggestions();
    filterItems();
  }, 250);
}

function handleSearchKeydown(e) {
  const suggestions = $('#search-suggestions');
  const items = suggestions.querySelectorAll('.suggestion-item');
  const highlighted = suggestions.querySelector('.suggestion-item.highlighted');

  if (e.key === 'Escape') {
    hideSearchSuggestions();
    return;
  }

  if (e.key === 'Enter') {
    if (highlighted) {
      e.preventDefault();
      highlighted.click();
    }
    return;
  }

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return;

    let idx = [...items].indexOf(highlighted);
    if (highlighted) highlighted.classList.remove('highlighted');

    if (e.key === 'ArrowDown') {
      idx = idx < items.length - 1 ? idx + 1 : 0;
    } else {
      idx = idx > 0 ? idx - 1 : items.length - 1;
    }

    items[idx].classList.add('highlighted');
    items[idx].scrollIntoView({ block: 'nearest' });
  }
}

function showSearchSuggestions() {
  const query = $('#search-input').value.toLowerCase();
  const suggestions = $('#search-suggestions');

  if (query.length < 2) {
    hideSearchSuggestions();
    return;
  }

  // Search in current items
  const matches = state.items.filter(item => {
    const nome = (item.nome || '').toLowerCase();
    const desc = (item.descrizione || '').toLowerCase();
    const cat = (item.category || item.sezione || '').toLowerCase();
    const tags = Array.isArray(item.tags) ? item.tags.join(' ').toLowerCase() : '';
    return nome.includes(query) || desc.includes(query) || cat.includes(query) || tags.includes(query);
  }).slice(0, 8);

  if (!matches.length) {
    suggestions.innerHTML = '<div class="search-no-results">Nessun risultato per "' + escapeHtml(query) + '"</div>';
    suggestions.classList.add('active');
    return;
  }

  suggestions.innerHTML = matches.map(item => {
    let thumb = item.immagine_avatar || item.immagine_copertina || item.immagine || '';
    if (thumb && !thumb.startsWith('http') && !thumb.startsWith('../')) {
      thumb = '../' + thumb;
    }
    const thumbHtml = thumb
      ? `<img src="${escapeHtml(safeUrl(thumb))}" class="suggestion-thumb" alt="" onerror="this.style.display='none'">`
      : '<div class="suggestion-thumb-placeholder">📷</div>';

    const cat = item.category || item.sezione || item.tipo_menu || '';
    const price = item.prezzo ? `€${formatPriceDisplay(item.prezzo)}` : '';

    return `<div class="suggestion-item" data-filename="${escapeHtml(item.filename)}">
      ${thumbHtml}
      <div class="suggestion-info">
        <div class="suggestion-name">${escapeHtml(item.nome || 'Senza nome')}</div>
        <div class="suggestion-meta">
          ${cat ? `<span class="suggestion-category">${escapeHtml(cat)}</span>` : ''}
          ${price ? `<span class="suggestion-price">${price}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  // Add click handlers
  suggestions.querySelectorAll('.suggestion-item').forEach(el => {
    el.addEventListener('click', () => {
      editItem(el.dataset.filename);
      hideSearchSuggestions();
      $('#search-input').value = '';
      $('#search-clear').classList.remove('visible');
    });
  });

  suggestions.classList.add('active');
}

function hideSearchSuggestions() {
  $('#search-suggestions').classList.remove('active');
}

function clearSearch() {
  $('#search-input').value = '';
  $('#search-clear').classList.remove('visible');
  hideSearchSuggestions();
  filterItems();
}

// ========================================
// CATEGORY FILTERS (for Categorie section)
// ========================================

function toggleCategoryFilter(chip) {
  const filterType = chip.dataset.filter;
  const filterValue = chip.dataset.value;

  // Toggle active state
  if (chip.classList.contains('active')) {
    chip.classList.remove('active');
    state.categoryFilters[filterType] = null;
  } else {
    // Deselect other chips of same type
    $$(`.filter-chip[data-filter="${filterType}"]`).forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.categoryFilters[filterType] = filterValue;
  }

  filterItems();
}

function resetCategoryFilters() {
  state.categoryFilters = { tipo: null, image: null };
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  filterItems();
}


// ========================================
// BULK SELECTION & ACTIONS (for Categories)
// ========================================

function toggleItemSelection(filename, selected) {
  if (selected) {
    if (!state.selectedItems.includes(filename)) {
      state.selectedItems.push(filename);
    }
  } else {
    state.selectedItems = state.selectedItems.filter(f => f !== filename);
  }
  updateBulkActionsBar();
}

function updateBulkActionsBar() {
  let bar = $('#bulk-actions-bar');
  const count = state.selectedItems.length;

  // Only show for categories section
  if (state.currentCollection !== 'categorie') {
    if (bar) bar.remove();
    return;
  }

  if (count === 0) {
    if (bar) bar.classList.remove('active');
    return;
  }

  // Create bar if doesn't exist
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'bulk-actions-bar';
    bar.className = 'bulk-actions-bar';
    bar.innerHTML = `
      <div class="bulk-info">
        <span class="bulk-count">0</span> selezionati
      </div>
      <div class="bulk-buttons">
        <button type="button" class="btn btn-small" id="bulk-enable-btn">
          ✅ Rendi visibili
        </button>
        <button type="button" class="btn btn-small btn-ghost" id="bulk-disable-btn">
          🚫 Nascondi
        </button>
        <button type="button" class="btn btn-small btn-ghost" id="bulk-clear-btn">
          ✕ Deseleziona
        </button>
      </div>
    `;
    document.querySelector('.main-content').appendChild(bar);

    // Add event listeners
    $('#bulk-enable-btn').addEventListener('click', () => bulkSetVisibility(true));
    $('#bulk-disable-btn').addEventListener('click', () => bulkSetVisibility(false));
    $('#bulk-clear-btn').addEventListener('click', clearBulkSelection);
  }

  // Update count
  bar.querySelector('.bulk-count').textContent = count;
  bar.classList.add('active');
  updateOfflineUI();
}

function clearBulkSelection() {
  state.selectedItems = [];
  document.querySelectorAll('.item-checkbox').forEach(cb => cb.checked = false);
  const selectAll = $('#select-all-items');
  if (selectAll) selectAll.checked = false;
  updateBulkActionsBar();
}

async function bulkSetVisibility(visible) {
  const count = state.selectedItems.length;
  if (count === 0) return;
  if (!guardOnline('operazioni bulk')) return;

  const actionLabel = visible ? 'rendere visibili' : 'nascondere';
  if (!confirm(`Vuoi ${actionLabel} ${count} categorie?`)) return;

  showLoading();
  state._isUpdating = true;

  try {
    // Commit atomico server-side (patch solo `visibile` + JSON) — zero N PUT, no desync.
    // Oltre MAX_BATCH_ITEMS la selezione viene spezzata in più commit atomici.
    const result = await postBatchChunked(
      { token: state.token, action: 'batch-set-visibility', collection: 'categorie', visibile: visible },
      state.selectedItems.map(filename => ({ filename }))
    );

    const updated = result.updated || 0;

    // Aggiorna UI/cache locale senza riscrivere altri campi
    for (const filename of state.selectedItems) {
      const item = state.items.find(i => i.filename === filename);
      if (item) item.visibile = visible;
      if (window.SmartCache) {
        const cached = await window.SmartCache.get('items', filename).catch(() => null);
        const base = cached || item || { filename };
        await window.SmartCache.set('items', {
          ...base,
          ...item,
          filename,
          id: filename,
          visibile: visible,
          _collection: 'categorie',
          _hash: window.SmartCache.generateHash({ ...base, ...item, visibile: visible }),
          _lastUpdated: Date.now(),
          _writeTime: Date.now()
        });
      }
    }

    if (updated > 0) {
      toast(
        `${updated} categorie ${visible ? 'rese visibili' : 'nascoste'}!` +
        (result.target ? ` (${result.target.owner}/${result.target.repo})` : ''),
        'success'
      );
    } else {
      toast('Nessuna modifica necessaria (già nello stato richiesto)', 'info');
    }

    await loadItems('categorie', true);
  } catch (e) {
    console.error('Bulk operation error:', e);
    toast(mapApiError(0, { error: e.message || 'Errore durante l\'operazione' }), 'error');
  } finally {
    state._isUpdating = false;
    hideLoading();
    clearBulkSelection();
  }

  // DO NOT reload from server immediately
  // await loadItems(state.currentCollection, true, true);
}


// ========================================
// EDIT FORM
// ========================================

function createNew() {
  state.currentItem = null;
  state.isNew = true;
  renderEditForm({});
  showEditView();
  $('#delete-btn').style.display = 'none';
}

function editItem(filename) {
  const item = state.items.find(i => i.filename === filename);
  if (!item) return;
  state.currentItem = item;
  state.isNew = false;
  renderEditForm(item);
  showEditView();
  $('#delete-btn').style.display = 'block';
}

function renderEditForm(data) {
  const collection = COLLECTIONS[state.currentCollection];
  const form = $('#edit-form');
  
  // Titolo dell'item in modifica (visibile soprattutto su mobile)
  const itemTitle = data.nome || '';
  const isNew = state.isNew;
  
  // Header con titolo prominente
  const headerHtml = `
    <div class="edit-form-header">
      <div class="edit-form-badge">${isNew ? '➕ Nuovo' : '✏️ Modifica'}</div>
      ${itemTitle ? `<div class="edit-form-title">${escapeHtml(itemTitle)}</div>` : ''}
    </div>
  `;

  form.innerHTML = headerHtml + collection.fields.map(field => {
    const value = data[field.name] ?? field.default ?? '';

    switch (field.type) {
      case 'text':
        return `<div class="form-group">
          <label class="form-label">${field.label}${field.required ? ' *' : ''}</label>
          <input type="text" name="${field.name}" class="form-input" value="${escapeHtml(value)}" ${field.autoSlug ? 'data-auto-slug="true"' : ''}>
          ${field.hint ? `<div class="form-hint">${field.hint}</div>` : ''}
        </div>`;

      case 'number':
        return `<div class="form-group">
          <label class="form-label">${field.label}</label>
          <input type="number" name="${field.name}" class="form-input" value="${value}">
        </div>`;

      case 'textarea':
        return `<div class="form-group">
          <label class="form-label">${field.label}</label>
          <textarea name="${field.name}" class="form-textarea">${escapeHtml(value)}</textarea>
        </div>`;

      case 'select':
        return `<div class="form-group">
          <label class="form-label">${field.label}</label>
          <select name="${field.name}" class="form-select">
            <option value="">-- Seleziona --</option>
            ${field.options.map(opt => `<option value="${escapeHtml(opt)}" ${value === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
          </select>
        </div>`;

      case 'dynamic-select':
        const cats = getCategoriesForType(field.categoryType);
        return `<div class="form-group">
          <label class="form-label">${field.label}</label>
          <select name="${field.name}" class="form-select">
            <option value="">-- Seleziona --</option>
            ${cats.map(opt => `<option value="${escapeHtml(opt)}" ${value === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
          </select>
        </div>`;

      case 'parent-category-select':
        // Show only top-level categories (no parent_category) excluding the current item
        const currentSlug = state.currentItem?.slug || '';
        const parentOpts = state.categories
          .filter(c => !c.parent_category && c.slug !== currentSlug)
          .sort(compareMenuItems);
        return `<div class="form-group">
          <label class="form-label">${field.label}</label>
          <select name="${field.name}" class="form-select" id="parent-category-select">
            <option value="">-- Nessuna (categoria principale) --</option>
            ${parentOpts.map(cat => `<option value="${escapeHtml(cat.slug)}" data-tipo="${escapeHtml(cat.tipo_menu)}" ${value === cat.slug ? 'selected' : ''}>${escapeHtml(cat.icona || '📁')} ${escapeHtml(cat.nome)} (${escapeHtml(cat.tipo_menu)})</option>`).join('')}
          </select>
          ${field.hint ? `<div class="form-hint">${field.hint}</div>` : ''}
        </div>`;

      case 'toggle':
        const checked = value === true || value === 'true' || (value === '' && field.default);
        return `<div class="form-group">
          <div class="toggle-wrapper">
            <label class="toggle">
              <input type="checkbox" name="${field.name}" ${checked ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label">${field.label}</span>
          </div>
        </div>`;

      case 'tags':
        const selected = Array.isArray(value) ? value : [];
        return `<div class="form-group">
          <label class="form-label">${field.label}</label>
          <div class="tags-input" data-field="${field.name}">
            ${field.options.map(opt => `<span class="tag-option ${selected.includes(opt) ? 'selected' : ''}" data-value="${opt}">${opt}</span>`).join('')}
          </div>
        </div>`;

      case 'image':
        return renderImageField(field, value);

      default: return '';
    }
  }).join('');

  // Dirty tracking
  state.formDirty = false;
  const markDirty = () => { state.formDirty = true; };
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);

  // Event handlers
  document.querySelectorAll('.tag-option').forEach(tag => tag.addEventListener('click', () => {
    tag.classList.toggle('selected');
    state.formDirty = true;
  }));

  // Auto-slug
  const nomeInput = form.querySelector('[name="nome"]');
  const slugInput = form.querySelector('[data-auto-slug="true"]');
  if (nomeInput && slugInput && state.isNew) {
    nomeInput.addEventListener('input', () => slugInput.value = slugify(nomeInput.value));
  }

  // Auto-fill tipo_menu when selecting a parent category
  const parentSelect = form.querySelector('#parent-category-select');
  const tipoSelect = form.querySelector('[name="tipo_menu"]');
  if (parentSelect && tipoSelect) {
    parentSelect.addEventListener('change', () => {
      const selected = parentSelect.options[parentSelect.selectedIndex];
      if (selected && selected.dataset.tipo) {
        tipoSelect.value = selected.dataset.tipo;
      }
    });
  }

  // Image upload handlers
  document.querySelectorAll('.image-upload-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!guardOnline('upload immagine')) return;
      const fieldName = btn.dataset.field;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = (e) => handleImageUpload(e, fieldName);
      input.click();
    });
  });

  // Image remove: azzera hidden + URL input + preview (niente URL residuo)
  document.querySelectorAll('.image-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const fieldName = btn.dataset.field;
      const container = form.querySelector(`[data-image-field="${fieldName}"]`);
      if (!container) return;
      const hiddenInput = container.querySelector(`input[type="hidden"][name="${fieldName}"]`);
      const urlInput = container.querySelector(`input[name="${fieldName}_url"]`);
      if (hiddenInput) hiddenInput.value = '';
      if (urlInput) urlInput.value = '';
      const preview = container.querySelector('.image-preview');
      if (preview) preview.innerHTML = '<div class="image-placeholder">📷 Nessuna immagine</div>';
      btn.style.display = 'none';
      state.formDirty = true;
    });
  });

  updateOfflineUI();
}


function renderImageField(field, value) {
  const hasImage = value && value.length > 0;

  // Fix relative paths for CMS (which is in /admin/)
  let displayValue = value || '';
  if (displayValue && !displayValue.startsWith('http') && !displayValue.startsWith('../') && !displayValue.startsWith('/')) {
    displayValue = '../' + displayValue;
  }
  displayValue = safeUrl(displayValue);

  const previewHtml = hasImage && displayValue
    ? `<img src="${escapeHtml(displayValue)}" alt="Preview" class="image-preview-img" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22%3E%3Crect fill=%22%23333%22 width=%22100%22 height=%22100%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22 fill=%22%23999%22 font-size=%2214%22%3E❌ Errore%3C/text%3E%3C/svg%3E'">`
    : '<div class="image-placeholder">📷 Nessuna immagine</div>';

  return `<div class="form-group">
    <label class="form-label">${field.label}</label>
    <div class="image-field" data-image-field="${field.name}">
      <div class="image-preview">${previewHtml}</div>
      <div class="image-actions">
        <button type="button" class="btn btn-small image-upload-btn" data-field="${field.name}">
          📤 ${state.cloudinaryConfigured ? 'Carica' : 'Scegli'} Immagine
        </button>
        <button type="button" class="btn btn-small btn-ghost image-remove-btn" data-field="${field.name}" style="display: ${hasImage ? 'inline-flex' : 'none'}">
          🗑️ Rimuovi
        </button>
      </div>
      <input type="hidden" name="${field.name}" value="${escapeHtml(value || '')}">
      <input type="text" name="${field.name}_url" class="form-input image-url-input" placeholder="Incolla URL immagine (es: https://...)" value="${escapeHtml(value || '')}" style="margin-top: 8px;">
    </div>
    ${field.hint ? `<div class="form-hint">${field.hint}</div>` : ''}
  </div>`;
}

async function handleImageUpload(e, fieldName) {
  const file = e.target.files[0];
  if (!file) return;
  if (!guardOnline('upload immagine')) return;

  const form = $('#edit-form');
  const container = form.querySelector(`[data-image-field="${fieldName}"]`);
  if (!container) {
    console.error('Container non trovato per:', fieldName);
    return;
  }

  const preview = container.querySelector('.image-preview');
  const hiddenInput = container.querySelector(`input[type="hidden"][name="${fieldName}"]`);
  const urlInput = container.querySelector(`input[name="${fieldName}_url"]`);
  const removeBtn = container.querySelector('.image-remove-btn');

  console.log('Upload image per campo:', fieldName);
  console.log('Hidden input trovato:', !!hiddenInput);
  console.log('URL input trovato:', !!urlInput);

  // Validazione lato client: un file non-immagine o enorme verrebbe comunque
  // rifiutato, ma solo dopo aver consumato banda e crediti Cloudinary.
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    toast('Formato non supportato. Usa JPEG, PNG, WebP o AVIF.', 'error');
    e.target.value = '';
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    toast(`Immagine troppo grande (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB).`, 'error');
    e.target.value = '';
    return;
  }

  // Show loading
  preview.innerHTML = '<div class="image-loading">⏳ Caricamento...</div>';

  // Preview immediata via object URL: nessuna copia Base64 del file in memoria.
  // Prima il file veniva sempre convertito in Base64 anche quando l'upload
  // diretto riusciva e quella copia non serviva a nessuno.
  const objectUrl = URL.createObjectURL(file);
  preview.innerHTML = `<img src="${escapeHtml(objectUrl)}" alt="Preview" class="image-preview-img">`;
  if (removeBtn) removeBtn.style.display = 'inline-flex';

  // Upload diretto a Cloudinary (firma dal Worker) con fallback al relay legacy
  try {
    const imageUrl = await uploadImageToCloudinary(file);

    if (imageUrl) {
      console.log('✅ URL Cloudinary ricevuto:', imageUrl);

      // Aggiorna ENTRAMBI gli input
      if (hiddenInput) hiddenInput.value = imageUrl;
      if (urlInput) urlInput.value = imageUrl;

      // Aggiorna preview con URL Cloudinary e libera l'object URL
      const safeCloudUrl = safeUrl(imageUrl);
      preview.innerHTML = safeCloudUrl
        ? `<img src="${escapeHtml(safeCloudUrl)}" alt="Preview" class="image-preview-img">`
        : '<div class="image-placeholder">📷 Preview non disponibile</div>';
      URL.revokeObjectURL(objectUrl);
      state.formDirty = true;
      toast('✅ Immagine caricata!', 'success');
      return;
    }
    toast('⚠️ Errore upload. Usa URL manuale.', 'error');
  } catch (err) {
    console.error('Upload failed:', err);
    toast(`⚠️ ${err.message || 'Upload fallito'}. Incolla URL manuale.`, 'error');
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Lettura del file non riuscita'));
    reader.readAsDataURL(file);
  });
}

/**
 * Upload immagine: prova l'upload diretto browser → Cloudinary usando la firma
 * generata dal Worker (/api/cloudinary-signature). Il file NON transita dal
 * server. Solo se quel percorso fallisce si costruisce il Base64 e si usa il
 * relay legacy (/api/upload-image), che resta per i client con Service Worker
 * ancora in cache. Ritorna l'URL https dell'immagine, oppure null.
 */
async function uploadImageToCloudinary(file) {
  // 1. Upload diretto (preferito: nessun limite payload del Worker)
  try {
    const sigRes = await fetch(API.cloudinarySignature, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: state.token })
    });
    const sig = await sigRes.json();

    if (sigRes.ok && sig.signature && sig.uploadUrl) {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('api_key', sig.apiKey);
      formData.append('timestamp', String(sig.timestamp));
      formData.append('signature', sig.signature);
      formData.append('folder', sig.folder);

      const uploadRes = await fetch(sig.uploadUrl, { method: 'POST', body: formData });
      const uploadData = await uploadRes.json();
      if (uploadRes.ok && uploadData.secure_url) {
        return uploadData.secure_url;
      }
      console.warn('Upload diretto Cloudinary fallito:', uploadData.error?.message || uploadRes.status);
    } else {
      console.warn('Firma Cloudinary non disponibile:', sig.error || sigRes.status);
    }
  } catch (err) {
    console.warn('Upload diretto non riuscito, provo il relay legacy:', err);
  }

  // 2. Fallback: relay legacy Base64 via Worker (Base64 costruito solo ora)
  const base64Data = await fileToDataUrl(file);
  const res = await fetch(API.uploadImage, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: state.token,
      file: base64Data
    })
  });
  const responseData = await res.json();
  if (res.ok && responseData.url) {
    return responseData.url;
  }
  console.error('Upload error:', responseData.error);
  throw new Error(responseData.error || 'Errore upload');
}

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Sanitizza URL per uso in attributi src (blocca javascript: e protocolli non sicuri) */
function safeUrl(url) {
  if (!url) return '';
  const s = String(url).trim();
  if (/^\s*javascript:/i.test(s) || /^\s*vbscript:/i.test(s) || /^\s*data:text\/html/i.test(s)) return '';
  return s;
}


// ========================================
// SAVE & DELETE
// ========================================

async function saveItem() {
  if (state.isSaving) return;
  if (!guardOnline('salvataggio')) return;

  const collection = COLLECTIONS[state.currentCollection];
  const form = $('#edit-form');
  const formData = new FormData(form);

  const data = {};
  collection.fields.forEach(field => {
    if (field.type === 'toggle') {
      data[field.name] = form.querySelector(`[name="${field.name}"]`).checked;
    } else if (field.type === 'tags') {
      const container = form.querySelector(`[data-field="${field.name}"]`);
      data[field.name] = [...container.querySelectorAll('.tag-option.selected')].map(el => el.dataset.value);
    } else if (field.type === 'number') {
      data[field.name] = parseInt(formData.get(field.name)) || 0;
    } else if (field.name === 'prezzo') {
      // Sanitizza il prezzo: accetta sia punto che virgola, normalizza con punto
      data[field.name] = sanitizePrice(formData.get(field.name));
    } else if (field.type === 'image') {
      // Priorità: URL input > hidden input (da upload Cloudinary)
      const urlInput = form.querySelector(`[name="${field.name}_url"]`);
      const hiddenInput = form.querySelector(`[name="${field.name}"]`);
      const urlValue = (urlInput && urlInput.value) || '';
      const hiddenValue = (hiddenInput && hiddenInput.value) || '';
      data[field.name] = urlValue || hiddenValue || '';
    } else {
      data[field.name] = formData.get(field.name) || '';
    }
  });

  // Validate
  const missing = collection.fields.filter(f => f.required && !data[f.name]).map(f => f.label);
  if (missing.length) {
    toast(`Compila: ${missing.join(', ')}`, 'error');
    return;
  }

  let filename = state.isNew ? `${slugify(data.nome || data.slug)}.md` : state.currentItem.filename;

  // Flag per evitare race condition con subscriber + double-submit
  state._isUpdating = true;
  state.isSaving = true;
  updateOfflineUI();
  showLoading();

  try {
    // Per file esistenti, SEMPRE recupera SHA fresco via API GitHub (non JSON!)
    let sha = null;
    if (!state.isNew && state.currentItem) {
      console.log('Recupero SHA per:', filename, 'in folder:', collection.folder);

      // IMPORTANTE: usa mode=api per forzare GitHub API e ottenere SHA
      const freshRes = await fetch(API.readData, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder: collection.folder,
          mode: 'api',
          token: state.token,
          filename,
          lookupName: data.nome
        })
      });

      if (freshRes.ok) {
        const freshData = await freshRes.json();
        console.log('Source:', freshData.source, '- Items trovati:', freshData.items?.length);

        const freshItem = findFreshItem(freshData.items || [], filename, data.nome);
        if (freshItem && freshItem.sha) {
          sha = freshItem.sha;
          // Correct filename if matched by name (different from stored filename)
          if (freshItem.filename !== filename) {
            const oldFilename = filename;
            console.log(`Filename corrected: ${oldFilename} → ${freshItem.filename}`);
            filename = freshItem.filename;
            // Remove orphaned SmartCache entry with old filename
            if (window.SmartCache) {
              await window.SmartCache.delete('items', oldFilename);
            }
          }
          console.log('SHA trovato:', sha);
        } else {
          console.log('File non trovato o SHA mancante, provo con SHA in memoria');
          sha = state.currentItem.sha;
        }
      } else {
        // Fallback a SHA in memoria
        sha = state.currentItem.sha;
        console.log('Fetch fallito, uso SHA in memoria:', sha);
      }

      if (!sha) {
        throw new Error('Impossibile recuperare SHA del file. Ricarica la pagina e riprova.');
      }
    }

    // Helper per la richiesta di salvataggio
    const performSave = async (fname) => {
      return fetch(API.saveData, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: state.token,
          action: 'save',
          collection: collection.folder,
          filename: fname,
          data: data,
          sha: sha
        })
      });
    };

    let res = await performSave(filename);
    let result = await res.json().catch(() => ({}));

    // Gestione collisioni per nuovi item (Errore 422 da GitHub: "sha wasn't supplied")
    // Se il file esiste già, GitHub richiede SHA. Se noi non l'abbiamo (perché è nuovo),
    // significa che c'è un conflitto di nomi.
    if (!res.ok && state.isNew && result.error && (result.error.includes('sha') || result.error.includes('422'))) {
      console.log('⚠️ Collisione rilevata per', filename, '- Tento con suffisso...');

      let counter = 1;
      const originalSlug = filename.replace('.md', '');

      // Riprova fino a 5 volte con suffissi incrementali
      while (counter <= 10) {
        const newFilename = `${originalSlug}-${counter}.md`;
        console.log('🔄 Riprovo salvataggio con:', newFilename);

        res = await performSave(newFilename);
        result = await res.json().catch(() => ({}));

        if (res.ok) {
          console.log('✅ Salvataggio riuscito con:', newFilename);
          filename = newFilename; // Aggiorna il filename per la cache
          break;
        }

        // Se l'errore non è di collisione (es. 500 o altro), fermati
        if (!result.error || (!result.error.includes('sha') && !result.error.includes('422'))) {
          break;
        }
        counter++;
      }
    }

    if (!res.ok) {
      if (isConflictResponse(res.status, result)) {
        toast(mapApiError(res.status, result), 'error');
        if (confirm('Un altro ha modificato questo elemento. Ricaricare la lista?')) {
          state.formDirty = false;
          showListView(true);
          await loadItems(state.currentCollection, false, true);
        }
        hideLoading();
        state._isUpdating = false;
        return;
      }
      throw new Error(mapApiError(res.status, result) || result.error || 'Errore salvataggio');
    }

    toast('Salvato!', 'success');
    notifyTargetRepo(result.target);

    // Aggiorna lo state locale PRIMA di notificare
    const newItem = { ...data, filename, sha: result.sha, _collection: state.currentCollection };
    
    // Aggiorna l'item nello state locale
    if (state.isNew) {
      state.items.push(newItem);
    } else {
      const idx = state.items.findIndex(i => i.filename === filename);
      if (idx !== -1) {
        state.items[idx] = { ...state.items[idx], ...newItem };
      }
    }
    state.allItems[state.currentCollection] = [...state.items];

    // ★ FIX: Sync state.categories when saving a category
    // Without this, getCategoriesForType() and renderSidebar() use stale data,
    // preventing product creation under newly-created categories.
    if (state.currentCollection === 'categorie') {
      if (state.isNew) {
        state.categories.push(newItem);
      } else {
        const catIdx = state.categories.findIndex(c => c.filename === filename);
        if (catIdx !== -1) {
          state.categories[catIdx] = { ...state.categories[catIdx], ...newItem };
        }
      }
      state.categories.sort(compareMenuItems);
      ensureDynamicCollections();
      renderSidebar();
      setupSidebarEvents();
    }

    // Update SmartCache
    if (window.SmartCache) {
      await window.SmartCache.set('items', {
        ...newItem,
        id: filename,
        _hash: window.SmartCache.generateHash(newItem),
        _lastUpdated: Date.now(),
        _writeTime: Date.now()
      });
    }

    // Show list view e rilascia il flag
    state.formDirty = false;
    showListView(true);
    hideLoading();
    state._isUpdating = false;

    // Notify DOPO aver rilasciato il flag
    if (window.SmartCache) {
      window.SmartCache.notifySubscribers({
        collection: state.currentCollection,
        updated: [newItem]
      });
    }
  } catch (e) {
    console.error(e);
    toast(e.message || 'Errore nel salvataggio', 'error');
    hideLoading();
    state._isUpdating = false;
  } finally {
    state.isSaving = false;
    updateOfflineUI();
  }
}

async function deleteItem() {
  if (!state.currentItem) return;
  if (state.isDeleting) return;
  if (!guardOnline('eliminazione')) return;
  if (!confirm(`Eliminare "${state.currentItem.nome}"?`)) return;

  // Flag per evitare race condition con subscriber + double-submit
  state._isUpdating = true;
  state.isDeleting = true;
  updateOfflineUI();
  showLoading();

  const collection = COLLECTIONS[state.currentCollection];
  const itemToDelete = { ...state.currentItem }; // Copia per eventuale rollback
  const originalItems = [...state.items]; // Backup per rollback

  try {
    let sha = state.currentItem.sha;

    // Recupera SHA fresco PRIMA di modificare la UI
    const fetchRes = await fetch(API.readData, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: collection.folder,
        mode: 'api',
        token: state.token,
        filename: itemToDelete.filename,
        lookupName: itemToDelete.nome
      })
    });

    if (fetchRes.ok) {
      const data = await fetchRes.json();
      const found = findFreshItem(data.items || [], itemToDelete.filename, itemToDelete.nome);
      if (found && found.sha) {
        sha = found.sha;
        // Correct filename if matched by name (different from stored filename)
        if (found.filename !== itemToDelete.filename) {
          const oldFilename = itemToDelete.filename;
          console.log(`Filename corrected: ${oldFilename} → ${found.filename}`);
          itemToDelete.filename = found.filename;
          // Remove orphaned SmartCache entry with old filename
          if (window.SmartCache) {
            await window.SmartCache.delete('items', oldFilename);
          }
        }
      }
    }

    if (!sha) {
      // Item might have been already deleted outside the CMS (ghost entry in JSON)
      state.items = state.items.filter(i => i.filename !== itemToDelete.filename);
      state.allItems[state.currentCollection] = [...state.items];
      if (window.SmartCache) {
        await window.SmartCache.set('items', {
          ...itemToDelete,
          id: itemToDelete.filename,
          _deleted: true,
          _writeTime: Date.now()
        });
      }
      renderItems();
      showListView();
      hideLoading();
      state._isUpdating = false;
      toast('Elemento non trovato sul server (potrebbe essere stato già eliminato). Rimosso dalla lista.', 'info');
      return;
    }

    // Rimuovi dalla UI DOPO aver verificato SHA (feedback ottimistico ma sicuro)
    state.items = state.items.filter(i => i.filename !== itemToDelete.filename);
    state.allItems[state.currentCollection] = [...state.items];
    renderItems();

    const res = await fetch(API.saveData, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: state.token,
        action: 'delete',
        collection: collection.folder,
        filename: itemToDelete.filename,
        sha: sha
      })
    });

    const result = await res.json().catch(() => ({}));
    
    if (!res.ok) {
      // ROLLBACK: ripristina l'item nella UI
      state.items = originalItems;
      state.allItems[state.currentCollection] = [...state.items];
      renderItems();
      if (isConflictResponse(res.status, result)) {
        toast(mapApiError(res.status, result), 'error');
        if (confirm('Un altro ha modificato questo elemento. Ricaricare la lista?')) {
          state.formDirty = false;
          showListView(true);
          await loadItems(state.currentCollection, false, true);
        }
        hideLoading();
        state._isUpdating = false;
        return;
      }
      throw new Error(mapApiError(res.status, result) || result.error || 'Errore eliminazione');
    }

    toast('Eliminato!', 'success');
    notifyTargetRepo(result.target, 'Eliminato su');

    // ★ FIX: Sync state.categories when deleting a category
    if (state.currentCollection === 'categorie') {
      state.categories = state.categories.filter(c => c.filename !== itemToDelete.filename);
      ensureDynamicCollections();
      renderSidebar();
      setupSidebarEvents();
    }

    // Update SmartCache con tombstone
    if (window.SmartCache) {
      await window.SmartCache.set('items', {
        ...itemToDelete,
        id: itemToDelete.filename,
        _deleted: true,
        _writeTime: Date.now()
      });
    }

    state.formDirty = false;
    showListView(true);
    hideLoading();
    state._isUpdating = false;

    // Notify DOPO aver rilasciato il flag
    if (window.SmartCache) {
      window.SmartCache.notifySubscribers({
        collection: state.currentCollection,
        removed: [itemToDelete]
      });
    }
  } catch (e) {
    console.error('Delete error:', e);
    // Assicura rollback in caso di errore
    if (state.items.length !== originalItems.length) {
      state.items = originalItems;
      renderItems();
    }
    state._isUpdating = false;
    toast(e.message || 'Errore eliminazione', 'error');
    hideLoading();
  } finally {
    state.isDeleting = false;
    updateOfflineUI();
  }
}

function slugify(text) {
  if (!text) return '';
  return text.toString().toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôõö]/g, 'o').replace(/[ùúûü]/g, 'u')
    .replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').substring(0, 50);
}


// ========================================
// GLOBAL SEARCH (Navbar)
// ========================================

function setupGlobalSearch() {
  const toggle = $('#global-search-toggle');
  const box = $('#global-search-box');
  const input = $('#global-search-input');
  const closeBtn = $('#global-search-close');

  if (!toggle || !box || !input) return;

  toggle.addEventListener('click', () => {
    box.classList.add('active');
    input.focus();
  });

  closeBtn.addEventListener('click', closeGlobalSearch);

  // Event listeners multipli per supporto iPad/tablet
  input.addEventListener('input', handleGlobalSearchInput);
  input.addEventListener('keyup', handleGlobalSearchChange); // Fallback per iPad
  input.addEventListener('keydown', handleGlobalSearchKeydown);
  input.addEventListener('change', handleGlobalSearchChange); // Per autocomplete

  // Touch-specific: su iPad a volte serve questo
  input.addEventListener('touchend', () => {
    // Piccolo delay per permettere l'aggiornamento del valore
    setTimeout(() => {
      if (input.value.trim().length >= 2) {
        performGlobalSearch(input.value.trim());
      }
    }, 50);
  });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#global-search-wrapper') && !e.target.closest('#global-search-toggle')) {
      closeGlobalSearch();
    }
  });
}

function closeGlobalSearch() {
  const box = $('#global-search-box');
  const input = $('#global-search-input');
  const results = $('#global-search-results');

  box.classList.remove('active');
  results.classList.remove('active');
  input.value = '';
}

function handleGlobalSearchInput(e) {
  const query = e.target.value.trim();

  clearTimeout(state.globalSearchTimeout);

  if (query.length < 2) {
    $('#global-search-results').classList.remove('active');
    return;
  }

  // Timeout breve per risposta rapida
  state.globalSearchTimeout = setTimeout(() => {
    performGlobalSearch(query);
  }, 100);
}

// Handler separato per iPad/touch - input event a volte non triggerato
function handleGlobalSearchChange(e) {
  // Chiama direttamente handleGlobalSearchInput
  handleGlobalSearchInput(e);
}

function handleGlobalSearchKeydown(e) {
  const results = $('#global-search-results');
  const items = results.querySelectorAll('.global-result-item');
  const highlighted = results.querySelector('.global-result-item.highlighted');

  if (e.key === 'Escape') {
    closeGlobalSearch();
    return;
  }

  if (e.key === 'Enter' && highlighted) {
    e.preventDefault();
    highlighted.click();
    return;
  }

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return;

    let idx = [...items].indexOf(highlighted);
    if (highlighted) highlighted.classList.remove('highlighted');

    if (e.key === 'ArrowDown') {
      idx = idx < items.length - 1 ? idx + 1 : 0;
    } else {
      idx = idx > 0 ? idx - 1 : items.length - 1;
    }

    items[idx].classList.add('highlighted');
    items[idx].scrollIntoView({ block: 'nearest' });
  }
}

async function performGlobalSearch(query) {
  const results = $('#global-search-results');
  const q = query.toLowerCase();

  // Mostra indicatore di caricamento
  results.innerHTML = '<div class="global-search-loading">🔍 Ricerca in corso...</div>';
  results.classList.add('active');

  // Search across all collections
  const allMatches = [];

  // Define collections to search
  const searchCollections = getSearchCollectionKeys();

  // Trova collezioni che devono essere caricate
  const collectionsToFetch = searchCollections.filter(c => !state.allItems[c]);

  // Carica tutte le collezioni mancanti IN PARALLELO (molto più veloce!)
  if (collectionsToFetch.length > 0) {
    try {
      const fetchPromises = collectionsToFetch.map(async (collName) => {
        try {
          const res = await fetch(API.readData, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: COLLECTIONS[collName].folder })
          });
          if (res.ok) {
            const data = await res.json();
            // Usa parsedItem se disponibile (da JSON), altrimenti parse markdown
            return {
              collName, items: data.items.map(item =>
                item.parsedItem
                  ? { ...item.parsedItem, filename: item.filename, sha: item.sha }
                  : parseMarkdown(item.content, item.filename, item.sha)
              )
            };
          }
        } catch (e) {
          console.error(`Error fetching ${collName}:`, e);
        }
        return { collName, items: [] };
      });

      const fetchResults = await Promise.all(fetchPromises);
      fetchResults.forEach(({ collName, items }) => {
        state.allItems[collName] = items;
      });
    } catch (e) {
      console.error('Error fetching collections:', e);
    }
  }

  // Ora cerca nei dati cachati (sincrono, velocissimo)
  for (const collName of searchCollections) {
    const items = state.allItems[collName] || [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const nome = String(item.nome || '').toLowerCase();
      // descrizione può essere stringa o array
      const descRaw = item.descrizione;
      const desc = (Array.isArray(descRaw) ? descRaw.join(' ') : String(descRaw || '')).toLowerCase();
      const cat = String(item.category || item.sezione || '').toLowerCase();
      const tags = Array.isArray(item.tags) ? item.tags.join(' ').toLowerCase() : '';

      // Ricerca ottimizzata con indexOf (più veloce di includes su mobile)
      if (nome.indexOf(q) !== -1 || desc.indexOf(q) !== -1 || cat.indexOf(q) !== -1 || tags.indexOf(q) !== -1) {
        allMatches.push({
          ...item,
          _collection: collName,
          _collectionLabel: COLLECTIONS[collName].label,
          _nameMatch: nome.indexOf(q) === 0 ? 2 : (nome.indexOf(q) !== -1 ? 1 : 0)
        });
      }
    }
  }

  // Sort by relevance (name starts with > name contains > other)
  allMatches.sort((a, b) => {
    if (a._nameMatch !== b._nameMatch) return b._nameMatch - a._nameMatch;
    return (a.nome || '').localeCompare(b.nome || '');
  });

  // Limit results
  const limitedMatches = allMatches.slice(0, 15);

  if (!limitedMatches.length) {
    results.innerHTML = '<div class="global-search-empty">Nessun risultato per "' + escapeHtml(query) + '"</div>';
    return;
  }

  // Usa DocumentFragment per rendering più veloce
  const fragment = document.createDocumentFragment();

  limitedMatches.forEach(item => {
    let thumb = item.immagine_avatar || item.immagine_copertina || item.immagine || '';
    if (thumb && !thumb.startsWith('http') && !thumb.startsWith('../')) {
      thumb = '../' + thumb;
    }

    const div = document.createElement('div');
    div.className = 'global-result-item';
    div.dataset.collection = item._collection;
    div.dataset.filename = item.filename;

    const thumbHtml = thumb
      ? `<img src="${escapeHtml(safeUrl(thumb))}" class="global-result-thumb" alt="" loading="lazy" onerror="this.style.display='none'">`
      : '<div class="global-result-placeholder">📷</div>';

    const price = item.prezzo ? `€${formatPriceDisplay(item.prezzo)}` : '';

    div.innerHTML = `
      ${thumbHtml}
      <div class="global-result-info">
        <div class="global-result-name">${escapeHtml(item.nome || 'Senza nome')}</div>
        <div class="global-result-meta">
          <span class="global-result-section">${escapeHtml(item._collectionLabel)}</span>
          ${price ? ` · ${price}` : ''}
        </div>
      </div>
    `;

    // Event listener diretto (più efficiente della delegazione per pochi elementi)
    div.addEventListener('click', () => {
      openGlobalSearchResult(item._collection, item.filename);
    });

    fragment.appendChild(div);
  });

  results.innerHTML = '';
  results.appendChild(fragment);
}

// Funzione separata per apertura risultato (evita ricreazione closure)
async function openGlobalSearchResult(collection, filename) {
  closeGlobalSearch();

  // Switch to the collection and load items
  state.currentCollection = collection;
  await loadItems(collection);

  // Find and edit the item
  const item = state.items.find(i => i.filename === filename);
  if (item) {
    editItem(filename);
  }
}
