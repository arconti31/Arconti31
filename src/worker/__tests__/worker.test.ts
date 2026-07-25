// Test del Worker Arconti31 — copre i casi richiesti dalla migrazione:
// routing, health, method not allowed, CORS, login, token, path traversal,
// payload non validi, save con SHA/conflitto, read pubblica/API,
// firma Cloudinary, fallback /admin, alias legacy Netlify.
// GitHub e Cloudinary sono SEMPRE mockati: nessuna modifica reale.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';
import worker from '../index';
import type { Env } from '../types';

const ORIGIN = 'https://arconti31-test.example';
const SECRET = 'test-secret';
const ADMIN_EMAIL = 'admin@test.com';
const ADMIN_PASSWORD = 'password-123';

function makeEnv(overrides: Partial<Env> = {}): Env {
	return {
		ASSETS: {
			fetch: async () => new Response('static-asset', { status: 200 })
		} as unknown as Env['ASSETS'],
		REPO_OWNER: 'owner',
		REPO_NAME: 'repo',
		GITHUB_BRANCH: 'main',
		GITHUB_TOKEN: 'gh-test-token',
		ADMIN_EMAIL,
		ADMIN_PASSWORD,
		CMS_TOKEN_SECRET: SECRET,
		CLOUDINARY_CLOUD_NAME: 'democloud',
		CLOUDINARY_API_KEY: 'key123',
		CLOUDINARY_API_SECRET: 'cloudinary-secret-456',
		...overrides
	};
}

function makeToken(payload: Record<string, unknown>, secret = SECRET): string {
	const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
	const signature = createHmac('sha256', secret).update(payloadBase64).digest('hex');
	return `${payloadBase64}.${signature}`;
}

