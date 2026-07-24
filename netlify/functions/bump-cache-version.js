// Netlify Function: bump-cache-version
// Aggiorna admin/version.json con una nuova cacheVersion.
// Effetto: il kill-switch lato client (admin/index.html) rileva il cambio e svuota
// SOLO la cache del Service Worker (shell HTML/JS/CSS dell'admin) su tutti i dispositivi,
// poi ricarica. NON tocca la SmartCache dei prodotti (IndexedDB) ne' la sessione (cms_session).
// Isolata dal flusso save-data.js: nessun impatto sul menu pubblico o sui contenuti.

const { verifyToken } = require('./auth');
const { resolveRepoConfig } = require('./repo-config');

const VERSION_PATH = 'admin/version.json';

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
      try { origins.add(new URL(u).origin); } catch (_) { /* ignore */ }
    });
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(o => origins.add(o.replace(/\/$/, '')));
  return origins;
}

function getHeaders(event) {
  const headers = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  const origin = event.headers.origin || event.headers.Origin || '';
  if (origin && getAllowedOrigins().has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function githubRequest(method, path, body, token) {
  const url = `https://api.github.com${path}`;
  const options = {
    method,
    headers: {
      'Authorization': `token ${token}`,
      'User-Agent': 'Arconti31-CMS',
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json'
    }
  };
  if (body) options.body = JSON.stringify(body);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    let data;
    try {
      response = await fetch(url, options);
      data = await response.text();
    } catch (networkErr) {
      lastError = networkErr;
      if (attempt < 3) { await sleep(300 * attempt); continue; }
      throw networkErr;
    }

    if (response.ok) return data ? JSON.parse(data) : {};

    // 404 su GET del file: non e' un errore retriabile, lo gestisce il chiamante
    if (method === 'GET' && response.status === 404) {
      const notFound = new Error('NOT_FOUND');
      notFound.status = 404;
      throw notFound;
    }

    const is403RateLimit = response.status === 403 && /rate limit|secondary|abuse/i.test(data);
    const retriable = response.status === 429 || response.status === 502 || response.status === 503 || is403RateLimit;
    if (retriable && attempt < 3) {
      let delay = 300 * attempt;
      const retryAfter = response.headers.get('retry-after') || response.headers.get('Retry-After');
      if (retryAfter) {
        const asNum = Number(retryAfter);
        if (Number.isFinite(asNum) && asNum >= 0) delay = asNum < 1000 ? asNum * 1000 : asNum;
      }
      await sleep(delay);
      lastError = new Error(`GitHub API error: ${response.status} - ${data}`);
      continue;
    }

    throw new Error(`GitHub API error: ${response.status} - ${data}`);
  }
  throw lastError || new Error('GitHub API error: retry esauriti');
}

// Genera una cacheVersion leggibile e sempre crescente: YYYY-MM-DD-HHmmss (UTC)
function buildCacheVersion() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

exports.handler = async (event) => {
  const headers = getHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON non valido' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization;
  const token = authHeader ? authHeader.replace('Bearer ', '') : body.token;
  const email = verifyToken(token);
  if (!email) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Non autorizzato' }) };
  }

  const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
  if (!GITHUB_TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'GITHUB_TOKEN non configurato' }) };
  }

  let cfg;
  try {
    cfg = resolveRepoConfig();
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message, code: error.code || 'REPO_CONFIG_MISSING' })
    };
  }
  const { owner, repo, branch } = cfg;

  try {
    // SHA corrente del file (per un update fast-forward). Se assente -> creazione.
    let currentSha = null;
    try {
      const existing = await githubRequest(
        'GET',
        `/repos/${owner}/${repo}/contents/${VERSION_PATH}?ref=${encodeURIComponent(branch)}`,
        null,
        GITHUB_TOKEN
      );
      currentSha = existing && existing.sha ? existing.sha : null;
    } catch (err) {
      if (err.status !== 404) throw err; // 404 = file non ancora esistente: lo creiamo
    }

    const cacheVersion = buildCacheVersion();
    const content = JSON.stringify({ cacheVersion }, null, 2) + '\n';
    const encoded = Buffer.from(content, 'utf-8').toString('base64');

    const putBody = {
      message: `CMS: bump cacheVersion -> ${cacheVersion}`,
      content: encoded,
      branch
    };
    if (currentSha) putBody.sha = currentSha;

    await githubRequest(
      'PUT',
      `/repos/${owner}/${repo}/contents/${VERSION_PATH}`,
      putBody,
      GITHUB_TOKEN
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, cacheVersion })
    };
  } catch (error) {
    console.error('[bump-cache-version] errore:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Impossibile aggiornare la versione cache. Riprova.' })
    };
  }
};
