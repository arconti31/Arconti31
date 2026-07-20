// Netlify Function per leggere i dati
// OTTIMIZZATO: Usa JSON statici quando possibile, API GitHub solo con auth utente (mode=api)

const { verifyToken } = require('./auth');
const { resolveRepoConfig } = require('./repo-config');
const {
  findBeverageCategoryByFolder,
  getCategoryFolder,
  normalizeSlug,
  parseFrontmatter,
  stringifyFrontmatter
} = require('../../lib/menu-utils');

// CORS semplificato (stesso pattern di save-data, senza fallback ad allowed[0])
const BASE_ALLOWED_ORIGINS = [
  'https://arconti31.com',
  'https://www.arconti31.com',
  'https://arconti31.netlify.app',
  'http://localhost:8000',
  'http://localhost:3000'
];

function getAllowedOrigins() {
  const origins = new Set(BASE_ALLOWED_ORIGINS);
  [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL]
    .filter(Boolean)
    .forEach(u => {
      try {
        origins.add(new URL(u).origin);
      } catch (_) { /* ignore */ }
    });
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(o => origins.add(o.replace(/\/$/, '')));
  return [...origins];
}

function getCorsOrigin(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const allowed = getAllowedOrigins();
  if (origin && allowed.includes(origin)) return origin;
  if (origin) console.warn(`[read-data CORS] Origin non consentito: ${origin}`);
  return null;
}

function getHeaders(event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  const cors = getCorsOrigin(event);
  if (cors) headers['Access-Control-Allow-Origin'] = cors;
  return headers;
}

function isValidPathSegment(value) {
  if (!value || typeof value !== 'string') return false;
  return !(value.includes('..') || value.includes('/') || value.includes('\\'));
}

exports.handler = async (event, context) => {
  const headers = getHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  let parsedBody;
  try {
    parsedBody = JSON.parse(event.body);
  } catch (e) {
    console.error('Invalid JSON body:', event.body);
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON non valido' }) };
  }

  const { folder, mode, token, filename, filenames, lookupName } = parsedBody;

  if (!folder) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Folder required' }) };
  }

  // Validazione path traversal (come save-data)
  if (!isValidPathSegment(folder)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Folder non valido', items: [] }) };
  }
  if (filename && !isValidPathSegment(filename)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Filename non valido', items: [] }) };
  }
  if (Array.isArray(filenames)) {
    for (const f of filenames) {
      if (f && !isValidPathSegment(f)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Filename non valido', items: [] }) };
      }
    }
  }

  // Config repo fail-loud — niente default Massimilianociconte/Arconti31
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
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: error.message,
          code: 'REPO_CONFIG_MISSING',
          items: []
        })
      };
    }
    throw error;
  }

  // mode=api espone SHA → richiede autenticazione utente
  if (mode === 'api') {
    const userEmail = verifyToken(token);
    if (!userEmail) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Autenticazione richiesta per la modalità API', items: [] })
      };
    }
  }

  console.log(`[read-data] Folder: ${folder}, Mode: ${mode || 'auto'}, branch: ${REPO_BRANCH}`);

  // mode !== 'api': solo JSON statici (raw.githubusercontent) — MAI PAT server senza auth utente
  if (mode !== 'api') {
    const jsonResult = await tryReadFromJSON(folder, REPO_OWNER, REPO_NAME, REPO_BRANCH);
    if (jsonResult) {
      console.log(`[read-data] ✅ Dati caricati da JSON statico per ${folder} (${jsonResult.length} items)`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ items: jsonResult, source: 'json' })
      };
    }

    // 503 (non 200+[]) così i client non trattano "lista vuota legittima" e non wipe-ano la cache
    console.log(`[read-data] JSON non disponibile per ${folder} — non uso GITHUB_TOKEN senza auth`);
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({
        items: [],
        source: 'json-miss',
        error: 'Dati non disponibili da JSON statico'
      })
    };
  }

  // mode === 'api': usa API GitHub con PAT server (utente già autenticato)
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  console.log(`[read-data] Usando API GitHub per ${folder}`);

  if (!GITHUB_TOKEN) {
    console.error('[read-data] GITHUB_TOKEN non configurato!');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'GITHUB_TOKEN non configurato', items: [] })
    };
  }

  try {
    if (Array.isArray(filenames) && filenames.length > 0) {
      const items = await readItemsMetadataFromAPI({
        folder,
        filenames,
        token: GITHUB_TOKEN,
        owner: REPO_OWNER,
        repo: REPO_NAME
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ items, source: 'api-listing' })
      };
    }

    if (filename) {
      const item = await readSingleItemFromAPI({
        folder,
        filename,
        lookupName,
        token: GITHUB_TOKEN,
        owner: REPO_OWNER,
        repo: REPO_NAME,
        branch: REPO_BRANCH
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ items: item ? [item] : [], source: 'api-single' })
      };
    }

    const files = await githubRequest(
      'GET',
      `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${folder}`,
      null,
      GITHUB_TOKEN
    );

    if (!Array.isArray(files)) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ items: [], source: 'api' })
      };
    }

    const mdFiles = files.filter(f => f.name.endsWith('.md') && f.name !== '.gitkeep');

    // Bounded concurrency (max 8) to avoid GitHub secondary rate limits (M4)
    const CONCURRENCY = 8;
    const items = [];
    for (let i = 0; i < mdFiles.length; i += CONCURRENCY) {
      const batch = mdFiles.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(async file => {
        try {
          const fileData = await githubRequest(
            'GET',
            `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${folder}/${file.name}`,
            null,
            GITHUB_TOKEN
          );
          const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
          const parsedItem = parseFrontmatter(content);
          return { content, filename: file.name, sha: fileData.sha, parsedItem };
        } catch (e) {
          console.error(`Error loading ${file.name}:`, e);
          return null;
        }
      }));
      items.push(...batchResults);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ items: items.filter(i => i !== null), source: 'api' })
    };
  } catch (error) {
    console.error('[read-data] Error:', error.message);

    if (error.message.includes('403') || error.message.includes('rate limit')) {
      // Fallback JSON (pubblico, no PAT) anche in mode=api se rate limit
      const jsonFallback = await tryReadFromJSON(folder, REPO_OWNER, REPO_NAME, REPO_BRANCH);
      if (jsonFallback) {
        console.log(`[read-data] ✅ Fallback a JSON per rate limit`);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ items: jsonFallback, source: 'json-fallback' })
        };
      }

      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({
          error: 'Rate limit GitHub raggiunto. Attendi qualche minuto.',
          items: []
        })
      };
    }

    // 404 = folder doesn't exist yet
    if (error.message.includes('404')) {
      console.log(`[read-data] Folder "${folder}" not found — returning empty items (new category?)`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ items: [], source: 'empty-folder' })
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message, items: [] })
    };
  }
};

