// Health check — verifica presenza config senza leak di secret
// GET o POST — dettagli completi solo con token valido (M2)

const { resolveRepoConfig } = require('./repo-config');
const { verifyToken } = require('./auth');

function buildChecks() {
  const repoOwner = !!(process.env.REPO_OWNER || '').trim();
  const repoName = !!(process.env.REPO_NAME || '').trim();
  const githubToken = !!(process.env.GITHUB_TOKEN || '').trim();
  const adminEmail = !!(process.env.ADMIN_EMAIL || '').trim();
  const adminPassword = !!(process.env.ADMIN_PASSWORD || '').trim();
  const branch = (process.env.GITHUB_BRANCH || 'main').trim() || 'main';

  return {
    repoOwner,
    repoName,
    githubToken,
    adminEmail,
    adminPassword,
    branch
  };
}

async function checkGithubRepoAccess(owner, repo, token) {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      method: 'GET',
      headers: {
        Authorization: `token ${token}`,
        'User-Agent': 'Arconti31-CMS-Health',
        Accept: 'application/vnd.github.v3+json'
      }
    });
    if (res.ok) {
      return { ok: true, status: res.status };
    }
    return { ok: false, status: res.status };
  } catch (e) {
    return { ok: false, error: 'network_error', message: e.message };
  }
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // M2: Unauthenticated requests get only basic liveness (no config exposure, no GitHub ping)
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  const isAuthenticated = !!verifyToken(token);

  if (!isAuthenticated) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true })
    };
  }

  // Authenticated: full diagnostics
  const checks = buildChecks();
  let ok = checks.repoOwner && checks.repoName && checks.githubToken && checks.adminEmail && checks.adminPassword;

  const body = {
    ok,
    checks
  };

  // Opzionale: ping repo se config completa (non fallisce hard su network error)
  if (checks.repoOwner && checks.repoName && checks.githubToken) {
    try {
      const { owner, repo } = resolveRepoConfig();
      const repoCheck = await checkGithubRepoAccess(owner, repo, process.env.GITHUB_TOKEN);
      body.checks.githubRepo = repoCheck.ok === true;
      body.checks.githubRepoDetail = repoCheck.ok
        ? { ok: true, status: repoCheck.status }
        : { ok: false, status: repoCheck.status || null, error: repoCheck.error || null };
      if (!repoCheck.ok) {
        // repo non raggiungibile → ok globale false ma non 500 hard
        body.ok = false;
      }
    } catch (e) {
      body.checks.githubRepo = false;
      body.checks.githubRepoDetail = {
        ok: false,
        error: e.code || 'config_error',
        message: e.message
      };
      body.ok = false;
    }
  } else {
    body.checks.githubRepo = false;
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(body)
  };
};
