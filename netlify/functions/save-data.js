// Netlify Function per salvare i dati
// Usa GitHub API con un Personal Access Token (PAT) salvato come variabile d'ambiente
// INCLUDE: Rigenerazione automatica JSON dopo ogni salvataggio

// Shared auth module (single source of truth)
const crypto = require('crypto');
const { generateToken, verifyToken, verifyLogin } = require('./auth');
const { resolveRepoConfig } = require('./repo-config');
const {
  BASE_BEVERAGE_CATEGORIES,
  findBeverageCategoryByFolder,
  getCategoryFolder,
  getFilenameBase,
  normalizeSlug,
  parseFrontmatter,
  stringifyFrontmatter
} = require('../../lib/menu-utils');

// CORS: domini noti + URL del sito Netlify corrente + ALLOWED_ORIGINS (env, virgola-separati)
// Così un nuovo *.netlify.app del cliente funziona senza patch al codice.
const BASE_ALLOWED_ORIGINS = [
  'https://arconti31.com',
  'https://www.arconti31.com',
  'https://arconti31.netlify.app',
  'http://localhost:8000',
  'http://localhost:3000'
];

// Login rate limit in-memory (reset su cold start accettabile su free tier)
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;

// Cache GET GitHub per-request: riduce chiamate ridondanti (categorie.json, snapshot, ecc.)
// senza cambiare il risultato. Invalidata su qualsiasi write.
let requestGetCache = null;

function beginRequestGetCache() {
  requestGetCache = new Map();
}

function endRequestGetCache() {
  requestGetCache = null;
}

/** Campi che non devono mai finire nei file markdown (derivati JSON / meta CMS) */
const MARKDOWN_STRIP_KEYS = new Set([
  '_filename', '_collection', '_hash', '_lastUpdated', '_writeTime', '_deleted',
  'filename', 'sha', 'id', 'fromJSON', 'parsedItem', 'content',
  'tipo' // derivato in beverages.json, non nel frontmatter sorgente
]);
const LOGIN_RATE_MAX = 10;
const LOGIN_ATTEMPTS_MAX_KEYS = 500;
const loginAttempts = new Map(); // key -> { count, firstAt }

function getClientIp(event) {
  // Prefer Netlify-provided IP (trusted) over client-supplied X-Forwarded-For (spoofable)
  const nfIp = event.headers['x-nf-client-connection-ip'];
  if (nfIp) return nfIp.trim();
  const clientIp = event.headers['client-ip'];
  if (clientIp) return clientIp.trim();
  const xff = event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For'] || '';
  if (xff) return String(xff).split(',')[0].trim();
  return 'unknown';
}

/** Evict stale keys; if still over hard cap, drop oldest first. */
function pruneLoginAttempts(now = Date.now()) {
  for (const [k, v] of loginAttempts) {
    if (now - v.firstAt > LOGIN_RATE_WINDOW_MS) loginAttempts.delete(k);
  }
  if (loginAttempts.size <= LOGIN_ATTEMPTS_MAX_KEYS) return;
  const sorted = [...loginAttempts.entries()].sort((a, b) => a[1].firstAt - b[1].firstAt);
  const excess = loginAttempts.size - LOGIN_ATTEMPTS_MAX_KEYS;
  for (let i = 0; i < excess; i++) {
    loginAttempts.delete(sorted[i][0]);
  }
}

function checkLoginRateLimit(ip, email) {
  const key = `${ip}|${String(email || '').toLowerCase().trim()}`;
  const now = Date.now();
  // Always prune: stale window + hard cap (prevents unbounded growth under IP rotation)
  pruneLoginAttempts(now);

  let entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAt > LOGIN_RATE_WINDOW_MS) {
    entry = { count: 0, firstAt: now };
    loginAttempts.set(key, entry);
  }
  entry.count += 1;

  if (entry.count > LOGIN_RATE_MAX) {
    return false;
  }
  return true;
}