async function readItemsMetadataFromAPI({ folder, filenames, token, owner, repo }) {
  const wanted = new Set((filenames || []).filter(Boolean));
  if (wanted.size === 0) return [];

  const files = await githubRequest(
    'GET',
    `/repos/${owner}/${repo}/contents/${folder}`,
    null,
    token
  );

  if (!Array.isArray(files)) return [];

  return files
    .filter(file => file.name.endsWith('.md') && file.name !== '.gitkeep' && wanted.has(file.name))
    .map(file => ({ filename: file.name, sha: file.sha }));
}

async function readMarkdownItemFromAPI({ folder, filename, token, owner, repo }) {
  const fileData = await githubRequest(
    'GET',
    `/repos/${owner}/${repo}/contents/${folder}/${filename}`,
    null,
    token
  );
  const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
  const parsedItem = parseFrontmatter(content);
  return { content, filename, sha: fileData.sha, parsedItem };
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

async function readSingleItemFromAPI({ folder, filename, lookupName, token, owner, repo, branch = 'main' }) {
  try {
    return await readMarkdownItemFromAPI({ folder, filename, token, owner, repo });
  } catch (error) {
    if (!error.message.includes('404')) {
      throw error;
    }
  }

  if (!lookupName) {
    return null;
  }

  // Lookup per nome via JSON pubblico (no PAT extra)
  const jsonItems = await tryReadFromJSON(folder, owner, repo, branch);
  if (!jsonItems || jsonItems.length === 0) {
    return null;
  }

  const targetName = normalizeName(lookupName);
  const candidate = jsonItems.find(item => normalizeName(item.parsedItem?.nome) === targetName);
  if (!candidate?.filename || candidate.filename === filename) {
    return null;
  }

  try {
    return await readMarkdownItemFromAPI({ folder, filename: candidate.filename, token, owner, repo });
  } catch (error) {
    if (error.message.includes('404')) return null;
    throw error;
  }
}

// ========================================
// LETTURA DA JSON STATICI
// ========================================

async function tryReadFromJSON(folder, owner, repo, branch = 'main') {
  // Mapping folder -> JSON file e campo dati
  const JSON_MAP = {
    'food': { file: 'food/food.json', field: 'food' },
    'beers': { file: 'beers/beers.json', field: 'beers' },
    'categorie': { file: 'categorie/categorie.json', field: 'categories' },
    'cocktails': { file: 'beverages/beverages.json', field: 'beverages', filter: 'Cocktails' },
    'analcolici': { file: 'beverages/beverages.json', field: 'beverages', filter: 'Analcolici' },
    'bibite': { file: 'beverages/beverages.json', field: 'beverages', filter: 'Bibite' },
    'caffetteria': { file: 'beverages/beverages.json', field: 'beverages', filter: 'Caffetteria' },
    'bollicine': { file: 'beverages/beverages.json', field: 'beverages', filter: 'Bollicine' },
    'bianchi-fermi': { file: 'beverages/beverages.json', field: 'beverages', filter: 'Bianchi fermi' },
    'vini-rossi': { file: 'beverages/beverages.json', field: 'beverages', filter: 'Vini rossi' }
  };

  let config = JSON_MAP[folder];
  const safeBranch = encodeURIComponent(branch || 'main');

  // If folder is not in static map, check categorie.json for dynamic beverage folders
  if (!config) {
    try {
      const catUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${safeBranch}/categorie/categorie.json`;
      const catRes = await fetch(catUrl);
      if (catRes.ok) {
        const catData = await catRes.json();
        const match = findBeverageCategoryByFolder(catData.categories || [], folder);
        if (match) {
          config = { file: 'beverages/beverages.json', field: 'beverages', filter: match.nome };
          console.log(`[tryReadFromJSON] Dynamic beverage mapping: ${normalizeSlug(folder)} → filter "${match.nome}" (folder ${getCategoryFolder(match)})`);
        }
      }
    } catch (e) {
      console.log(`[tryReadFromJSON] Error checking dynamic beverage: ${e.message}`);
    }
  }

  if (!config) {
    console.log(`[tryReadFromJSON] Nessun mapping per ${folder}`);
    return null;
  }

  try {
    // Legge il JSON dal repository raw di GitHub (non conta verso rate limit API!)
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${safeBranch}/${config.file}`;
    console.log(`[tryReadFromJSON] Fetching ${rawUrl}`);

    const response = await fetch(rawUrl);
    if (!response.ok) {
      console.log(`[tryReadFromJSON] File non trovato: ${response.status}`);
      return null;
    }

    const jsonData = await response.json();
    let items = jsonData[config.field] || [];

    // Filtra per tipo se necessario (per beverages)
    if (config.filter) {
      items = items.filter(item => item.tipo === config.filter);
    }

    // IMPORTANTE: Restituisce i dati in un formato che il CMS può usare direttamente
    return items.map(item => {
      const itemFilename = item._filename || ((item.slug || slugify(item.nome)) + '.md');
      const content = generateMarkdownFromItem(item);

      return {
        content,
        filename: itemFilename,
        sha: null,
        fromJSON: true,
        parsedItem: item
      };
    });
  } catch (e) {
    console.error(`[tryReadFromJSON] Errore:`, e.message);
    return null;
  }
}

function generateMarkdownFromItem(item) {
  return stringifyFrontmatter(item);
}

function slugify(text) {
  if (!text) return 'item-' + Date.now();
  return text.toString().toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôõö]/g, 'o').replace(/[ùúûü]/g, 'u')
    .replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').substring(0, 50);
}

// ========================================
// GITHUB API
// ========================================

async function githubRequest(method, path, body, token) {
  const url = `https://api.github.com${path}`;

  const options = {
    method: method,
    headers: {
      'User-Agent': 'Arconti31-CMS',
      'Accept': 'application/vnd.github.v3+json'
    }
  };

  if (token) {
    options.headers['Authorization'] = `token ${token}`;
  }

  const response = await fetch(url, options);
  const data = await response.text();

  if (response.ok) {
    return data ? JSON.parse(data) : {};
  } else {
    throw new Error(`GitHub API error: ${response.status} - ${data.substring(0, 200)}`);
  }
}
