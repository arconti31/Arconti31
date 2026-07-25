// Autenticazione CMS — port di netlify/functions/auth.js
// HMAC SHA-256, token `payloadBase64.signature`, scadenza 30 giorni, confronti timing-safe.
// DIFFERENZA VOLUTA rispetto a Netlify: nessun fallback silenzioso su ADMIN_PASSWORD
// come token secret — se CMS_TOKEN_SECRET/TOKEN_SECRET mancano il login fallisce
// con errore esplicito (fail loud).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Env } from '../types';

const TOKEN_EXPIRY_HOURS = 24 * 30; // 30 giorni

export class AuthConfigError extends Error {
	code = 'AUTH_CONFIG_MISSING' as const;
}

/**
 * Secret per firmare i token. Fail loud se assente: mai usare ADMIN_PASSWORD.
 */
export function getTokenSecret(env: Env): string {
	const secret = (env.CMS_TOKEN_SECRET || env.TOKEN_SECRET || '').trim();
	if (!secret) {
		throw new AuthConfigError(
			'CMS_TOKEN_SECRET non configurato. Imposta il secret con: npx wrangler secret put CMS_TOKEN_SECRET'
		);
	}
	return secret;
}

export function getAdminEmails(env: Env): string[] {
	return (env.ADMIN_EMAIL || '')
		.split(',')
		.map(e => e.toLowerCase().trim())
		.filter(Boolean);
}

export function generateToken(env: Env, email: string): string {
	const secret = getTokenSecret(env);
	const payload = {
		email,
		exp: Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000
	};
	const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
	const signature = createHmac('sha256', secret).update(payloadBase64).digest('hex');
	return `${payloadBase64}.${signature}`;
}

/**
 * Verifica token: ritorna l'email o null.
 * Se il secret manca, ritorna null (nessuna sessione verificabile) e logga l'errore.
 */
export function verifyToken(env: Env, token: string | undefined | null): string | null {
	if (!token || typeof token !== 'string') return null;

	const parts = token.split('.');
	if (parts.length !== 2) return null;

	const [payloadBase64, signature] = parts;

	let secret: string;
	try {
		secret = getTokenSecret(env);
	} catch (e) {
		console.error('[auth] verifyToken:', (e as Error).message);
		return null;
	}

	const expectedSignature = createHmac('sha256', secret).update(payloadBase64).digest('hex');

	// Confronta firme in modo timing-safe
	try {
		const sigBuf = Buffer.from(signature, 'utf8');
		const expBuf = Buffer.from(expectedSignature, 'utf8');
		if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
			console.log('Token signature mismatch');
			return null;
		}
	} catch {
		console.log('Token signature mismatch');
		return null;
	}

	try {
		const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf-8'));
		if (payload.exp && payload.exp < Date.now()) {
			console.log('Token expired');
			return null;
		}
		return payload.email || null;
	} catch (e) {
		console.log('Token parse error:', (e as Error).message);
		return null;
	}
}

/**
 * Confronta stringhe in modo timing-safe.
 * Se lunghezze diverse → false senza timingSafeEqual (richiede equal length).
 */
export function safeEqualString(a: unknown, b: unknown): boolean {
	if (typeof a !== 'string' || typeof b !== 'string') return false;
	const bufA = Buffer.from(a, 'utf8');
	const bufB = Buffer.from(b, 'utf8');
	if (bufA.length !== bufB.length) return false;
	try {
		return timingSafeEqual(bufA, bufB);
	} catch {
		return false;
	}
}

export function verifyLogin(env: Env, email: unknown, password: unknown): string | null {
	if (!email || !password || typeof email !== 'string' || typeof password !== 'string') return null;
	const emailLower = email.toLowerCase().trim();
	if (!getAdminEmails(env).includes(emailLower)) return null;
	if (!safeEqualString(password, env.ADMIN_PASSWORD || '')) return null;
	return emailLower;
}