function resetLoginRateLimit(ip, email) {
  const key = `${ip}|${String(email || '').toLowerCase().trim()}`;
  loginAttempts.delete(key);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getAllowedOrigins() {
  const origins = new Set(BASE_ALLOWED_ORIGINS);
  // Netlify injects URL / DEPLOY_PRIME_URL per il sito corrente
  [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL]
    .filter(Boolean)
    .forEach(u => {
      try {
        origins.add(new URL(u).origin);
      } catch (_) { /* ignore invalid */ }
    });
  // Extra origins configurabili: "https://a.netlify.app,https://altro.com"
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(o => origins.add(o.replace(/\/$/, '')));
  return [...origins];
}

function getCorsOrigin(event) {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowed = getAllowedOrigins();
  if (origin && allowed.includes(origin)) {
    return origin;
  }
  if (origin) {
    console.warn(`[CORS] Origin non consentito: ${origin}`);
  }
  // Non restituire allowed[0] come fallback — ometti ACAO
  return null;
}

function getHeaders(event) {
  const headers = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  const corsOrigin = getCorsOrigin(event);
  if (corsOrigin) {
    headers['Access-Control-Allow-Origin'] = corsOrigin;
  }
  return headers;
}

function repoConfigErrorResponse(headers, error) {
  return {
    statusCode: 500,
    headers,
    body: JSON.stringify({
      error: error.message || 'Configurazione repository mancante',
      code: error.code || 'REPO_CONFIG_MISSING'
    })
  };
}

exports.handler = async (event, context) => {
  beginRequestGetCache();
  try {
    return await handleSaveDataRequest(event);
  } finally {
    endRequestGetCache();
  }
};

async function handleSaveDataRequest(event) {
  const headers = getHeaders(event);

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Solo POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  // Parse body con gestione errori
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON non valido' }) };
  }
  
  const { email, password, action, collection, filename, data, sha, token, skipRegeneration } = body;

  // Validazione path traversal (sicurezza)
  if (collection && (collection.includes('..') || collection.includes('/') || collection.includes('\\'))) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Collection non valida' }) };
  }
  if (filename && (filename.includes('..') || filename.includes('/') || filename.includes('\\'))) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Filename non valido' }) };
  }

  // ==========================================
  // LOGIN (rate limit IP+email, no auth)
  // ==========================================
  if (action === 'login') {
    if (!email || !password) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email e password richiesti' }) };
    }

    const clientIp = getClientIp(event);
    if (!checkLoginRateLimit(clientIp, email)) {
      console.warn(`[login] Rate limit superato per ${clientIp} / ${email}`);
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({ error: 'Troppi tentativi di login. Riprova tra 15 minuti.' })
      };
    }

    const validEmail = verifyLogin(email, password);
    if (validEmail) {
      resetLoginRateLimit(clientIp, email);
      const newToken = generateToken(validEmail);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          token: newToken,
          email: validEmail,
          user: { email: validEmail, role: 'admin' }
        })
      };
    } else {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Credenziali non valide' }) };
    }
  }

  // ==========================================
  // VERIFICA TOKEN (Middleware) — tutte le altre action
  // ==========================================
  const authHeader = event.headers.authorization || event.headers.Authorization;
  const incomingToken = authHeader ? authHeader.replace('Bearer ', '') : token; // Use 'token' from body if no Bearer header
  const userEmail = verifyToken(incomingToken);

  if (!userEmail) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Sessione scaduta o non valida' }) };
  }

  // If action is 'verify-token', and we reached here, it means the token is valid (checked by middleware)
  if (action === 'verify-token') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ valid: true, email: userEmail })
    };
  }

  // Cloudinary config — richiede auth (spostato dopo middleware)
  if (action === 'get-cloudinary-config') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
        uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET || ''
      })
    };
  }

  // whoami — target repo + presenza token, senza leak
  if (action === 'whoami') {
    try {
      const cfg = resolveRepoConfig();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          target: { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch },
          hasToken: !!(process.env.GITHUB_TOKEN || '').trim()
        })
      };
    } catch (error) {
      if (error.code === 'REPO_CONFIG_MISSING') {
        return repoConfigErrorResponse(headers, error);
      }
      throw error;
    }
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  let REPO_OWNER;
  let REPO_NAME;
  let REPO_BRANCH;
  try {
    const cfg = resolveRepoConfig();
    REPO_OWNER = cfg.owner;
    REPO_NAME = cfg.repo;
    REPO_BRANCH = cfg.branch;
  } catch (error) {
    if (error.code === 'REPO_CONFIG_MISSING') {
      return repoConfigErrorResponse(headers, error);
    }
    throw error;
  }

  const target = { owner: REPO_OWNER, repo: REPO_NAME, branch: REPO_BRANCH };

  if (!GITHUB_TOKEN) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'GITHUB_TOKEN non configurato nelle variabili ambiente Netlify' })
    };
  }

  try {
    const path = `${collection}/${filename}`;

    if (action === 'save') {
      const preparedData = await prepareDataForSave(collection, data, GITHUB_TOKEN, REPO_OWNER, REPO_NAME, {
        filename,
        sha
      });
      await assertSafeCategorySave(collection, filename, preparedData, sha, GITHUB_TOKEN, REPO_OWNER, REPO_NAME);

      let result;
      if (skipRegeneration) {
        const content = generateMarkdown(preparedData);
        const base64Content = Buffer.from(content).toString('base64');

        const putBody = {
          message: `CMS: Update ${path}`,
          content: base64Content,
          branch: REPO_BRANCH
        };

        if (sha) {
          putBody.sha = sha;
        }

        result = await githubRequest(
          'PUT',
          `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`,
          putBody,
          GITHUB_TOKEN
        );
      } else {
        result = await saveItemAtomically({
          collection,
          filename,
          data: preparedData,
          sha,
          token: GITHUB_TOKEN,
          owner: REPO_OWNER,
          repo: REPO_NAME,
          branch: REPO_BRANCH
        });
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, sha: result.content?.sha, target })
      };

    } else if (action === 'delete') {
      console.log('Delete action - received sha:', sha, 'filename:', filename);

      if (!sha) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'SHA mancante per eliminazione' })
        };
      }

      await assertSafeCategoryDelete(collection, filename, GITHUB_TOKEN, REPO_OWNER, REPO_NAME);

      if (skipRegeneration) {
        const deleteBody = {
          message: `CMS: Delete ${path}`,
          sha: sha,
          branch: REPO_BRANCH
        };

        console.log('Sending to GitHub:', JSON.stringify(deleteBody));

        await githubRequest(
          'DELETE',
          `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`,
          deleteBody,
          GITHUB_TOKEN
        );
      } else {
        await deleteItemAtomically({
          collection,
          filename,
          token: GITHUB_TOKEN,
          owner: REPO_OWNER,
          repo: REPO_NAME,
          branch: REPO_BRANCH,
          sha
        });
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, target })
      };
    } else if (action === 'regenerate-json') {
      console.log(`📦 Rigenerazione JSON manuale per collection: ${collection}`);
      await regenerateJSON(collection, GITHUB_TOKEN, REPO_OWNER, REPO_NAME, REPO_BRANCH);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, target })
      };
    } else if (action === 'batch-set-visibility') {
      // ========================================
      // BATCH VISIBILITY: un commit atomico (niente N PUT + regenerate separato)
      // Patch SOLO `visibile` leggendo i .md reali — prezzi/altri campi intatti.
      // ========================================
      const visItems = body.items; // [{ filename }]
      const nextVisible = body.visibile === true || body.visibile === 'true';
      if (!collection || !Array.isArray(visItems) || !visItems.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing collection or items' }) };
      }

      const filenames = visItems.map(i => i.filename || i).filter(Boolean);
      const allItems = await readCollectionSnapshot(collection, GITHUB_TOKEN, REPO_OWNER, REPO_NAME)
        || await readCollectionFiles(collection, GITHUB_TOKEN, REPO_OWNER, REPO_NAME);

      if (!Array.isArray(allItems)) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Collection not found' }) };
      }

      const treeEntries = [];
      let updatedCount = 0;
      const byFile = new Map(allItems.map(i => [i._filename, i]));
      const expectedShas = []; // OCC: blob SHA letti prima del commit

      for (const filename of filenames) {
        let mdData;
        let blobSha = null;
        const repoPath = `${collection}/${filename}`;
        try {
          const meta = await readRepoFileWithMeta(
            repoPath,
            GITHUB_TOKEN,
            REPO_OWNER,
            REPO_NAME
          );
          mdData = parseFrontmatter(meta.content) || {};
          blobSha = meta.sha;
        } catch (e) {
          console.warn(`[batch-set-visibility] skip ${filename}: ${e.message}`);
          continue;
        }

        const currentVis = mdData.visibile !== false; // default true se assente
        if (currentVis === nextVisible) {
          // Allinea comunque lo snapshot in memoria
          if (byFile.has(filename)) byFile.get(filename).visibile = nextVisible;
          continue;
        }

        mdData.visibile = nextVisible;
        if (byFile.has(filename)) {
          byFile.get(filename).visibile = nextVisible;
        }

        // OCC solo per blob che stiamo davvero riscrivendo
        if (blobSha) expectedShas.push({ path: repoPath, sha: blobSha });

        treeEntries.push({
          path: repoPath,
          mode: '100644',
          type: 'blob',
          content: generateMarkdown(mdData)
        });
        updatedCount++;
      }

      if (treeEntries.length === 0) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, updated: 0, target })
        };
      }

      // JSON aggregato nello stesso commit (da snapshot aggiornato in memoria)
      const sorted = [...byFile.values()].sort((a, b) => (a.order || 0) - (b.order || 0));
      if (collection === 'categorie') {
        treeEntries.push({
          path: 'categorie/categorie.json',
          mode: '100644',
          type: 'blob',
          content: JSON.stringify({
            categories: sorted,
            foodCategories: sorted.filter(c => c.tipo_menu === 'food'),
            beverageCategories: sorted.filter(c => c.tipo_menu === 'beverage')
          }, null, 2)
        });
      } else {
        const cfg = await resolveCollectionConfig(collection, GITHUB_TOKEN, REPO_OWNER, REPO_NAME, {
          [collection]: sorted
        });
        if (cfg) {
          const jsonContent = await generateJSONForConfig(cfg, GITHUB_TOKEN, REPO_OWNER, REPO_NAME, {
            [collection]: sorted
          });
          if (jsonContent) {
            treeEntries.push({
              path: cfg.jsonPath,
              mode: '100644',
              type: 'blob',
              content: JSON.stringify(jsonContent, null, 2)
            });
          }
        }
      }

      await createCommitFromEntries({
        token: GITHUB_TOKEN,
        owner: REPO_OWNER,
        repo: REPO_NAME,
        message: `CMS: Batch visibility ${collection} (${updatedCount} → ${nextVisible ? 'visible' : 'hidden'})`,
        treeEntries,
        branch: REPO_BRANCH,
        preCommitCheck: makeBatchOccRecheck(
          expectedShas,
          GITHUB_TOKEN,
          REPO_OWNER,
          REPO_NAME,
          REPO_BRANCH
        )
      });

      console.log(`✅ Batch visibility: ${updatedCount} in ${collection}`);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, updated: updatedCount, target })
      };

    } else if (action === 'batch-save-order') {
      // ========================================
      // BATCH REORDER: un commit atomico.
      // SICUREZZA CONTENUTI: per ogni file con order cambiato si legge il .md reale
      // e si patcha SOLO `order` — mai dump dell'intero record JSON (evita prezzi/testi stale).
      // ========================================
      const orderItems = body.items;
      if (!collection || !orderItems || !orderItems.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing collection or items' }) };
      }

      const BRANCH = REPO_BRANCH;
      const orderMap = new Map(orderItems.map(i => [i.filename, i.order]));

      // Snapshot JSON per ricostruire il JSON aggregato (1 GET). Fallback MD se manca.
      const allItems = await readCollectionSnapshot(collection, GITHUB_TOKEN, REPO_OWNER, REPO_NAME)
        || await readCollectionFiles(collection, GITHUB_TOKEN, REPO_OWNER, REPO_NAME);

      if (!Array.isArray(allItems)) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Collection not found' }) };
      }

      const treeEntries = [];
      let updatedCount = 0;
      const expectedShas = []; // OCC: blob SHA letti prima del commit

      for (const item of allItems) {
        const newOrder = orderMap.get(item._filename);
        if (newOrder === undefined || Number(newOrder) === Number(item.order || 0)) {
          continue;
        }

        // Leggi markdown autoritativo e patcha solo order
        let mdData;
        let blobSha = null;
        const repoPath = `${collection}/${item._filename}`;
        try {
          const meta = await readRepoFileWithMeta(
            repoPath,
            GITHUB_TOKEN,
            REPO_OWNER,
            REPO_NAME
          );
          mdData = parseFrontmatter(meta.content) || {};
          blobSha = meta.sha;
        } catch (e) {
          console.warn(`[batch-save-order] skip ${item._filename}: ${e.message}`);
          continue;
        }

        mdData.order = Number.parseInt(newOrder, 10) || 0;
        item.order = mdData.order;

        if (blobSha) expectedShas.push({ path: repoPath, sha: blobSha });

        treeEntries.push({
          path: repoPath,
          mode: '100644',
          type: 'blob',
          content: generateMarkdown(mdData)
        });
        updatedCount++;
      }

      if (treeEntries.length === 0) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, updated: 0, target })
        };
      }

      const sorted = [...allItems].sort((a, b) => (a.order || 0) - (b.order || 0));
      let batchConfig = COLLECTION_CONFIG[collection];

      if (!batchConfig) {
        const categories = await readCollectionSnapshot('categorie', GITHUB_TOKEN, REPO_OWNER, REPO_NAME)
          || await readCollectionFiles('categorie', GITHUB_TOKEN, REPO_OWNER, REPO_NAME);
        const matchedCategory = findBeverageCategoryByFolder(categories, collection);
        if (matchedCategory) {
          batchConfig = {
            jsonPath: 'beverages/beverages.json',
            type: 'beverages',
            folder: getCategoryFolder(matchedCategory),
            name: matchedCategory.nome
          };
        }
      }

      if (batchConfig) {
        let jsonContent = null;

        if (batchConfig.type === 'categories') {
          jsonContent = {
            categories: sorted,
            foodCategories: sorted.filter(c => c.tipo_menu === 'food'),
            beverageCategories: sorted.filter(c => c.tipo_menu === 'beverage')
          };
        } else if (batchConfig.type === 'food') {
          const categories = await readCollectionSnapshot('categorie', GITHUB_TOKEN, REPO_OWNER, REPO_NAME)
            || await readCollectionFiles('categorie', GITHUB_TOKEN, REPO_OWNER, REPO_NAME);
          const foodCats = categories.filter(c => c.tipo_menu === 'food' && c.visibile !== false);
          const foodByCategory = {};
          foodCats.forEach(cat => { foodByCategory[cat.nome] = []; });
          sorted.forEach(row => {
            const cat = row.category || 'Altro';
            if (!foodByCategory[cat]) foodByCategory[cat] = [];
            foodByCategory[cat].push(row);
          });
          const categoryOrder = {};
          foodCats.forEach((cat, idx) => { categoryOrder[cat.nome] = cat.order || idx; });
          jsonContent = { food: sorted, foodByCategory, categoryOrder };
        } else if (batchConfig.type === 'beers') {
          const beersBySection = {};
          sorted.forEach(beer => {
            const sec = beer.sezione || 'Birre alla spina';
            if (!beersBySection[sec]) beersBySection[sec] = [];
            beersBySection[sec].push(beer);
          });
          jsonContent = { beers: sorted, beersBySection };
        } else if (batchConfig.type === 'beverages') {
          // Incremental: aggiorna solo order nella slice di questa cartella
          jsonContent = await generateJSONForConfig(batchConfig, GITHUB_TOKEN, REPO_OWNER, REPO_NAME, {
            [collection]: sorted
          });
        }

        if (jsonContent) {
          treeEntries.push({
            path: batchConfig.jsonPath,
            mode: '100644',
            type: 'blob',
            content: JSON.stringify(jsonContent, null, 2)
          });
        }
      }

      await createCommitFromEntries({
        token: GITHUB_TOKEN,
        owner: REPO_OWNER,
        repo: REPO_NAME,
        message: `CMS: Reorder ${collection} (${updatedCount} items)`,
        treeEntries,
        branch: BRANCH,
        preCommitCheck: makeBatchOccRecheck(
          expectedShas,
          GITHUB_TOKEN,
          REPO_OWNER,
          REPO_NAME,
          BRANCH
        )
      });

      console.log(`✅ Batch reorder: ${updatedCount} items in ${collection} (order-only MD patch)`);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, updated: updatedCount, target })
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Azione non valida' }) };

  } catch (error) {
    console.error('Error:', error);
    if (error.code === 'REPO_CONFIG_MISSING') {
      return repoConfigErrorResponse(headers, error);
    }
    return {
      statusCode: getErrorStatusCode(error),
      headers,
      body: JSON.stringify({ error: error.message || 'Unknown error' })
    };
  }
}

