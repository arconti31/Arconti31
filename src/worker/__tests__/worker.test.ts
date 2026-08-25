// Test del Worker Arconti31 — copre i casi richiesti dalla migrazione:
// routing, health, method not allowed, CORS, login, token, path traversal,
// payload non validi, save con SHA/conflitto, read pubblica/API,
// firma Cloudinary, fallback /admin.
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

	function adminAssetsEnv() {
		const assetsFetch = vi.fn(async (input: Request | string) => {
			const url = new URL(typeof input === 'string' ? input : input.url);
			if (url.pathname === '/admin/index.html') {
				return new Response('ADMIN-INDEX', { status: 200 });
			}
			return new Response('Not found', { status: 404 });
		});
		return {
			assetsFetch,
			env: makeEnv({ ASSETS: { fetch: assetsFetch } as unknown as Env['ASSETS'] })
		};
	}

	it('fallback /admin/*: navigazione HTML su asset 404 → serve /admin/index.html', async () => {
		const { assetsFetch, env } = adminAssetsEnv();
		const res = await worker.fetch(
			new Request(`${ORIGIN}/admin/qualcosa`, {
				headers: { Accept: 'text/html,application/xhtml+xml', 'Sec-Fetch-Mode': 'navigate' }
			}),
			env
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ADMIN-INDEX');
		expect(assetsFetch).toHaveBeenCalledTimes(2);
	});

	it('asset /admin mancante con estensione → resta 404 (mai HTML al posto del JS)', async () => {
		const { assetsFetch, env } = adminAssetsEnv();
		const res = await worker.fetch(
			new Request(`${ORIGIN}/admin/manca.js`, {
				headers: { Accept: '*/*', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' }
			}),
			env
		);
		expect(res.status).toBe(404);
		// Nessun secondo giro su /admin/index.html
		expect(assetsFetch).toHaveBeenCalledTimes(1);
	});

	it('POST su route /admin inesistente → 404, nessun fallback SPA', async () => {
		const { env } = adminAssetsEnv();
		const res = await worker.fetch(
			new Request(`${ORIGIN}/admin/qualcosa`, { method: 'POST', headers: { Accept: 'text/html' } }),
			env
		);
		expect(res.status).toBe(404);
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
const CATEGORIE_JSON = {
	categories: [
		{ nome: 'Birre alla spina', slug: 'birre-alla-spina', tipo_menu: 'beverage', _filename: 'birre-alla-spina.md', visibile: true, order: 1 }
	]
};

function beerRecord(nome: string, filename: string, prezzo: string, order: number) {
	return { nome, sezione: 'Birre alla spina', sezione_slug: 'birre-alla-spina', prezzo, order, _filename: filename };
}

function beerMarkdown(nome: string, prezzo: string, order: number): string {
	return `---\nnome: ${nome}\nsezione: Birre alla spina\nsezione_slug: birre-alla-spina\nprezzo: "${prezzo}"\norder: ${order}\n---\n`;
}

function fakeBlobSha(content: string): string {
	return 'blob-' + createHmac('sha256', 'mock').update(content).digest('hex').slice(0, 12);
}

/**
 * Simulatore minimale del repository GitHub: tiene i file, la HEAD del branch e
 * applica gli alberi committati. Serve per verificare COSA finisce davvero nel
 * commit (in particolare il JSON aggregato) e per simulare una scrittura
 * concorrente che sposta la HEAD tra la lettura e la PATCH della ref.
 */
function mockGithubRepo(
	initialFiles: Record<string, string>,
	options: { onFirstPatch?: (state: RepoState) => void } = {}
) {
	interface Tree { entries: any[] }
	const state = {
		files: new Map(Object.entries(initialFiles)),
		head: 'commit-1',
		tree: 'tree-1',
		patches: 0,
		seq: 0,
		calls: [] as { method: string; url: string }[],
		trees: new Map<string, Tree>()
	};

	function applyTree(entries: any[]) {
		for (const entry of entries) {
			if (entry.sha === null) state.files.delete(entry.path);
			else state.files.set(entry.path, entry.content);
		}
	}

	vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = (init?.method || 'GET').toUpperCase();
		state.calls.push({ method, url });
		const body = init?.body ? JSON.parse(String(init.body)) : null;

		const branchMatch = url.match(/\/branches\/(.+)$/);
		if (method === 'GET' && branchMatch) {
			return githubJson({ commit: { sha: state.head, commit: { tree: { sha: state.tree } } } });
		}

		const contentsMatch = url.match(/\/contents\/([^?]+)(\?ref=(.+))?$/);
		if (method === 'GET' && contentsMatch) {
			const path = decodeURIComponent(contentsMatch[1]).split('/').map(decodeURIComponent).join('/');
			if (state.files.has(path)) {
				const content = state.files.get(path)!;
				return githubJson({ path, name: path.split('/').pop(), content: b64(content), sha: fakeBlobSha(content) });
			}
			// Directory listing
			const prefix = `${path}/`;
			const children = [...state.files.keys()].filter(p => p.startsWith(prefix));
			if (children.length > 0) {
				return githubJson(children.map(p => ({
					name: p.slice(prefix.length),
					path: p,
					type: 'file',
					sha: fakeBlobSha(state.files.get(p)!)
				})));
			}
			return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
		}

		// Lettura in blocco: un alias per file, tutto in una sola chiamata
		if (method === 'POST' && url.endsWith('/graphql')) {
			const repository: Record<string, any> = {};
			Object.entries(body.variables as Record<string, string>)
				.filter(([key]) => /^e\d+$/.test(key))
				.forEach(([key, expression]) => {
					const path = expression.slice(expression.indexOf(':') + 1);
					const content = state.files.get(path);
					repository[`f${key.slice(1)}`] =
						content === undefined ? null : { text: content, oid: fakeBlobSha(content) };
				});
			return githubJson({ data: { repository } });
		}

		if (method === 'POST' && url.endsWith('/git/trees')) {
			const sha = `tree-${++state.seq}`;
			state.trees.set(sha, { entries: body.tree });
			return githubJson({ sha });
		}

		if (method === 'POST' && url.endsWith('/git/commits')) {
			const sha = `commit-${++state.seq}`;
			state.trees.set(sha, state.trees.get(body.tree)!);
			return githubJson({ sha, parents: body.parents });
		}

		if (method === 'PATCH' && url.includes('/git/refs/heads/')) {
			state.patches++;
			if (state.patches === 1 && options.onFirstPatch) {
				options.onFirstPatch(state);
				return new Response(
					JSON.stringify({ message: 'Update is not a fast forward' }),
					{ status: 422 }
				);
			}
			applyTree(state.trees.get(body.sha)!.entries);
			state.head = body.sha;
			state.tree = body.sha;
			return githubJson({ object: { sha: body.sha } });
		}

		throw new Error(`GitHub mock: URL non gestita ${method} ${url}`);
	});

	return state;
}

type RepoState = ReturnType<typeof mockGithubRepo>;

function baseRepo(): Record<string, string> {
	return {
		'categorie/categorie.json': JSON.stringify(CATEGORIE_JSON),
		'beers/beers.json': JSON.stringify({
			beers: [beerRecord('Beer A', 'beer-a.md', '5.00', 1), beerRecord('Beer B', 'beer-b.md', '6.00', 2)],
			beersBySection: {}
		}),
		'beers/beer-a.md': beerMarkdown('Beer A', '5.00', 1),
		'beers/beer-b.md': beerMarkdown('Beer B', '6.00', 2)
	};
}

function savePost(overrides: Record<string, unknown> = {}) {
	return post('/api/save-data', {
		action: 'save',
		collection: 'beers',
		filename: 'beer-b.md',
		token: validToken(),
		data: { nome: 'Beer B', sezione: 'birre-alla-spina', prezzo: '9.00', order: 2 },
		...overrides
	});
}

describe('save-data: salvataggio', () => {
	it('save con SHA corretto → commit con .md e JSON aggregato allineati', async () => {
		const repo = mockGithubRepo(baseRepo());
		const res = await worker.fetch(
			savePost({ sha: fakeBlobSha(baseRepo()['beers/beer-b.md']) }),
			makeEnv()
		);
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data.success).toBe(true);
		expect(data.target).toEqual({ owner: 'owner', repo: 'repo', branch: 'main' });

		// Il commit deve contenere sia il markdown sia il JSON rigenerato
		expect(repo.files.get('beers/beer-b.md')).toContain('9.00');
		const beersJson = JSON.parse(repo.files.get('beers/beers.json')!);
		expect(beersJson.beers.find((b: any) => b._filename === 'beer-b.md').prezzo).toBe('9.00');
	});

	it('save con order uguali mantiene il JSON nell’ordine canonico per filename', async () => {
		const initialFiles = {
			'categorie/categorie.json': JSON.stringify(CATEGORIE_JSON),
			'beers/beers.json': JSON.stringify({
				beers: [
					beerRecord('Beer C', 'beer-c.md', '7.00', 0),
					beerRecord('Beer A', 'beer-a.md', '5.00', 0),
					beerRecord('Beer B', 'beer-b.md', '6.00', 0)
				],
				beersBySection: {}
			}),
			'beers/beer-a.md': beerMarkdown('Beer A', '5.00', 0),
			'beers/beer-b.md': beerMarkdown('Beer B', '6.00', 0),
			'beers/beer-c.md': beerMarkdown('Beer C', '7.00', 0)
		};
		const repo = mockGithubRepo(initialFiles);

		const res = await worker.fetch(
			savePost({
				filename: 'beer-b.md',
				sha: fakeBlobSha(initialFiles['beers/beer-b.md']),
				data: {
					nome: 'Beer B',
					sezione: 'birre-alla-spina',
					prezzo: '9.00',
					order: 0
				}
			}),
			makeEnv()
		);

		expect(res.status).toBe(200);
		const beersJson = JSON.parse(repo.files.get('beers/beers.json')!);
		const expectedOrder = ['beer-a.md', 'beer-b.md', 'beer-c.md'];
		expect(beersJson.beers.map((item: any) => item._filename)).toEqual(expectedOrder);
		expect(beersJson.beersBySection['Birre alla spina'].map((item: any) => item._filename))
			.toEqual(expectedOrder);
	});

	it('conflitto SHA (blob cambiato su GitHub) → 409, nessuna scrittura', async () => {
		const repo = mockGithubRepo(baseRepo());
		const res = await worker.fetch(savePost({ sha: 'blob-vecchio-del-client' }), makeEnv());

		expect(res.status).toBe(409);
		expect(((await res.json()) as any).error).toContain('Conflitto');
		expect(repo.calls.every(c => c.method === 'GET')).toBe(true);
	});

	it('save senza sha su file esistente → 409', async () => {
		mockGithubRepo(baseRepo());
		const res = await worker.fetch(savePost(), makeEnv());
		expect(res.status).toBe(409);
	});

	it('ogni lettura contents porta ?ref= con il commit pinnato', async () => {
		const repo = mockGithubRepo(baseRepo());
		await worker.fetch(savePost({ sha: fakeBlobSha(baseRepo()['beers/beer-b.md']) }), makeEnv());

		const contentReads = repo.calls.filter(c => c.method === 'GET' && c.url.includes('/contents/'));
		expect(contentReads.length).toBeGreaterThan(0);
		for (const call of contentReads) {
			expect(call.url).toContain('?ref=commit-1');
		}
	});

	// Guardia sui costi: le chiamate GitHub sono la risorsa scarsa (5.000/ora sul
	// PAT, 50 subrequest per invocazione Worker). Se questo numero cresce, è una
	// regressione di efficienza da giustificare, non un dettaglio.
	// NON è un limite applicato a runtime: è un'asserzione di test. Il solo tetto
	// che agisce in produzione è DEFAULT_SUBREQUEST_BUDGET (40) nel client GitHub,
	// che esiste per non sfondare le 50 subrequest di Cloudflare.
	it('un salvataggio costa 7 chiamate GitHub (1 branch + 3 letture + 3 scritture)', async () => {
		const repo = mockGithubRepo(baseRepo());
		const res = await worker.fetch(
			savePost({ sha: fakeBlobSha(baseRepo()['beers/beer-b.md']) }),
			makeEnv()
		);
		expect(res.status).toBe(200);

		const writes = repo.calls.filter(c => c.method !== 'GET');
		expect(writes).toHaveLength(3); // POST tree + POST commit + PATCH ref
		// 1 GET /branches (pin) + GET del .md + GET categorie.json + GET beers.json.
		// La rilettura del .md per l'OCC e le categorie per il JSON aggregato sono
		// servite dalla cache per-richiesta del client.
		expect(repo.calls).toHaveLength(7);
	});

	it('GITHUB_BRANCH non-default: legge e scrive sullo stesso branch', async () => {
		const repo = mockGithubRepo(baseRepo());
		const env = makeEnv({ GITHUB_BRANCH: 'staging/cloudflare' });
		const res = await worker.fetch(savePost({ sha: fakeBlobSha(baseRepo()['beers/beer-b.md']) }), env);

		expect(res.status).toBe(200);
		expect(repo.calls.some(c => c.url.includes('/branches/staging%2Fcloudflare'))).toBe(true);
		expect(repo.calls.some(c =>
			c.method === 'PATCH' && c.url.includes('/git/refs/heads/staging/cloudflare')
		)).toBe(true);
		// Nessuna lettura senza ref esplicito (che ricadrebbe sul default del repo)
		expect(repo.calls.every(c => !c.url.includes('/contents/') || c.url.includes('?ref='))).toBe(true);
	});
});

// ==========================================
// CONCORRENZA — la regressione che rompeva i JSON aggregati
// ==========================================
describe('save-data: scritture concorrenti', () => {
	it('HEAD spostata durante il salvataggio → il JSON finale contiene entrambe le modifiche', async () => {
		// Mentre l'admin B salva Beer B, l'admin A committa un prezzo nuovo su Beer A.
		const repo = mockGithubRepo(baseRepo(), {
			onFirstPatch: state => {
				state.files.set('beers/beer-a.md', beerMarkdown('Beer A', '7.77', 1));
				state.files.set('beers/beers.json', JSON.stringify({
					beers: [beerRecord('Beer A', 'beer-a.md', '7.77', 1), beerRecord('Beer B', 'beer-b.md', '6.00', 2)],
					beersBySection: {}
				}));
				state.head = 'commit-concorrente';
				state.tree = 'tree-concorrente';
			}
		});

		const res = await worker.fetch(
			savePost({ sha: fakeBlobSha(baseRepo()['beers/beer-b.md']) }),
			makeEnv()
		);
		expect(res.status).toBe(200);

		const beersJson = JSON.parse(repo.files.get('beers/beers.json')!);
		const byFile = Object.fromEntries(beersJson.beers.map((b: any) => [b._filename, b.prezzo]));
		// Prima della correzione il retry riusava le tree entry calcolate sullo
		// snapshot iniziale: beer-a tornava a 5.00 e la modifica dell'admin A
		// spariva dal menù pubblico pur restando nel .md.
		expect(byFile['beer-a.md']).toBe('7.77');
		expect(byFile['beer-b.md']).toBe('9.00');
		expect(repo.patches).toBe(2);
	});

	it('conflitto sullo STESSO file durante il retry → 409, nessuna sovrascrittura', async () => {
		const repo = mockGithubRepo(baseRepo(), {
			onFirstPatch: state => {
				// L'altro admin ha toccato proprio beer-b.md
				state.files.set('beers/beer-b.md', beerMarkdown('Beer B', '11.00', 2));
				state.head = 'commit-concorrente';
				state.tree = 'tree-concorrente';
			}
		});

		const res = await worker.fetch(
			savePost({ sha: fakeBlobSha(baseRepo()['beers/beer-b.md']) }),
			makeEnv()
		);
		expect(res.status).toBe(409);
		// Il contenuto dell'altro admin resta intatto
		expect(repo.files.get('beers/beer-b.md')).toContain('11.00');
	});
});

// ==========================================
// BATCH — deve reggere l'intera carta in un solo commit, come su Netlify
// ==========================================
describe('save-data: batch grandi', () => {
	function bigBeerRepo(count: number) {
		const files: Record<string, string> = {
			'categorie/categorie.json': JSON.stringify(CATEGORIE_JSON)
		};
		const records = [];
		for (let i = 0; i < count; i++) {
			const filename = `beer-${i}.md`;
			files[`beers/${filename}`] = beerMarkdown(`Beer ${i}`, '5.00', i);
			records.push(beerRecord(`Beer ${i}`, filename, '5.00', i));
		}
		files['beers/beers.json'] = JSON.stringify({ beers: records, beersBySection: {} });
		return files;
	}

	it('riordino di 95 prodotti → UN commit e poche chiamate GitHub', async () => {
		const repo = mockGithubRepo(bigBeerRepo(95));
		// Ordine invertito: cambiano tutti e 95
		const items = Array.from({ length: 95 }, (_, i) => ({ filename: `beer-${i}.md`, order: 94 - i }));

		const res = await worker.fetch(
			post('/api/save-data', {
				action: 'batch-save-order', collection: 'beers', items, token: validToken()
			}),
			makeEnv()
		);

		expect(res.status).toBe(200);
		// 94, non 95: invertendo un numero dispari di posizioni quella centrale
		// resta dov'è e non viene riscritta (nessun commit inutile).
		expect(((await res.json()) as any).updated).toBe(94);

		// Un solo commit, come faceva la Netlify Function
		expect(repo.patches).toBe(1);
		// I 95 .md letti in blocco: senza GraphQL servirebbero 95 GET e il Worker
		// morirebbe contro il limite di 50 subrequest del piano free.
		expect(repo.calls.length).toBeLessThanOrEqual(10);
		expect(repo.calls.filter(c => c.url.endsWith('/graphql'))).toHaveLength(1);

		// Contenuti davvero patchati, e solo nel campo order
		// (le virgolette sono la normalizzazione YAML di stringifyFrontmatter,
		// la stessa libreria usata dal build locale)
		expect(repo.files.get('beers/beer-0.md')).toContain('order: 94');
		expect(repo.files.get('beers/beer-0.md')).toContain('nome: "Beer 0"');
		expect(repo.files.get('beers/beer-0.md')).toContain('prezzo: "5.00"');
		const beersJson = JSON.parse(repo.files.get('beers/beers.json')!);
		expect(beersJson.beers[0]._filename).toBe('beer-94.md');
	});

	it('batch visibility su tutte le categorie → un commit, un blocco di letture', async () => {
		const repo = mockGithubRepo(baseRepo());
		const res = await worker.fetch(
			post('/api/save-data', {
				action: 'batch-set-visibility',
				collection: 'beers',
				visibile: false,
				items: [{ filename: 'beer-a.md' }, { filename: 'beer-b.md' }],
				token: validToken()
			}),
			makeEnv()
		);

		expect(res.status).toBe(200);
		expect(((await res.json()) as any).updated).toBe(2);
		expect(repo.patches).toBe(1);
		expect(repo.files.get('beers/beer-a.md')).toContain('visibile: false');
		// Prezzo e nome intatti: si patcha solo `visibile`
		expect(repo.files.get('beers/beer-a.md')).toContain('prezzo: "5.00"');
	});
});

// ==========================================
// FAIL-CLOSED — un guasto GitHub non deve diventare "collezione vuota"
// ==========================================
describe('save-data: letture fail-closed', () => {
	it('502 su una lettura → nessun commit, risposta 503 (mai JSON troncato)', async () => {
		const calls: string[] = [];
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = (init?.method || 'GET').toUpperCase();
			calls.push(`${method} ${url}`);
			if (url.includes('/branches/')) {
				return githubJson({ commit: { sha: 'commit-1', commit: { tree: { sha: 'tree-1' } } } });
			}
			if (url.includes('/contents/beers/beers.json')) {
				return new Response('upstream down', { status: 502 });
			}
			if (url.includes('/contents/categorie/categorie.json')) {
				return githubJson({ content: b64(JSON.stringify(CATEGORIE_JSON)), sha: 'sha-cat' });
			}
			if (url.includes('/contents/beers/beer-b.md')) {
				return githubJson({ content: b64(beerMarkdown('Beer B', '6.00', 2)), sha: 'sha-b' });
			}
			throw new Error(`URL non gestita: ${method} ${url}`);
		});

		const res = await worker.fetch(savePost({ sha: 'sha-b' }), makeEnv());

		expect(res.status).toBe(503);
		// Nessuna scrittura verso GitHub
		expect(calls.every(c => c.startsWith('GET'))).toBe(true);
		// E nessun dettaglio del body GitHub rimandato al browser
		expect(((await res.json()) as any).error).not.toContain('upstream down');
	});
});

