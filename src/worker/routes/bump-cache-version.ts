// /api/bump-cache-version — port di netlify/functions/bump-cache-version.js
// Aggiorna admin/version.json con una nuova cacheVersion: il kill-switch client
// (admin/index.html) rileva il cambio e svuota SOLO la cache del Service Worker
// su tutti i dispositivi. Non tocca SmartCache prodotti né la sessione.

import { Buffer } from 'node:buffer';
import type { Env } from '../types';
import { RepoConfigError } from '../types';
import { verifyToken } from '../lib/auth';
import { resolveRepoConfig } from '../lib/repo-config';
import { GithubClient } from '../lib/github';
import { corsHeaders } from '../lib/cors';
import { getBearerToken, json, parseJsonBody, text } from '../lib/http';
import { getErrorStatusCode, getSafeErrorMessage, readRepoFileOptional } from '../lib/collections';

const VERSION_PATH = 'admin/version.json';

// Genera una cacheVersion leggibile e sempre crescente: YYYY-MM-DD-HHmmss (UTC)
function buildCacheVersion(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export async function handleBumpCacheVersion(request: Request, env: Env): Promise<Response> {
	const headers = corsHeaders(request, env);

	if (request.method === 'OPTIONS') {
		return text(200, '', headers);
	}
	if (request.method !== 'POST') {
		return json(405, { error: 'Method Not Allowed' }, headers);
	}

	const body = (await parseJsonBody(request)) || {};

	const token = getBearerToken(request, body.token);
	const email = verifyToken(env, token);
	if (!email) {
		return json(401, { error: 'Non autorizzato' }, headers);
	}

	const GITHUB_TOKEN = (env.GITHUB_TOKEN || '').trim();
	if (!GITHUB_TOKEN) {
		return json(500, { error: 'GITHUB_TOKEN non configurato' }, headers);
	}

	let cfg;
	try {
		cfg = resolveRepoConfig(env);
	} catch (error) {
		if (error instanceof RepoConfigError) {
			return json(500, { error: error.message, code: error.code }, headers);
		}
		throw error;
	}
	const { owner, repo, branch } = cfg;

	const gh = new GithubClient(GITHUB_TOKEN, cfg);

	try {
		// SHA corrente del file (per un update fast-forward). Se assente -> creazione.
		// Fail-closed: solo il 404 significa "non esiste", il resto risale.
		const existing = await readRepoFileOptional(gh, VERSION_PATH);
		const currentSha: string | null = existing?.sha || null;

		const cacheVersion = buildCacheVersion();
		const content = JSON.stringify({ cacheVersion }, null, 2) + '\n';
		const encoded = Buffer.from(content, 'utf-8').toString('base64');

		const putBody: Record<string, unknown> = {
			message: `CMS: bump cacheVersion -> ${cacheVersion}`,
			content: encoded,
			branch
		};
		if (currentSha) putBody.sha = currentSha;

		await gh.request('PUT', `/repos/${owner}/${repo}/contents/${VERSION_PATH}`, putBody);

		return json(200, { success: true, cacheVersion }, headers);
	} catch (error) {
		console.error('[bump-cache-version] errore:', error);
		return json(getErrorStatusCode(error), { error: getSafeErrorMessage(error) }, headers);
	}
}