// ========================================
// GENERAZIONE MARKDOWN
// ========================================

/**
 * Scrive SOLO frontmatter prodotto. Strippa meta CMS e campi derivati JSON
 * (es. `tipo`) per non inquinare i .md al reorder/save.
 * NON altera prezzi/nomi: passa i campi di dominio così come sono.
 */
function generateMarkdown(data) {
  const clean = {};
  Object.keys(data || {}).forEach(key => {
    if (MARKDOWN_STRIP_KEYS.has(key)) return;
    if (key.startsWith('_')) return;
    clean[key] = data[key];
  });
  return stringifyFrontmatter(clean);
}

function calculateGitBlobSha(content) {
  return crypto
    .createHash('sha1')
    .update(`blob ${Buffer.byteLength(content, 'utf8')}\0${content}`, 'utf8')
    .digest('hex');
}

function getErrorStatusCode(error) {
  const message = String(error?.message || '');

  if (
    message.includes('Campi obbligatori') ||
    message.includes('Payload non valido') ||
    message.includes('Prezzo non valido') ||
    message.includes('Slug categoria non valido') ||
    message.includes('Categoria food non valida') ||
    message.includes('Sezione birra non valida') ||
    message.includes('tipo_menu categoria non valido') ||
    message.includes('Categoria padre') ||
    message.includes('Una categoria non puo avere se stessa come padre') ||
    message.includes('Impossibile modificare la categoria') ||
    message.includes('Impossibile eliminare la categoria')
  ) {
    return 400;
  }

  if (
    message.includes('Esiste gia una categoria') ||
    message.includes('gia usata') ||
    message.includes('already exists') ||
    message.includes('Conflitto: il contenuto è stato modificato')
  ) {
    return 409;
  }

  if (message.includes('File non trovato')) {
    return 404;
  }

  return 500;
}

