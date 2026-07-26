// CORS: allowlist domini noti + origin del deployment corrente + ALLOWED_ORIGINS (env)
// Nessun `*` sugli endpoint autenticati; Vary: Origin sempre presente.

import type { Env } from '../types';

const BASE_ALLOWED_ORIGINS = [
	'https://arconti31.com',
	'https://www.arconti31.com',
	'http://localhost:8000',
	'http://localhost:3000',
	'http://localhost:8787',
	'http://127.0.0.1:8787'
];

export function getAllowedOrigins(request: Request, env: Env): string[] {
	const origins = new Set(BASE_ALLOWED_ORIGINS);
	// Same-origin del deployment corrente (workers.dev o dominio custom) sempre valido
	try {
		origins.add(new URL(request.url).origin);
	} catch {
		/* ignore */
	}
	// Extra origins configurabili: "https://a.com,https://b.com"
	(env.ALLOWED_ORIGINS || '')
		.split(',')
		.map(s => s.trim())
		.filter(Boolean)
		.forEach(o => origins.add(o.replace(/\/$/, '')));
	return [...origins];
}

export function getCorsOrigin(request: Request, env: Env): string | null {
	const origin = request.headers.get('Origin') || '';
	if (!origin) return null;
	if (getAllowedOrigins(request, env).includes(origin)) return origin;
	console.warn(`[CORS] Origin non consentito: ${origin}`);
	// Nessun fallback: ometti ACAO
	return null;
}

export function corsHeaders(request: Request, env: Env, methods = 'POST, OPTIONS'): Record<string, string> {
	const headers: Record<string, string> = {
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		'Access-Control-Allow-Methods': methods,
		'Vary': 'Origin'
	};
	const corsOrigin = getCorsOrigin(request, env);
	if (corsOrigin) {
		headers['Access-Control-Allow-Origin'] = corsOrigin;
	}
	return headers;
}