// ==========================================
// VALIDAZIONE SCHEMA
// ==========================================
describe('save-data: schema delle action', () => {
	it('collection non stringa → 400 (non più 500 da TypeError)', async () => {
		const res = await worker.fetch(
			post('/api/save-data', {
				action: 'save', collection: {}, filename: [], token: validToken(), data: {}
			}),
			makeEnv()
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toBe('Collection non valida');
	});

	it('action regenerate-json → 400: non è più esposta dal Worker', async () => {
		const res = await worker.fetch(
			post('/api/save-data', { action: 'regenerate-json', collection: 'beers', token: validToken() }),
			makeEnv()
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toBe('Azione non valida');
	});

	it('skipRegeneration nel body viene ignorato: il JSON è comunque rigenerato', async () => {
		const repo = mockGithubRepo(baseRepo());
		const res = await worker.fetch(
			savePost({ sha: fakeBlobSha(baseRepo()['beers/beer-b.md']), skipRegeneration: true }),
			makeEnv()
		);
		expect(res.status).toBe(200);
		const beersJson = JSON.parse(repo.files.get('beers/beers.json')!);
		expect(beersJson.beers.find((b: any) => b._filename === 'beer-b.md').prezzo).toBe('9.00');
	});

	it('batch oltre il tetto assoluto → 400', async () => {
		mockGithubRepo(baseRepo());
		const items = Array.from({ length: 501 }, (_, i) => ({ filename: `beer-${i}.md`, order: i }));
		const res = await worker.fetch(
			post('/api/save-data', {
				action: 'batch-save-order', collection: 'beers', items, token: validToken()
			}),
			makeEnv()
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toContain('Troppi elementi');
	});

	it('body oltre il limite → 413', async () => {
		const huge = JSON.stringify({ action: 'save', data: 'x'.repeat(600 * 1024) });
		const res = await worker.fetch(post('/api/save-data', huge), makeEnv());
		expect(res.status).toBe(413);
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

	it('mode=api con token valido → API GitHub autenticata, sempre con ?ref=', async () => {
		let listingUrl = '';
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.startsWith('https://api.github.com/repos/owner/repo/contents/food')) {
				listingUrl = url;
				// Verifica che il PAT venga usato SOLO qui, dopo l'auth utente
				expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer gh-test-token');
				return githubJson([]);
			}
			if (url.startsWith('https://raw.githubusercontent.com/')) {
				return githubJson({ food: [] });
			}
			throw new Error(`fetch non mockata: ${url}`);
		});
		const res = await worker.fetch(
			post('/api/read-data', { folder: 'food', mode: 'api', token: validToken() }),
			makeEnv()
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as any).source).toBe('api');
		expect(listingUrl).toContain('?ref=main');
	});

	it('mode=api su collection grande → 2 chiamate GitHub (listing SHA + JSON), non una per file', async () => {
		const files = Array.from({ length: 60 }, (_, i) => ({
			name: `piatto-${i}.md`,
			path: `food/piatto-${i}.md`,
			type: 'file',
			sha: `sha-${i}`
		}));
		const apiCalls: string[] = [];
		vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith('https://api.github.com/')) {
				apiCalls.push(url);
				if (url.includes('/contents/food')) return githubJson(files);
				throw new Error(`chiamata API imprevista: ${url}`);
			}
			if (url === 'https://raw.githubusercontent.com/owner/repo/main/food/food.json') {
				return githubJson({
					food: files.map((f, i) => ({ nome: `Piatto ${i}`, prezzo: '1.00', _filename: f.name }))
				});
			}
			throw new Error(`fetch non mockata: ${url}`);
		});

		const res = await worker.fetch(
			post('/api/read-data', { folder: 'food', mode: 'api', token: validToken() }),
			makeEnv()
		);

		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data.items).toHaveLength(60);
		// SHA reali dal listing: servono al client per l'OCC sui salvataggi
		expect(data.items[0].sha).toBe('sha-0');
		// Una sola chiamata all'API GitHub: senza questo servivano 61 subrequest
		// e il Worker moriva contro il limite di 50 del piano free.
		expect(apiCalls).toHaveLength(1);
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

// ==========================================
// RELAY LEGACY BASE64 (/api/upload-image)
// ==========================================
describe('upload-image (relay legacy)', () => {
	it('data URL valido → inoltrato a Cloudinary, ritorna secure_url', async () => {
		vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith('https://api.cloudinary.com/')) {
				return githubJson({ secure_url: 'https://res.cloudinary.com/democloud/x.png' });
			}
			throw new Error(`fetch non mockata: ${url}`);
		});
		const res = await worker.fetch(
			post('/api/upload-image', {
				token: validToken(),
				file: `data:image/png;base64,${b64('x'.repeat(1024))}`
			}),
			makeEnv()
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as any).url).toBe('https://res.cloudinary.com/democloud/x.png');
	});

	// Il cap generale dei body è 512 KB: qui deve restare più alto, altrimenti
	// il fallback legacy sarebbe irraggiungibile per qualsiasi immagine reale.
	it('data URL da ~1MB non viene rifiutato dal cap generale sui body', async () => {
		vi.stubGlobal('fetch', async () => githubJson({ secure_url: 'https://res.cloudinary.com/democloud/y.png' }));
		const res = await worker.fetch(
			post('/api/upload-image', {
				token: validToken(),
				file: `data:image/png;base64,${'A'.repeat(1024 * 1024)}`
			}),
			makeEnv()
		);
		expect(res.status).toBe(200);
	});

	it('payload oltre il limite di upload → 413', async () => {
		const res = await worker.fetch(
			post('/api/upload-image', {
				token: validToken(),
				file: `data:image/png;base64,${'A'.repeat(6 * 1024 * 1024)}`
			}),
			makeEnv()
		);
		expect(res.status).toBe(413);
	});
});