function findCategoryByReference(categories = [], value, typeMenu = null) {
  const normalizedValue = normalizeSlug(value);
  if (!normalizedValue) return null;

  return categories.find(category =>
    (!typeMenu || category.tipo_menu === typeMenu) &&
    getCategoryReferenceAliases(category).includes(normalizedValue)
  ) || null;
}

async function loadCategoriesSnapshot(token, owner, repo) {
  return readCollectionSnapshot('categorie', token, owner, repo)
    || readCollectionFiles('categorie', token, owner, repo);
}

async function prepareDataForSave(collection, rawData = {}, token, owner, repo, options = {}) {
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    throw new Error('Payload non valido');
  }

  // Merge con .md esistente su UPDATE: preserva campi non presenti nel form
  // (es. legacy, note future) senza cancellarli. I campi del form vincono.
  let existing = {};
  if (options.sha && options.filename) {
    try {
      const mdContent = await readRepoFileContent(
        `${collection}/${options.filename}`,
        token,
        owner,
        repo
      );
      existing = parseFrontmatter(mdContent) || {};
    } catch (e) {
      console.warn(`[prepareDataForSave] merge skip: ${e.message}`);
    }
  }

  const overlay = { ...rawData };
  // Non far propagare meta CMS nel merge
  MARKDOWN_STRIP_KEYS.forEach(k => { delete overlay[k]; delete existing[k]; });
  Object.keys(overlay).forEach(k => { if (k.startsWith('_')) delete overlay[k]; });
  Object.keys(existing).forEach(k => { if (k.startsWith('_')) delete existing[k]; });

  const normalized = { ...existing, ...overlay };

  if (collection === 'categorie') {
    normalized.slug = normalizeSlug(normalized.slug || normalized.nome || '');
    if (!normalized.slug) {
      throw new Error('Slug categoria non valido');
    }

    const parentCategory = normalizeSlug(normalized.parent_category || '');
    if (parentCategory) {
      normalized.parent_category = parentCategory;
    } else {
      delete normalized.parent_category;
    }
  }

  if (normalized.prezzo !== undefined) {
    const priceValue = String(normalized.prezzo).replace(',', '.').trim();
    const parsedPrice = Number(priceValue);
    if (!Number.isFinite(parsedPrice)) {
      throw new Error('Prezzo non valido');
    }
    normalized.prezzo = parsedPrice.toFixed(2);
  }

  if (normalized.order !== undefined) {
    normalized.order = Number.parseInt(normalized.order, 10) || 0;
  }

  if (collection === 'food' || collection === 'beers' || !['categorie', 'food', 'beers'].includes(collection)) {
    const categories = await loadCategoriesSnapshot(token, owner, repo);

    if (collection === 'food') {
      const match = findCategoryByReference(categories, normalized.category, 'food');
      if (!match) {
        throw new Error('Categoria food non valida');
      }
      normalized.category = match.nome;
      normalized.category_slug = normalizeSlug(match.slug || match.nome);
    } else if (collection === 'beers') {
      const match = findCategoryByReference(categories, normalized.sezione, 'beverage');
      if (!match) {
        throw new Error('Sezione birra non valida');
      }
      normalized.sezione = match.nome;
      normalized.sezione_slug = normalizeSlug(match.slug || match.nome);
    } else {
      const match = findBeverageCategoryByFolder(categories, collection);
      if (match) {
        normalized.tipo_slug = normalizeSlug(match.slug || match.nome);
      }
    }
  }

  const parsed = parseMarkdownFrontmatter(generateMarkdown(normalized));
  validateRequiredFields(collection, parsed || {});
  return parsed || {};
}