function validToken(): string {
	return makeToken({ email: ADMIN_EMAIL, exp: Date.now() + 60_000 });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
	return new Request(`${ORIGIN}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
}

function githubJson(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}

function b64(content: string): string {
	return Buffer.from(content, 'utf-8').toString('base64');
}

/** Stub fetch fail-fast: ogni chiamata esterna non mockata fa fallire il test. */
function failFastFetch(url: RequestInfo | URL): Promise<Response> {
	throw new Error(`fetch non mockata verso: ${String(url)}`);
}

beforeEach(() => {
	vi.stubGlobal('fetch', failFastFetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ==========================================
// ROUTING
// ==========================================
describe('routing', () => {
	it('API sconosciuta → 404 JSON (no fallback asset)', async () => {
		const res = await worker.fetch(new Request(`${ORIGIN}/api/nope`), makeEnv());
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'Not found' });
	});

	it('percorsi non-API sono serviti dagli asset statici', async () => {
		const res = await worker.fetch(new Request(`${ORIGIN}/menu.html`), makeEnv());
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('static-asset');
	});

	it('alias legacy /.netlify/functions/save-data usa lo stesso handler', async () => {
		const res = await worker.fetch(
			post('/.netlify/functions/save-data', { action: 'verify-token', token: validToken() }),
			makeEnv()
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ valid: true, email: ADMIN_EMAIL });
	});

	it('fallback /admin/*: asset 404 → serve /admin/index.html', async () => {
		const assetsFetch = vi.fn(async (input: Request | string) => {
			const url = new URL(typeof input === 'string' ? input : input.url);
			if (url.pathname === '/admin/index.html') {
				return new Response('ADMIN-INDEX', { status: 200 });
			}
			return new Response('Not found', { status: 404 });
		});
		const env = makeEnv({ ASSETS: { fetch: assetsFetch } as unknown as Env['ASSETS'] });
		const res = await worker.fetch(new Request(`${ORIGIN}/admin/qualcosa`), env);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ADMIN-INDEX');
		expect(assetsFetch).toHaveBeenCalledTimes(2);
	});
});

// ==========================================
// HEALTH
// ==========================================
describe('health', () => {
	it('senza token → solo liveness {ok:true}, nessuna config esposta', async () => {
		const res = await worker.fetch(new Request(`${ORIGIN}/api/health`), makeEnv());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('method not allowed → 405', async () => {
		const res = await worker.fetch(
			new Request(`${ORIGIN}/api/health`, { method: 'DELETE' }),
			makeEnv()
		);
		expect(res.status).toBe(405);
	});
});

// ==========================================
// CORS
// ==========================================
describe('CORS', () => {
	it('same-origin del deployment → ACAO impostato', async () => {
		const res = await worker.fetch(
			post('/api/save-data', { action: 'verify-token', token: validToken() }, { Origin: ORIGIN }),
			makeEnv()
		);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
		expect(res.headers.get('Vary')).toBe('Origin');
	});

	it('origine in allowlist → ACAO impostato', async () => {
		const res = await worker.fetch(
			post('/api/save-data', { action: 'verify-token', token: validToken() }, { Origin: 'https://arconti31.com' }),
			makeEnv()
		);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://arconti31.com');
	});

	it('origine vietata → nessun ACAO (no fallback *)', async () => {
		const res = await worker.fetch(
			post('/api/save-data', { action: 'verify-token', token: validToken() }, { Origin: 'https://evil.example' }),
			makeEnv()
		);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
		expect(res.headers.get('Vary')).toBe('Origin');
	});
});

// ==========================================
// LOGIN + TOKEN
// ==========================================
describe('auth', () => {
	it('login corretto → 200 con token verificabile', async () => {
		const res = await worker.fetch(
			post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, { 'CF-Connecting-IP': '10.0.0.1' }),
			makeEnv()
		);
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data.email).toBe(ADMIN_EMAIL);
		expect(data.user).toEqual({ email: ADMIN_EMAIL, role: 'admin' });
		// Il token emesso deve superare la verifica
		const verify = await worker.fetch(post('/api/auth/verify', { token: data.token }), makeEnv());
		expect(verify.status).toBe(200);
	});

	it('login errato → 401 senza token', async () => {
		const res = await worker.fetch(
			post('/api/auth/login', { email: ADMIN_EMAIL, password: 'sbagliata' }, { 'CF-Connecting-IP': '10.0.0.2' }),
			makeEnv()
		);
		expect(res.status).toBe(401);
		expect(((await res.json()) as any).token).toBeUndefined();
	});

	it('login senza CMS_TOKEN_SECRET → 500 fail loud (mai fallback su ADMIN_PASSWORD)', async () => {
		const env = makeEnv({ CMS_TOKEN_SECRET: undefined, TOKEN_SECRET: undefined });
		const res = await worker.fetch(
			post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, { 'CF-Connecting-IP': '10.0.0.3' }),
			env
		);
		expect(res.status).toBe(500);
		expect(((await res.json()) as any).code).toBe('AUTH_CONFIG_MISSING');
	});

	it('token valido → 200', async () => {
		const res = await worker.fetch(post('/api/auth/verify', { token: validToken() }), makeEnv());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ valid: true, email: ADMIN_EMAIL });
	});

	it('token scaduto → 401', async () => {
		const expired = makeToken({ email: ADMIN_EMAIL, exp: Date.now() - 1000 });
		const res = await worker.fetch(post('/api/auth/verify', { token: expired }), makeEnv());
		expect(res.status).toBe(401);
	});

	it('token alterato (firma non valida) → 401', async () => {
		const tampered = makeToken({ email: ADMIN_EMAIL, exp: Date.now() + 60_000 }, 'altro-secret');
		const res = await worker.fetch(post('/api/auth/verify', { token: tampered }), makeEnv());
		expect(res.status).toBe(401);
	});
});

// ==========================================
// VALIDAZIONE INPUT save-data
// ==========================================
describe('save-data: validazione input', () => {
	it('payload JSON non valido → 400', async () => {
		const res = await worker.fetch(post('/api/save-data', 'non-json{'), makeEnv());
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toBe('JSON non valido');
	});

	it('path traversal in collection → 400', async () => {
		const res = await worker.fetch(
			post('/api/save-data', { action: 'save', collection: '../secrets', filename: 'x.md', token: validToken() }),
			makeEnv()
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toBe('Collection non valida');
	});

	it('filename non valido (slash) → 400', async () => {
		const res = await worker.fetch(
			post('/api/save-data', { action: 'save', collection: 'beers', filename: 'a/b.md', token: validToken() }),
			makeEnv()
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toBe('Filename non valido');
	});

	it('metodo GET → 405', async () => {
		const res = await worker.fetch(new Request(`${ORIGIN}/api/save-data`), makeEnv());
		expect(res.status).toBe(405);
	});

	it('senza token → 401', async () => {
		const res = await worker.fetch(post('/api/save-data', { action: 'whoami' }), makeEnv());
		expect(res.status).toBe(401);
	});
});

// ==========================================
// SAVE: SHA corretto + conflitto (GitHub mockato)
// ==========================================
const MD_CONTENT = '---\nnome: Test Beer\nsezione: Birre alla spina\nprezzo: "5.00"\n---\n';
const CATEGORIE_JSON = {
	categories: [
		{ nome: 'Birre alla spina', slug: 'birre-alla-spina', tipo_menu: 'beverage', _filename: 'birre-alla-spina.md', visibile: true, order: 1 }
	]
};
const BEERS_JSON = {
	beers: [
		{ nome: 'Test Beer', sezione: 'Birre alla spina', prezzo: '5.00', order: 1, _filename: 'test-beer.md' }
	]
};

function mockGithubForSave(options: { currentBlobSha: string; putSha?: string }) {
	const calls: { method: string; url: string }[] = [];
	vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = (init?.method || 'GET').toUpperCase();
		calls.push({ method, url });

		if (url.includes('/contents/beers/test-beer.md?ref=')) {
			return githubJson({ sha: options.currentBlobSha });
		}
		if (url.endsWith('/contents/beers/test-beer.md') && method === 'GET') {
			return githubJson({ content: b64(MD_CONTENT), sha: 'sha-attuale' });
		}
		if (url.endsWith('/contents/beers/test-beer.md') && method === 'PUT') {
			return githubJson({ content: { sha: options.putSha || 'sha-nuovo' } });
		}
		if (url.endsWith('/contents/categorie/categorie.json')) {
			return githubJson({ content: b64(JSON.stringify(CATEGORIE_JSON)) });
		}
		if (url.endsWith('/contents/beers/beers.json')) {
			return githubJson({ content: b64(JSON.stringify(BEERS_JSON)) });
		}
		throw new Error(`GitHub mock: URL non gestita ${method} ${url}`);
	});
	return calls;
}

describe('save-data: salvataggio', () => {
	it('save con SHA corretto (skipRegeneration) → 200 con nuovo sha', async () => {
		const calls = mockGithubForSave({ currentBlobSha: 'sha-attuale', putSha: 'sha-nuovo-123' });
		const res = await worker.fetch(
			post('/api/save-data', {
				action: 'save',
				collection: 'beers',
				filename: 'test-beer.md',
				sha: 'sha-attuale',
				skipRegeneration: true,
				token: validToken(),
				data: { nome: 'Test Beer', sezione: 'birre-alla-spina', prezzo: '5' }
			}),
			makeEnv()
		);
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data.success).toBe(true);
		expect(data.sha).toBe('sha-nuovo-123');
		expect(data.target).toEqual({ owner: 'owner', repo: 'repo', branch: 'main' });
		// La PUT deve essere avvenuta davvero (sul mock)
		expect(calls.some(c => c.method === 'PUT' && c.url.endsWith('/contents/beers/test-beer.md'))).toBe(true);
	});

	it('conflitto SHA (blob cambiato su GitHub) → 409, nessun commit', async () => {
		const calls = mockGithubForSave({ currentBlobSha: 'sha-diverso-remoto' });
		const res = await worker.fetch(
			post('/api/save-data', {
				action: 'save',
				collection: 'beers',
				filename: 'test-beer.md',
				sha: 'sha-vecchio-client',
				token: validToken(),
				data: { nome: 'Test Beer', sezione: 'birre-alla-spina', prezzo: '5' }
			}),
			makeEnv()
		);
		expect(res.status).toBe(409);
		expect(((await res.json()) as any).error).toContain('Conflitto');
		// Nessuna scrittura: solo GET verso GitHub
		expect(calls.every(c => c.method === 'GET')).toBe(true);
	});
});

// ==========================================
// READ-DATA
// ==========================================
describe('read-data', () => {
	it('lettura pubblica da JSON statico → 200 source=json', async () => {
		vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === 'https://raw.githubusercontent.com/owner/repo/main/food/food.json') {
				return githubJson({ food: [{ nome: 'Pizza', prezzo: '8.00' }] });
			}
			throw new Error(`fetch non mockata: ${url}`);
		});
		const res = await worker.fetch(post('/api/read-data', { folder: 'food' }), makeEnv());
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data.source).toBe('json');
		// Stesso formato della Netlify Function legacy: item wrappato con parsedItem
		expect(data.items).toHaveLength(1);
		expect(data.items[0].fromJSON).toBe(true);
		expect(data.items[0].sha).toBeNull();
		expect(data.items[0].parsedItem).toEqual({ nome: 'Pizza', prezzo: '8.00' });
	});

	it('JSON statico mancante → 503 json-miss (mai 200 + lista vuota)', async () => {
		vi.stubGlobal('fetch', async () => new Response('Not found', { status: 404 }));
		const res = await worker.fetch(post('/api/read-data', { folder: 'food' }), makeEnv());
		expect(res.status).toBe(503);
		expect(((await res.json()) as any).source).toBe('json-miss');
	});

	it('mode=api senza token → 401 (il PAT server non si usa senza auth)', async () => {
		const res = await worker.fetch(post('/api/read-data', { folder: 'food', mode: 'api' }), makeEnv());
		expect(res.status).toBe(401);
	});

	it('mode=api con token valido → usa API GitHub autenticata', async () => {
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === 'https://api.github.com/repos/owner/repo/contents/food') {
				// Verifica che il PAT venga usato SOLO qui, dopo l'auth utente
				const auth = new Headers(init?.headers).get('Authorization');
				expect(auth).toBe('token gh-test-token');
				return githubJson([]);
			}
			throw new Error(`fetch non mockata: ${url}`);
		});
		const res = await worker.fetch(
			post('/api/read-data', { folder: 'food', mode: 'api', token: validToken() }),
			makeEnv()
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as any).source).toBe('api');
	});

	it('folder con path traversal → 400', async () => {
		const res = await worker.fetch(post('/api/read-data', { folder: '../secrets' }), makeEnv());
		expect(res.status).toBe(400);
	});
});

// ==========================================
// CLOUDINARY SIGNATURE
// ==========================================
describe('cloudinary-signature', () => {
	it('firma valida senza esporre il secret', async () => {
		const res = await worker.fetch(
			post('/api/cloudinary-signature', { token: validToken() }),
			makeEnv()
		);
		expect(res.status).toBe(200);
		const raw = await res.text();
		expect(raw).not.toContain('cloudinary-secret-456');
		const data = JSON.parse(raw);
		expect(data.cloudName).toBe('democloud');
		expect(data.apiKey).toBe('key123');
		expect(data.uploadUrl).toBe('https://api.cloudinary.com/v1_1/democloud/image/upload');
		// La firma deve corrispondere a SHA-1(folder=X&timestamp=Y + secret)
		const { createHash } = await import('node:crypto');
		const expected = createHash('sha1')
			.update(`folder=${data.folder}&timestamp=${data.timestamp}cloudinary-secret-456`)
			.digest('hex');
		expect(data.signature).toBe(expected);
	});

	it('senza token → 401', async () => {
		const res = await worker.fetch(post('/api/cloudinary-signature', {}), makeEnv());
		expect(res.status).toBe(401);
	});
});
