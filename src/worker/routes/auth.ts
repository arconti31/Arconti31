// Endpoint /api/auth/login e /api/auth/verify
// La logica è condivisa con le action `login`/`verify-token` di save-data
// (stessa semantica del CMS legacy) — nessuna duplicazione.

import type { Env } from '../types';
import { AuthConfigError, generateToken, verifyLogin, verifyToken } from '../lib/auth';
import { checkLoginRateLimit, resetLoginRateLimit } from '../lib/rate-limit';
import { corsHeaders } from '../lib/cors';
import { getBearerToken, getClientIp, json, parseJsonBody, text } from '../lib/http';

/**
 * Esegue il login dato un body già parsato (riusata da save-data action=login).
 * Rate limit IP+email, credenziali timing-safe, token HMAC 30 giorni.
 */
export function loginFromBody(
	request: Request,
	env: Env,
	body: Record<string, any>,
	headers: Record<string, string>
): Response {
	const { email, password } = body;
	if (!email || !password) {
		return json(400, { error: 'Email e password richiesti' }, headers);
	}

	const clientIp = getClientIp(request);
	if (!checkLoginRateLimit(clientIp, email)) {
		console.warn(`[login] Rate limit superato per ${clientIp} / ${email}`);
		return json(429, { error: 'Troppi tentativi di login. Riprova tra 15 minuti.' }, headers);
	}

	const validEmail = verifyLogin(env, email, password);
	if (!validEmail) {
		return json(401, { error: 'Credenziali non valide' }, headers);
	}

	// Fail loud: se CMS_TOKEN_SECRET manca, errore esplicito (mai fallback su ADMIN_PASSWORD)
	let newToken: string;
	try {
		newToken = generateToken(env, validEmail);
	} catch (error) {
		if (error instanceof AuthConfigError) {
			console.error('[login]', error.message);
			return json(500, { error: error.message, code: error.code }, headers);
		}
		throw error;
	}

	resetLoginRateLimit(clientIp, email);
	return json(200, {
		token: newToken,
		email: validEmail,
		user: { email: validEmail, role: 'admin' }
	}, headers);
}

/** Verifica sessione dato un body già parsato (riusata da save-data action=verify-token). */
export function verifyFromBody(
	request: Request,
	env: Env,
	body: Record<string, any>,
	headers: Record<string, string>
): Response {
	const incomingToken = getBearerToken(request, body.token);
	const userEmail = verifyToken(env, incomingToken);
	if (!userEmail) {
		return json(401, { error: 'Sessione scaduta o non valida' }, headers);
	}
	return json(200, { valid: true, email: userEmail }, headers);
}

export async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
	const headers = corsHeaders(request, env);

	if (request.method === 'OPTIONS') {
		return text(200, '', headers);
	}
	if (request.method !== 'POST') {
		return text(405, 'Method Not Allowed', headers);
	}

	const body = await parseJsonBody(request);
	if (!body) {
		return json(400, { error: 'JSON non valido' }, headers);
	}

	return loginFromBody(request, env, body, headers);
}

export async function handleAuthVerify(request: Request, env: Env): Promise<Response> {
	const headers = corsHeaders(request, env);

	if (request.method === 'OPTIONS') {
		return text(200, '', headers);
	}
	if (request.method !== 'POST') {
		return text(405, 'Method Not Allowed', headers);
	}

	const body = (await parseJsonBody(request)) || {};
	return verifyFromBody(request, env, body, headers);
}