function validateRequiredFields(collection, data) {
  const requiredFields = ['nome'];

  if (collection === 'food') {
    requiredFields.push('category', 'prezzo');
  } else if (collection === 'beers') {
    requiredFields.push('sezione', 'prezzo');
  } else if (collection === 'categorie') {
    requiredFields.push('slug', 'tipo_menu');
  } else {
    requiredFields.push('prezzo');
  }

  const missing = requiredFields.filter(field => {
    const value = data[field];
    return value === undefined || value === null || String(value).trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(`Campi obbligatori mancanti: ${missing.join(', ')}`);
  }

  if (collection === 'categorie') {
    if (!['food', 'beverage'].includes(data.tipo_menu)) {
      throw new Error('tipo_menu categoria non valido');
    }
    if (data.parent_category && normalizeSlug(data.parent_category) === normalizeSlug(data.slug)) {
      throw new Error('Una categoria non puo avere se stessa come padre');
    }
  }
}

function getCategoryReferenceAliases(category = {}) {
  const aliases = new Set();
  [category.nome, category.slug, category.folder, getFilenameBase(category._filename)].forEach(value => {
    const normalizedValue = normalizeSlug(value);
    if (normalizedValue) aliases.add(normalizedValue);
  });
  return [...aliases];
}

function matchesCategoryReference(value, aliases = []) {
  const normalizedValue = normalizeSlug(value);
  return normalizedValue ? aliases.includes(normalizedValue) : false;
}

function hasCategoryStructuralChange(previousCategory = {}, nextCategory = {}) {
  return (
    normalizeSlug(previousCategory.nome) !== normalizeSlug(nextCategory.nome) ||
    normalizeSlug(previousCategory.slug) !== normalizeSlug(nextCategory.slug) ||
    normalizeSlug(previousCategory.parent_category) !== normalizeSlug(nextCategory.parent_category) ||
    String(previousCategory.tipo_menu || '') !== String(nextCategory.tipo_menu || '')
  );
}

function buildCategoryDependencyError(actionLabel, category, dependents) {
  const parts = [];
  if (dependents.childCategories.length > 0) parts.push(`${dependents.childCategories.length} sottocategorie`);
  if (dependents.foodItems.length > 0) parts.push(`${dependents.foodItems.length} prodotti food`);
  if (dependents.beerItems.length > 0) parts.push(`${dependents.beerItems.length} birre collegate`);
  if (dependents.beverageItems.length > 0) parts.push(`${dependents.beverageItems.length} bevande collegate`);

  if (parts.length === 0) return null;

  return `Impossibile ${actionLabel} la categoria "${category.nome}": contiene o collega ancora ${parts.join(', ')}. Sposta prima i contenuti collegati.`;
}

async function readRepoFileContent(repoPath, token, owner, repo) {
  const fileData = await githubRequest('GET', `/repos/${owner}/${repo}/contents/${repoPath}`, null, token);
  return Buffer.from(fileData.content, 'base64').toString('utf-8');
}

/** Content + blob SHA for OCC recheck on batch commits */
async function readRepoFileWithMeta(repoPath, token, owner, repo) {
  const fileData = await githubRequest('GET', `/repos/${owner}/${repo}/contents/${repoPath}`, null, token);
  return {
    content: Buffer.from(fileData.content, 'base64').toString('utf-8'),
    sha: fileData.sha || null
  };
}

/**
 * Re-verify blob SHAs on NFF retry so batch commits don't silently clobber concurrent edits.
 * @param {{ path: string, sha: string }[]} expected
 */
function makeBatchOccRecheck(expected, token, owner, repo, branch = 'main') {
  const checks = (expected || []).filter(e => e && e.path && e.sha);
  if (!checks.length) return null;
  return async () => {
    for (const { path, sha } of checks) {
      try {
        const fileData = await githubRequest(
          'GET',
          `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
          null,
          token
        );
        if (fileData && fileData.sha && fileData.sha !== sha) {
          throw new Error('Conflitto: il contenuto è stato modificato. Ricarica e riprova.');
        }
      } catch (error) {
        if (String(error.message || '').includes('Conflitto:')) throw error;
        console.warn(`[batch OCC recheck] ${path}: ${error.message}`);
      }
    }
  };
}

async function readJsonFileFromRepo(repoPath, token, owner, repo) {
  return JSON.parse(await readRepoFileContent(repoPath, token, owner, repo));
}

function cloneCollectionItems(items = []) {
  return items.map(item => ({ ...item }));
}

async function readCategoryByFilename(filename, token, owner, repo) {
  const content = await readRepoFileContent(`categorie/${filename}`, token, owner, repo);
  const parsed = parseMarkdownFrontmatter(content);
  if (!parsed) return null;
  parsed._filename = filename;
  return parsed;
}

async function loadCategoryDependents(category, token, owner, repo, overrides = {}) {
  const aliases = getCategoryReferenceAliases(category);
  const categories = await readCollectionSnapshot('categorie', token, owner, repo, overrides)
    || await readCollectionFiles('categorie', token, owner, repo, overrides);
  const childCategories = categories.filter(item =>
    item._filename !== category._filename &&
    matchesCategoryReference(item.parent_category, aliases)
  );

  const foodItems = category.tipo_menu === 'food'
    ? ((await readCollectionSnapshot('food', token, owner, repo, overrides))
      || await readCollectionFiles('food', token, owner, repo, overrides))
      .filter(item => matchesCategoryReference(item.category, aliases))
    : [];

  const beerItems = category.tipo_menu === 'beverage'
    ? ((await readCollectionSnapshot('beers', token, owner, repo, overrides))
      || await readCollectionFiles('beers', token, owner, repo, overrides))
      .filter(item => matchesCategoryReference(item.sezione, aliases))
    : [];

  const beverageItems = category.tipo_menu === 'beverage'
    ? ((await readCollectionSnapshot(getCategoryFolder(category), token, owner, repo, overrides))
      || await readCollectionFiles(getCategoryFolder(category), token, owner, repo, overrides))
    : [];

  return { childCategories, foodItems, beerItems, beverageItems };
}

async function assertSafeCategorySave(collection, filename, nextData, sha, token, owner, repo) {
  if (collection !== 'categorie') return;

  const categories = await readCollectionSnapshot('categorie', token, owner, repo)
    || await readCollectionFiles('categorie', token, owner, repo);
  const normalizedNextSlug = normalizeSlug(nextData.slug);
  const nextCategoryCandidate = { ...nextData, _filename: filename };
  const nextFolder = nextData.tipo_menu === 'beverage' ? getCategoryFolder(nextCategoryCandidate) : null;

  const duplicateSlug = categories.find(category =>
    category._filename !== filename &&
    normalizeSlug(category.slug || category.nome) === normalizedNextSlug
  );
  if (duplicateSlug) {
    throw new Error(`Esiste gia una categoria con slug "${nextData.slug}"`);
  }

  if (nextFolder) {
    const duplicateFolder = categories.find(category =>
      category._filename !== filename &&
      category.tipo_menu === 'beverage' &&
      getCategoryFolder(category) === nextFolder
    );
    if (duplicateFolder) {
      throw new Error(`La cartella beverage "${nextFolder}" e gia usata da "${duplicateFolder.nome}"`);
    }
  }

  if (nextData.parent_category) {
    const parent = categories.find(category =>
      category._filename !== filename &&
      normalizeSlug(category.slug || category.nome) === normalizeSlug(nextData.parent_category)
    );
    if (!parent) {
      throw new Error('Categoria padre non trovata');
    }
    if (parent.tipo_menu !== nextData.tipo_menu) {
      throw new Error('La categoria padre deve avere lo stesso tipo_menu');
    }
    if (parent.parent_category) {
      throw new Error('La categoria padre deve essere di primo livello');
    }
  }

  if (!sha) return;

  const currentCategory = categories.find(category => category._filename === filename) || await readCategoryByFilename(filename, token, owner, repo);
  if (!currentCategory || !hasCategoryStructuralChange(currentCategory, nextData)) return;

  const dependents = await loadCategoryDependents(currentCategory, token, owner, repo);
  const dependencyError = buildCategoryDependencyError('modificare', currentCategory, dependents);
  if (dependencyError) {
    throw new Error(dependencyError);
  }
}

async function assertSafeCategoryDelete(collection, filename, token, owner, repo) {
  if (collection !== 'categorie') return;

  const currentCategory = await readCategoryByFilename(filename, token, owner, repo);
  if (!currentCategory) return;

  const dependents = await loadCategoryDependents(currentCategory, token, owner, repo);
  const dependencyError = buildCategoryDependencyError('eliminare', currentCategory, dependents);
  if (dependencyError) {
    throw new Error(dependencyError);
  }
}

function applySaveToCollectionItems(items, filename, data) {
  const nextItems = items.filter(item => item._filename !== filename);
  nextItems.push({ ...data, _filename: filename });
  nextItems.sort((a, b) => (a.order || 0) - (b.order || 0));
  return nextItems;
}

function applyDeleteToCollectionItems(items, filename) {
  return items
    .filter(item => item._filename !== filename)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

async function getBranchContext(token, owner, repo, branch = 'main') {
  const branchInfo = await githubRequest('GET', `/repos/${owner}/${repo}/branches/${branch}`, null, token);
  return {
    branch,
    latestCommitSha: branchInfo.commit.sha,
    baseTreeSha: branchInfo.commit.commit.tree.sha
  };
}

function isNonFastForwardError(error) {
  const message = String(error?.message || '');
  if (!message.includes('422')) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('not a fast forward') ||
    lower.includes('update is not a fast forward') ||
    lower.includes('fast-forward') ||
    lower.includes('does not point to') ||
    lower.includes('reference does not')
  );
}

async function createCommitFromEntries({ token, owner, repo, message, treeEntries, branch = 'main', preCommitCheck = null }) {
  if (!treeEntries.length) {
    throw new Error('Nessuna modifica da salvare');
  }

  // Retry su 422 non-fast-forward: re-leggi HEAD e riprova (max 2 retry = 3 tentativi)
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // M3: On retry, re-verify OCC SHA to avoid silently overwriting concurrent edits
      if (attempt > 0 && preCommitCheck) {
        await preCommitCheck();
      }

      const branchContext = await getBranchContext(token, owner, repo, branch);
      const newTree = await githubRequest(
        'POST',
        `/repos/${owner}/${repo}/git/trees`,
        { base_tree: branchContext.baseTreeSha, tree: treeEntries },
        token
      );

      const newCommit = await githubRequest(
        'POST',
        `/repos/${owner}/${repo}/git/commits`,
        {
          message,
          tree: newTree.sha,
          parents: [branchContext.latestCommitSha]
        },
        token
      );

      await githubRequest(
        'PATCH',
        `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
        { sha: newCommit.sha },
        token
      );

      return newCommit;
    } catch (error) {
      lastError = error;
      if (isNonFastForwardError(error) && attempt < 2) {
        console.warn(
          `[createCommitFromEntries] non-fast-forward su ${branch}, re-leggo HEAD (tentativo ${attempt + 1}/2)`
        );
        await sleep(300 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

async function resolveCollectionConfig(collection, token, owner, repo, overrides = {}) {
  let config = COLLECTION_CONFIG[collection];

  if (!config) {
    const categories = await readCollectionSnapshot('categorie', token, owner, repo, overrides)
      || await readCollectionFiles('categorie', token, owner, repo, overrides);
    const matchedCategory = findBeverageCategoryByFolder(categories, collection);
    if (matchedCategory) {
      config = {
        jsonPath: 'beverages/beverages.json',
        type: 'beverages',
        folder: getCategoryFolder(matchedCategory),
        name: matchedCategory.nome
      };
      console.log(`📦 Dynamic beverage folder detected: ${config.folder} → "${matchedCategory.nome}"`);
    }
  }

  return config || null;
}

async function readCollectionSnapshot(collection, token, owner, repo, overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, collection)) {
    return cloneCollectionItems(overrides[collection] || []);
  }

  const config = await resolveCollectionConfig(collection, token, owner, repo, overrides);
  if (!config) return null;

  try {
    const jsonData = await readJsonFileFromRepo(config.jsonPath, token, owner, repo);

    if (config.type === 'food') {
      return cloneCollectionItems(jsonData.food || []);
    }
    if (config.type === 'beers') {
      return cloneCollectionItems(jsonData.beers || []);
    }
    if (config.type === 'categories') {
      return cloneCollectionItems(jsonData.categories || []);
    }
    if (config.type === 'beverages') {
      return cloneCollectionItems((jsonData.beverages || []).filter(item => item.tipo === config.name));
    }
  } catch (error) {
    console.log(`⚠️ Snapshot fallback to markdown for ${collection}: ${error.message}`);
  }

  return null;
}

async function generateJSONForConfig(config, token, owner, repo, overrides = {}) {
  if (!config) return null;

  if (config.type === 'food') {
    return generateFoodJSON(token, owner, repo, overrides);
  }
  if (config.type === 'beers') {
    return generateBeersJSON(token, owner, repo, overrides);
  }
  if (config.type === 'categories') {
    return generateCategoriesJSON(token, owner, repo, overrides);
  }
  if (config.type === 'beverages') {
    const incremental = await generateIncrementalBeveragesJSON(config, token, owner, repo, overrides);
    if (incremental) return incremental;
    return generateBeveragesJSON(token, owner, repo, overrides);
  }

  return null;
}

async function buildJsonTreeEntry(collection, token, owner, repo, overrides = {}) {
  const config = await resolveCollectionConfig(collection, token, owner, repo, overrides);
  if (!config) return null;

  const jsonContent = await generateJSONForConfig(config, token, owner, repo, overrides);
  if (!jsonContent) return null;

  return {
    path: config.jsonPath,
    mode: '100644',
    type: 'blob',
    content: JSON.stringify(jsonContent, null, 2)
  };
}

async function generateIncrementalBeveragesJSON(config, token, owner, repo, overrides = {}) {
  if (!config?.folder || !Object.prototype.hasOwnProperty.call(overrides, config.folder)) {
    return null;
  }

  const displayName = config.name || BASE_BEVERAGE_CATEGORIES.find(category => category.folder === config.folder)?.name;
  if (!displayName) {
    return null;
  }

  try {
    const currentJson = JSON.parse(await readRepoFileContent(config.jsonPath, token, owner, repo));
    const currentByType = { ...(currentJson.beveragesByType || {}) };
    const updatedItems = (overrides[config.folder] || [])
      .map(item => ({ ...item, tipo: displayName }))
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    if (updatedItems.length > 0) {
      currentByType[displayName] = updatedItems;
    } else {
      delete currentByType[displayName];
    }

    const orderedKeys = Object.keys(currentJson.beveragesByType || {});
    if (updatedItems.length > 0 && !orderedKeys.includes(displayName)) {
      orderedKeys.push(displayName);
    }

    const nextByType = {};
    orderedKeys.forEach(key => {
      if (currentByType[key]?.length) {
        nextByType[key] = currentByType[key];
      }
    });

    Object.keys(currentByType).forEach(key => {
      if (!nextByType[key] && currentByType[key]?.length) {
        nextByType[key] = currentByType[key];
      }
    });

    const beverages = [];
    Object.values(nextByType).forEach(items => beverages.push(...items));

    return {
      beverages,
      beveragesByType: nextByType
    };
  } catch (error) {
    console.log(`⚠️ Fallback full beverages regen: ${error.message}`);
    return null;
  }
}

async function saveItemAtomically({ collection, filename, data, sha, token, owner, repo, branch = 'main' }) {
  const existingItems = await readCollectionSnapshot(collection, token, owner, repo)
    || await readCollectionFiles(collection, token, owner, repo);
  const fileExists = existingItems.some(item => item._filename === filename);

  if (!sha && fileExists) {
    throw new Error('GitHub API error: 422 - File already exists');
  }
  if (sha && !fileExists) {
    throw new Error('File non trovato per aggiornamento');
  }

  // Optimistic concurrency: se sha fornito e file esiste, confronta con SHA blob attuale
  if (sha && fileExists) {
    try {
      const fileData = await githubRequest(
        'GET',
        `/repos/${owner}/${repo}/contents/${collection}/${filename}?ref=${encodeURIComponent(branch)}`,
        null,
        token
      );
      if (fileData && fileData.sha && fileData.sha !== sha) {
        throw new Error('Conflitto: il contenuto è stato modificato. Ricarica e riprova.');
      }
    } catch (error) {
      if (String(error.message || '').includes('Conflitto:')) {
        throw error;
      }
      // 404 o altri errori di lettura: non bloccare se lo snapshot dice che esiste
      // (ma se GitHub dice SHA diverso l'abbiamo già gestito sopra)
      if (String(error.message || '').includes('409') || String(error.message || '').includes('Conflitto')) {
        throw error;
      }
      console.warn(`[saveItemAtomically] Impossibile verificare SHA attuale: ${error.message}`);
    }
  }

  const updatedItems = applySaveToCollectionItems(existingItems, filename, data);
  const fileContent = generateMarkdown(data);
  const fileSha = calculateGitBlobSha(fileContent);
  const treeEntries = [
    {
      path: `${collection}/${filename}`,
      mode: '100644',
      type: 'blob',
      content: fileContent
    }
  ];

  const jsonEntry = await buildJsonTreeEntry(collection, token, owner, repo, {
    [collection]: updatedItems
  });
  if (jsonEntry) {
    treeEntries.push(jsonEntry);
  }

  // M3: Re-verify SHA on each retry to prevent OCC bypass after concurrent write
  const occRecheck = sha ? async () => {
    try {
      const fileData = await githubRequest(
        'GET',
        `/repos/${owner}/${repo}/contents/${collection}/${filename}?ref=${encodeURIComponent(branch)}`,
        null,
        token
      );
      if (fileData && fileData.sha && fileData.sha !== sha) {
        throw new Error('Conflitto: il contenuto è stato modificato. Ricarica e riprova.');
      }
    } catch (error) {
      if (String(error.message || '').includes('Conflitto:')) throw error;
      console.warn(`[saveItemAtomically] OCC recheck: ${error.message}`);
    }
  } : null;

  const commit = await createCommitFromEntries({
    token,
    owner,
    repo,
    message: `CMS: Update ${collection}/${filename}`,
    treeEntries,
    branch,
    preCommitCheck: occRecheck
  });

  return {
    sha: fileSha,
    content: { sha: fileSha },
    commit
  };
}

async function deleteItemAtomically({ collection, filename, token, owner, repo, branch = 'main', sha = null }) {
  const existingItems = await readCollectionSnapshot(collection, token, owner, repo)
    || await readCollectionFiles(collection, token, owner, repo);
  const fileExists = existingItems.some(item => item._filename === filename);
  if (!fileExists) {
    // Verifica su GitHub: lo snapshot potrebbe essere stale
    try {
      await githubRequest(
        'GET',
        `/repos/${owner}/${repo}/contents/${collection}/${filename}?ref=${encodeURIComponent(branch)}`,
        null,
        token
      );
    } catch (e) {
      throw new Error('File non trovato per eliminazione');
    }
  }

  // OCC: se il client manda sha, confronta con blob attuale
  if (sha) {
    try {
      const fileData = await githubRequest(
        'GET',
        `/repos/${owner}/${repo}/contents/${collection}/${filename}?ref=${encodeURIComponent(branch)}`,
        null,
        token
      );
      if (fileData && fileData.sha && fileData.sha !== sha) {
        throw new Error('Conflitto: il contenuto è stato modificato. Ricarica e riprova.');
      }
    } catch (error) {
      if (String(error.message || '').includes('Conflitto:')) throw error;
      console.warn(`[deleteItemAtomically] SHA check: ${error.message}`);
    }
  }

  const updatedItems = applyDeleteToCollectionItems(existingItems, filename);
  const treeEntries = [
    {
      path: `${collection}/${filename}`,
      mode: '100644',
      type: 'blob',
      sha: null
    }
  ];

  const jsonEntry = await buildJsonTreeEntry(collection, token, owner, repo, {
    [collection]: updatedItems
  });
  if (jsonEntry) {
    treeEntries.push(jsonEntry);
  }

  // M3: Re-verify SHA on each retry to prevent OCC bypass after concurrent write
  const occRecheck = sha ? async () => {
    try {
      const fileData = await githubRequest(
        'GET',
        `/repos/${owner}/${repo}/contents/${collection}/${filename}?ref=${encodeURIComponent(branch)}`,
        null,
        token
      );
      if (fileData && fileData.sha && fileData.sha !== sha) {
        throw new Error('Conflitto: il contenuto è stato modificato. Ricarica e riprova.');
      }
    } catch (error) {
      if (String(error.message || '').includes('Conflitto:')) throw error;
      console.warn(`[deleteItemAtomically] OCC recheck: ${error.message}`);
    }
  } : null;

  return createCommitFromEntries({
    token,
    owner,
    repo,
    message: `CMS: Delete ${collection}/${filename}`,
    treeEntries,
    branch,
    preCommitCheck: occRecheck
  });
}

// ========================================
// GITHUB API HELPERS
// ========================================

async function githubRequest(method, path, body, token) {
  const cacheKey = method === 'GET' && !body ? path : null;
  if (cacheKey && requestGetCache && requestGetCache.has(cacheKey)) {
    return requestGetCache.get(cacheKey);
  }

  const url = `https://api.github.com${path}`;

  const options = {
    method: method,
    headers: {
      'Authorization': `token ${token}`,
      'User-Agent': 'Arconti31-CMS',
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json'
    }
  };

  // For DELETE and other methods that need a body
  if (body) {
    options.body = JSON.stringify(body);
  }

  // Retry su 429/502/503/403-rate-limit e network errors (max 3 tentativi, backoff 300ms * attempt)
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`GitHub ${method} ${path}${attempt > 1 ? ` (retry ${attempt}/3)` : ''}`);

    let response;
    let data;
    try {
      response = await fetch(url, options);
      data = await response.text();
    } catch (networkErr) {
      // Network error (DNS, timeout, connection reset) — retriable
      lastError = networkErr;
      if (attempt < 3) {
        const delay = 300 * attempt;
        console.warn(`[githubRequest] network error, backoff ${delay}ms: ${networkErr.message}`);
        await sleep(delay);
        continue;
      }
      throw networkErr;
    }

    if (response.ok) {
      const parsed = data ? JSON.parse(data) : {};
      if (cacheKey && requestGetCache) {
        requestGetCache.set(cacheKey, parsed);
      }
      // Qualsiasi write invalida la cache (ref/tree/contents cambiati)
      if (method !== 'GET' && requestGetCache) {
        requestGetCache.clear();
      }
      return parsed;
    }

    // 403 with rate-limit body is a secondary rate limit (retriable)
    const is403RateLimit = response.status === 403 && /rate limit|secondary|abuse/i.test(data);
    const retriable = response.status === 429 || response.status === 502 || response.status === 503 || is403RateLimit;
    if (retriable && attempt < 3) {
      let delay = 300 * attempt;
      const retryAfter = response.headers.get('retry-after') || response.headers.get('Retry-After');
      if (retryAfter) {
        const asNum = Number(retryAfter);
        if (Number.isFinite(asNum) && asNum >= 0) {
          // Retry-After può essere secondi
          delay = asNum < 1000 ? asNum * 1000 : asNum;
        }
      }
      console.warn(`[githubRequest] status ${response.status}, backoff ${delay}ms`);
      await sleep(delay);
      lastError = new Error(`GitHub API error: ${response.status} - ${data}`);
      continue;
    }

    throw new Error(`GitHub API error: ${response.status} - ${data}`);
  }

  throw lastError || new Error('GitHub API error: retry esauriti');
}

// ========================================
// RIGENERAZIONE JSON AUTOMATICA
// ========================================

// Mapping delle collection ai file JSON di destinazione
const COLLECTION_CONFIG = {
  'food': {
    jsonPath: 'food/food.json',
    type: 'food'
  },
  'beers': {
    jsonPath: 'beers/beers.json',
    type: 'beers'
  },
  'categorie': {
    jsonPath: 'categorie/categorie.json',
    type: 'categories'
  },
  // Beverage collections derived from BEVERAGE_CATEGORIES constant
  ...Object.fromEntries(BASE_BEVERAGE_CATEGORIES.map(c => [
    c.folder, { jsonPath: 'beverages/beverages.json', type: 'beverages', folder: c.folder, name: c.name }
  ]))
};

async function regenerateJSON(collection, token, owner, repo, branch = 'main') {
  const config = await resolveCollectionConfig(collection, token, owner, repo);
  if (!config) {
    console.log(`⚠️ Collection ${collection} non configurata per rigenerazione JSON`);
    return;
  }

  // Full rebuild da markdown (source of truth). Più call API ma corretto se JSON stale.
  // I path atomici (save/reorder/visibility) non passano da qui: aggiornano JSON nello stesso commit.
  const jsonContent = await generateJSONForConfig(config, token, owner, repo);
  if (jsonContent) {
    await commitJSON(config.jsonPath, jsonContent, token, owner, repo, branch);
    console.log(`✅ JSON rigenerato: ${config.jsonPath}`);
  }
}

// Legge tutti i file .md di una collection
async function readCollectionFiles(folder, token, owner, repo, overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, folder)) {
    return (overrides[folder] || []).map(item => ({ ...item }));
  }

  try {
    const url = `/repos/${owner}/${repo}/contents/${folder}`;
    const files = await githubRequest('GET', url, null, token);

    if (!Array.isArray(files)) return [];

    const mdFiles = files.filter(f => f.name.endsWith('.md') && f.name !== '.gitkeep');

    // M4: Bounded concurrency (max 8 parallel reads) to avoid GitHub secondary rate limits
    const CONCURRENCY = 8;
    const results = [];
    for (let i = 0; i < mdFiles.length; i += CONCURRENCY) {
      const batch = mdFiles.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(async (file) => {
        try {
          const fileData = await githubRequest('GET', `/repos/${owner}/${repo}/contents/${folder}/${file.name}`, null, token);
          const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
          const parsed = parseFrontmatter(content);
          if (parsed) {
            parsed._filename = file.name;
            return parsed;
          }
        } catch (e) {
          console.error(`Errore lettura ${file.name}:`, e.message);
        }
        return null;
      }));
      results.push(...batchResults);
    }

    return results.filter(Boolean);
  } catch (e) {
    console.error(`Errore lettura collection ${folder}:`, e.message);
    return [];
  }
}

