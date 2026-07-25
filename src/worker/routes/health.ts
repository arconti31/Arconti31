// /api/health — port di netlify/functions/health.js
// Senza token: solo liveness {ok:true}. Con token valido: diagnostica completa
// (presenza config, ping repo GitHub) senza leak di secret.

import type { Env } from '../types';
import { verifyToken } from '../lib/auth';
import { resolveRepoConfig } from '../lib/repo-config';
import { json, text } from '../lib/http';

function buildChecks(env: Env) {
	return {
		repoOwner: !!(env.REPO_OWNER || '').trim(),
		repoName: !!(env.REPO_NAME || '').trim(),
		githubToken: !!(env.GITHUB_TOKEN || '').trim(),
		adminEmail: !!(env.ADMIN_EMAIL || '').trim(),
		adminPassword: !!(env.ADMIN_PASSWORD || '').trim(),
		branch: (env.GITHUB_BRANCH || 'main').trim() || 'main'
	};
}

async function checkGithubRepoAccess(owner: string, repo: string, token: string) {
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
		return { ok: false, error: 'network_error', message: (e as Error).message };
	}
}

export async function handleHealth(request: Request, env: Env): Promise<Response> {
	const headers: Record<string, string> = {
		'Cache-Control': 'no-store'
	};

	if (request.method === 'OPTIONS') {
		return text(200, '', {
			...headers,
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization'
		});
	}

	if (request.method !== 'GET' && request.method !== 'POST') {
		return json(405, { error: 'Method Not Allowed' }, headers);
	}

	// M2: senza auth solo liveness base (nessuna esposizione config, nessun ping GitHub)
	const authHeader = request.headers.get('Authorization') || '';
	const token = authHeader.replace('Bearer ', '').trim();
	const isAuthenticated = !!verifyToken(env, token);

	if (!isAuthenticated) {
		return json(200, { ok: true }, headers);
	}

	// Autenticato: diagnostica completa
	const checks: Record<string, any> = buildChecks(env);
	const body: Record<string, any> = {
		ok: checks.repoOwner && checks.repoName && checks.githubToken && checks.adminEmail && checks.adminPassword,
		checks
	};

	// Opzionale: ping repo se config completa (non fallisce hard su network error)
	if (checks.repoOwner && checks.repoName && checks.githubToken) {
		try {
			const { owner, repo } = resolveRepoConfig(env);
			const repoCheck = await checkGithubRepoAccess(owner, repo, env.GITHUB_TOKEN || '');
			checks.githubRepo = repoCheck.ok === true;
			checks.githubRepoDetail = repoCheck.ok
				? { ok: true, status: repoCheck.status }
				: { ok: false, status: repoCheck.status || null, error: repoCheck.error || null };
			if (!repoCheck.ok) {
				body.ok = false;
			}
		} catch (e) {
			checks.githubRepo = false;
			checks.githubRepoDetail = {
				ok: false,
				error: (e as any).code || 'config_error',
				message: (e as Error).message
			};
			body.ok = false;
		}
	} else {
		checks.githubRepo = false;
	}

	return json(200, body, headers);
}