// Parsifica il frontmatter YAML dal markdown
function parseMarkdownFrontmatter(content) {
  return parseFrontmatter(content);
}

// ========================================
// GENERATORI JSON SPECIFICI
// ========================================

async function generateFoodJSON(token, owner, repo, overrides = {}) {
  const useSnapshots = Object.keys(overrides).length > 0;
  // Carica anche le categorie per l'ordine
  const categories = useSnapshots
    ? (await readCollectionSnapshot('categorie', token, owner, repo, overrides))
      || await readCollectionFiles('categorie', token, owner, repo, overrides)
    : await readCollectionFiles('categorie', token, owner, repo, overrides);
  const foodCategories = categories.filter(c => c.tipo_menu === 'food' && c.visibile !== false);

  const foodItems = useSnapshots
    ? (await readCollectionSnapshot('food', token, owner, repo, overrides))
      || await readCollectionFiles('food', token, owner, repo, overrides)
    : await readCollectionFiles('food', token, owner, repo, overrides);

  foodItems.forEach(item => {
    const match = findCategoryByReference(foodCategories, item.category, 'food');
    if (match) {
      item.category = match.nome;
      item.category_slug = normalizeSlug(item.category_slug || match.slug || match.nome);
    } else if (item.category_slug) {
      item.category_slug = normalizeSlug(item.category_slug);
    }
  });

  // Ordina per order
  foodItems.sort((a, b) => (a.order || 0) - (b.order || 0));

  // Raggruppa per categoria
  const foodByCategory = {};

  // Inizializza categorie vuote
  foodCategories.forEach(cat => {
    foodByCategory[cat.nome] = [];
  });

  // Aggiungi i piatti
  foodItems.forEach(item => {
    const category = item.category || 'Altro';
    if (!foodByCategory[category]) {
      foodByCategory[category] = [];
    }
    foodByCategory[category].push(item);
  });

  // Ordina categorie
  const categoryOrder = {};
  foodCategories.forEach((cat, idx) => {
    categoryOrder[cat.nome] = cat.order || idx;
  });

  return {
    food: foodItems,
    foodByCategory,
    categoryOrder
  };
}

async function generateBeersJSON(token, owner, repo, overrides = {}) {
  const useSnapshots = Object.keys(overrides).length > 0;
  const beers = useSnapshots
    ? (await readCollectionSnapshot('beers', token, owner, repo, overrides))
      || await readCollectionFiles('beers', token, owner, repo, overrides)
    : await readCollectionFiles('beers', token, owner, repo, overrides);

  const beverageCategories = await (useSnapshots
    ? loadCategoriesSnapshot(token, owner, repo)
    : readCollectionFiles('categorie', token, owner, repo, overrides));

  beers.forEach(beer => {
    const match = findCategoryByReference(beverageCategories, beer.sezione, 'beverage');
    if (match) {
      beer.sezione = match.nome;
      beer.sezione_slug = normalizeSlug(beer.sezione_slug || match.slug || match.nome);
    } else if (beer.sezione_slug) {
      beer.sezione_slug = normalizeSlug(beer.sezione_slug);
    }
  });

  // Ordina per order
  beers.sort((a, b) => (a.order || 0) - (b.order || 0));

  // Raggruppa per sezione
  const beersBySection = {};
  beers.forEach(beer => {
    const section = beer.sezione || 'Birre alla spina';
    if (!beersBySection[section]) {
      beersBySection[section] = [];
    }
    beersBySection[section].push(beer);
  });

  return {
    beers,
    beersBySection
  };
}

async function generateCategoriesJSON(token, owner, repo, overrides = {}) {
  // Preferisci snapshot JSON (1 GET) — stesso shape; full MD solo se snapshot manca
  const categories = (await readCollectionSnapshot('categorie', token, owner, repo, overrides))
    || await readCollectionFiles('categorie', token, owner, repo, overrides);

  // Ordina (NON FILTRARE VISIBILI: il CMS deve vederle tutte!)
  const allCategories = categories
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  return {
    categories: allCategories,
    foodCategories: allCategories.filter(c => c.tipo_menu === 'food'),
    beverageCategories: allCategories.filter(c => c.tipo_menu === 'beverage')
  };
}

async function generateBeveragesJSON(token, owner, repo, overrides = {}) {
  const useSnapshots = Object.keys(overrides).length > 0;
  // Build the full list of beverage folders: hardcoded + dynamic from categories
  const knownFolders = new Set(BASE_BEVERAGE_CATEGORIES.map(c => c.folder));
  const allBeverageFolders = [...BASE_BEVERAGE_CATEGORIES];

  // Discover dynamic beverage folders from categorie collection
  try {
    const categories = useSnapshots
      ? (await readCollectionSnapshot('categorie', token, owner, repo, overrides))
        || await readCollectionFiles('categorie', token, owner, repo, overrides)
      : await readCollectionFiles('categorie', token, owner, repo, overrides);
    const beverageCats = categories.filter(c => c.tipo_menu === 'beverage');
    for (const cat of beverageCats) {
      const folder = getCategoryFolder(cat);
      if (folder && !knownFolders.has(folder)) {
        allBeverageFolders.push({ name: cat.nome, folder, slug: normalizeSlug(cat.slug || cat.nome) });
        knownFolders.add(folder);
        console.log(`📦 Dynamic beverage folder discovered: ${folder} → "${cat.nome}"`);
      }
    }
  } catch (e) {
    console.error('Error discovering dynamic beverage folders:', e.message);
  }

  const beveragesByType = {};
  const allBeverages = [];

  for (const category of allBeverageFolders) {
    let items;
    try {
      items = useSnapshots
        ? (await readCollectionSnapshot(category.folder, token, owner, repo, overrides))
          || await readCollectionFiles(category.folder, token, owner, repo, overrides)
        : await readCollectionFiles(category.folder, token, owner, repo, overrides);
    } catch (e) {
      // Folder may not exist yet (no products added) — skip gracefully
      console.log(`⏭️ Beverage folder "${category.folder}" not found or empty, skipping`);
      continue;
    }

    // Aggiungi il tipo a ogni item
    items.forEach(item => {
      item.tipo = category.name;
      item.tipo_slug = normalizeSlug(item.tipo_slug || category.slug || category.folder || category.name);
    });

    // Ordina
    items.sort((a, b) => (a.order || 0) - (b.order || 0));

    if (items.length > 0) {
      beveragesByType[category.name] = items;
      allBeverages.push(...items);
    }
  }

  return {
    beverages: allBeverages,
    beveragesByType
  };
}

// ========================================
// COMMIT JSON SU GITHUB
// ========================================

async function commitJSON(jsonPath, content, token, owner, repo, branch = 'main') {
  const jsonString = JSON.stringify(content, null, 2);
  const base64Content = Buffer.from(jsonString).toString('base64');

  // Prima prova a ottenere lo SHA del file esistente
  let existingSha = null;
  try {
    const existingFile = await githubRequest(
      'GET',
      `/repos/${owner}/${repo}/contents/${jsonPath}?ref=${encodeURIComponent(branch)}`,
      null,
      token
    );
    existingSha = existingFile.sha;
  } catch (e) {
    // File non esiste, verrà creato
    console.log(`📝 Creazione nuovo file: ${jsonPath}`);
  }

  const body = {
    message: `CMS Auto: Rigenera ${jsonPath}`,
    content: base64Content,
    branch
  };

  if (existingSha) {
    body.sha = existingSha;
  }

  await githubRequest('PUT', `/repos/${owner}/${repo}/contents/${jsonPath}`, body, token);
}
