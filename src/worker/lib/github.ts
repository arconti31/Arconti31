// Client GitHub API con cache GET per-richiesta (istanza creata a ogni request:
// niente stato globale mutabile tra richieste, a differenza del vecchio
// `requestGetCache` globale delle Netlify Functions).
//
// Proprietà chiave:
// - il client conosce owner/repo/branch e un `ref` PINNATO (commit SHA): tutte le
//   letture `contents/` avvengono su quello stesso commit immutabile, così una
//   transazione legge uno snapshot coerente e non un branch che si muove sotto;
// - errori TIPIZZATI (`GitHubApiError`) con status/codice: i chiamanti distinguono
//   "404 = davvero assente" da "502/429 = non ho potuto leggere" e possono fallire
//   chiuso invece di trattare un guasto come collezione vuota;
// - retry solo su errori transienti, con jitter e tetto massimo di attesa (un
//   Worker non può restare appeso 60s su un secondary rate limit).

import { Buffer } from 'node:buffer';
import { sleep } from './http';

const API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 300;
/** Oltre questa attesa non ha senso bloccare il Worker: meglio 503 subito. */
const MAX_BACKOFF_MS = 4_000;
/** Estratto del body GitHub tenuto per i log (mai rimandato al browser). */
const BODY_EXCERPT_LIMIT = 500;
/**
 * Tetto di chiamate GitHub per richiesta. Il limite Cloudflare free è 50 subrequest
 * per invocazione: si lascia margine per Cloudinary e per gli asset.
 */
export const DEFAULT_SUBREQUEST_BUDGET = 40;
/** Alias per query GraphQL: 100 file letti in una sola chiamata. */
const GRAPHQL_ALIAS_LIMIT = 100;

export type GitHubErrorCode =
	| 'not-found'
	| 'rate-limited'
	| 'unavailable'
	| 'conflict'
	| 'invalid'
	| 'unauthorized'
	| 'unknown';

/**
 * Errore GitHub tipizzato. `status === 0` = errore di rete/timeout (nessuna risposta).
 * `message` contiene l'estratto del body per i log del Worker; usa `safeMessage`
 * per quello che può vedere il browser.
 */
/**
 * Superato il budget di subrequest della richiesta.
 * Il piano free dei Workers consente 50 fetch esterne per invocazione: sfondarle
 * fa morire il Worker a metà transazione (commit parziale, JSON disallineato).
 * Meglio fermarsi prima con un errore che dice all'operatore cosa fare.
 */
export class SubrequestBudgetError extends Error {
	code = 'SUBREQUEST_BUDGET' as const;
	constructor(limit: number) {
		super(
			`Superato il budget di ${limit} chiamate GitHub per richiesta. ` +
			'Probabile snapshot JSON mancante: rigenera i JSON con `npm run build:data` e ricommitta.'
		);
		this.name = 'SubrequestBudgetError';
	}
}

export class GitHubApiError extends Error {
	readonly status: number;
	readonly code: GitHubErrorCode;
	readonly bodyExcerpt: string;
	readonly retryAfterMs: number | null;
	readonly requestId: string | null;

	constructor(
		status: number,
		bodyExcerpt = '',
		options: { retryAfterMs?: number | null; requestId?: string | null; cause?: unknown } = {}
	) {
		super(`GitHub API error: ${status} - ${bodyExcerpt}`);
		this.name = 'GitHubApiError';
		this.status = status;
		this.bodyExcerpt = bodyExcerpt;
		this.retryAfterMs = options.retryAfterMs ?? null;
		this.requestId = options.requestId ?? null;
		this.code = classify(status, bodyExcerpt);
		if (options.cause) this.cause = options.cause;
	}

	get isNotFound(): boolean {
		return this.code === 'not-found';
	}

	/** 422 "not a fast forward": il branch si è mosso, la transazione va rifatta. */
	get isNonFastForward(): boolean {
		if (this.status !== 422) return false;
		const lower = this.bodyExcerpt.toLowerCase();
		return (
			lower.includes('not a fast forward') ||
			lower.includes('fast-forward') ||
			lower.includes('does not point to') ||
			lower.includes('reference does not')
		);
	}

	get isTransient(): boolean {
		return this.code === 'unavailable' || this.code === 'rate-limited';
	}

	/** Messaggio esponibile al browser: nessun body GitHub, nessun path interno. */
	get safeMessage(): string {
		switch (this.code) {
			case 'not-found':
				return 'Risorsa non trovata su GitHub';
			case 'rate-limited':
				return 'Limite di richieste GitHub raggiunto. Riprova tra qualche minuto.';
			case 'unavailable':
				return 'GitHub non raggiungibile. Riprova tra qualche minuto.';
			case 'unauthorized':
				return 'Credenziali GitHub non valide o scadute';
			case 'conflict':
				return 'Conflitto sul repository: ricarica e riprova.';
			default:
				return 'Errore nella comunicazione con GitHub';
		}
	}
}

/** Lettura REST singola: `null` sul 404, errore su tutto il resto. */
async function readFileOr404(client: GithubClient, path: string): Promise<RepoFile | null> {
	try {
		return await client.readFile(path);
	} catch (error) {
		if (error instanceof GitHubApiError && error.isNotFound) return null;
		throw error;
	}
}

function classify(status: number, body: string): GitHubErrorCode {
	if (status === 0) return 'unavailable';
	if (status === 404) return 'not-found';
	if (status === 401) return 'unauthorized';
	if (status === 409) return 'conflict';
	if (status === 429) return 'rate-limited';
	if (status === 403 && /rate limit|secondary|abuse/i.test(body)) return 'rate-limited';
	if (status === 403) return 'unauthorized';
	if (status >= 500) return 'unavailable';
	if (status === 422 || status === 400) return 'invalid';
	return 'unknown';
}

/** Attesa suggerita da GitHub (Retry-After secondi, oppure x-ratelimit-reset epoch). */
function retryAfterFromHeaders(headers: Headers, now: number): number | null {
	const retryAfter = headers.get('retry-after');
	if (retryAfter) {
		const asNumber = Number(retryAfter);
		if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber * 1000;
	}
	const reset = headers.get('x-ratelimit-reset');
	const remaining = headers.get('x-ratelimit-remaining');
	if (reset && remaining === '0') {
		const resetMs = Number(reset) * 1000;
		if (Number.isFinite(resetMs)) return Math.max(0, resetMs - now);
	}
	return null;
}

/** Backoff esponenziale con jitter deterministico sul tentativo (niente Math.random). */
function backoffFor(attempt: number, suggested: number | null): number {
	if (suggested !== null) return Math.min(suggested, MAX_BACKOFF_MS);
	const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1);
	const jitter = (attempt * 137) % 200;
	return Math.min(exponential + jitter, MAX_BACKOFF_MS);
}

/** Encoda i segmenti ma preserva gli slash del path nel repo. */
export function encodeRepoPath(path: string): string {
	return String(path)
		.split('/')
		.filter(Boolean)
		.map(encodeURIComponent)
		.join('/');
}

export interface RepoTarget {
	owner: string;
	repo: string;
	branch: string;
}

export interface RepoFile {
	content: string;
	sha: string | null;
}

export interface BranchHead {
	commitSha: string;
	treeSha: string;
}

export class GithubClient {
	readonly owner: string;
	readonly repo: string;
	readonly branch: string;

	private readonly token: string;
	private readonly cache = new Map<string, any>();
	/** Ref usato da tutte le letture: nome branch finché non si pinna un commit. */
	private ref: string;
	private readonly maxRequests: number;
	private spent = 0;

	constructor(token: string, target: RepoTarget, options: { maxRequests?: number } = {}) {
		this.token = token;
		this.owner = target.owner;
		this.repo = target.repo;
		this.branch = target.branch;
		this.ref = target.branch;
		this.maxRequests = options.maxRequests ?? DEFAULT_SUBREQUEST_BUDGET;
	}

	/** Chiamate GitHub effettivamente spese (cache esclusa, retry inclusi). */
	get spentRequests(): number {
		return this.spent;
	}

	get currentRef(): string {
		return this.ref;
	}

	/**
	 * Pinna le letture a un commit preciso. Svuota la cache: i valori memorizzati
	 * appartengono al ref precedente e non sono più coerenti.
	 */
	pinRef(ref: string): void {
		if (!ref || ref === this.ref) return;
		this.ref = ref;
		this.cache.clear();
	}

	/**
	 * Legge HEAD del branch e ci pinna le letture successive.
	 * È l'UNICA GET su /branches per transazione: `createCommitTransaction`
	 * riusa il risultato invece di rileggerlo (risparmio di una chiamata a save).
	 */
	async syncBranchHead(): Promise<BranchHead> {
		const info = await this.request(
			'GET',
			`/repos/${this.owner}/${this.repo}/branches/${encodeURIComponent(this.branch)}`,
			null,
			{ noCache: true }
		);
		const head: BranchHead = {
			commitSha: info.commit.sha,
			treeSha: info.commit.commit.tree.sha
		};
		this.pinRef(head.commitSha);
		return head;
	}

	/** Path `contents/` sempre qualificato con il ref corrente (mai il branch implicito). */
	contentsPath(path: string, ref: string = this.ref): string {
		return `/repos/${this.owner}/${this.repo}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(ref)}`;
	}

	/** Contenuto + blob SHA di un file. Lancia GitHubApiError (404 incluso). */
	async readFile(path: string): Promise<RepoFile> {
		const data = await this.request('GET', this.contentsPath(path));
		if (typeof data?.content !== 'string') {
			throw new GitHubApiError(422, `contents/${path}: risposta senza campo content`);
		}
		return {
			// I contenuti GitHub arrivano base64 con a capo ogni 60 caratteri
			content: Buffer.from(String(data.content).replace(/\s/g, ''), 'base64').toString('utf-8'),
			sha: data.sha || null
		};
	}

	/** Elenco di una directory. Lancia GitHubApiError (404 = cartella assente). */
	async listDir(path: string): Promise<any[]> {
		const data = await this.request('GET', this.contentsPath(path));
		return Array.isArray(data) ? data : [];
	}

	/**
	 * Legge N file in UNA chiamata via GraphQL, al ref pinnato.
	 *
	 * È la differenza tra un riordino da 95 prodotti che funziona e uno che uccide
	 * il Worker: con la REST servirebbe una GET per file (96 subrequest, oltre il
	 * limite di 50), qui bastano `ceil(N/100)` chiamate. Restituisce `null` per i
	 * path assenti, così il chiamante decide se è legittimo o è un conflitto.
	 *
	 * Se GraphQL non è disponibile (token senza permessi, endpoint in errore) si
	 * ricade sulla REST file-per-file, protetta dal budget di subrequest.
	 */
	async readFilesBatch(paths: string[]): Promise<Map<string, RepoFile | null>> {
		const unique = [...new Set(paths)];
		const result = new Map<string, RepoFile | null>();
		if (unique.length === 0) return result;

		for (let i = 0; i < unique.length; i += GRAPHQL_ALIAS_LIMIT) {
			const chunk = unique.slice(i, i + GRAPHQL_ALIAS_LIMIT);
			let data: any;
			try {
				data = await this.graphqlBlobs(chunk);
			} catch (error) {
				console.warn(`[github] GraphQL non utilizzabile, fallback REST: ${(error as Error).message}`);
				for (const path of unique.slice(i)) {
					result.set(path, await readFileOr404(this, path));
				}
				return result;
			}

			chunk.forEach((path, index) => {
				const node = data?.repository?.[`f${index}`];
				result.set(
					path,
					node && typeof node.text === 'string'
						? { content: node.text, sha: node.oid || null }
						: null
				);
			});
		}

		return result;
	}

	/** Query GraphQL con un alias per file; `oid` è lo SHA del blob (serve all'OCC). */
	private async graphqlBlobs(paths: string[]): Promise<any> {
		const declarations = ['$owner: String!', '$name: String!'];
		const selections: string[] = [];
		const variables: Record<string, string> = { owner: this.owner, name: this.repo };

		paths.forEach((path, index) => {
			declarations.push(`$e${index}: String!`);
			variables[`e${index}`] = `${this.ref}:${path}`;
			selections.push(`f${index}: object(expression: $e${index}) { ... on Blob { text oid } }`);
		});

		const query =
			`query(${declarations.join(', ')}) { repository(owner: $owner, name: $name) { ${selections.join(' ')} } }`;

		const response = await this.request('POST', '/graphql', { query, variables }, {
			// Una lettura non deve invalidare la cache delle altre letture
			keepCache: true
		});

		if (response?.errors?.length) {
			throw new GitHubApiError(422, JSON.stringify(response.errors).slice(0, BODY_EXCERPT_LIMIT));
		}
		return response?.data;
	}

	async request(
		method: string,
		path: string,
		body: unknown = null,
		options: { noCache?: boolean; keepCache?: boolean } = {}
	): Promise<any> {
		const cacheKey = method === 'GET' && !body && !options.noCache ? path : null;
		if (cacheKey && this.cache.has(cacheKey)) {
			return this.cache.get(cacheKey);
		}

		const url = `https://api.github.com${path}`;
		const serializedBody = body ? JSON.stringify(body) : undefined;

		let lastError: GitHubApiError | undefined;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			if (this.spent >= this.maxRequests) {
				throw new SubrequestBudgetError(this.maxRequests);
			}
			this.spent++;
			console.log(`GitHub ${method} ${path}${attempt > 1 ? ` (retry ${attempt}/${MAX_ATTEMPTS})` : ''}`);

			let response: Response;
			let data: string;
			try {
				response = await fetch(url, {
					method,
					headers: {
						'Authorization': `Bearer ${this.token}`,
						'User-Agent': 'Arconti31-CMS',
						'Content-Type': 'application/json',
						'Accept': 'application/vnd.github+json',
						'X-GitHub-Api-Version': API_VERSION
					},
					body: serializedBody,
					// Signal ricreato a ogni tentativo: riusarlo farebbe abortire
					// immediatamente i retry dopo il primo timeout.
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
				});
				data = await response.text();
			} catch (networkErr) {
				lastError = new GitHubApiError(0, (networkErr as Error).message || 'network error', {
					cause: networkErr
				});
				if (attempt < MAX_ATTEMPTS) {
					const delay = backoffFor(attempt, null);
					console.warn(`[github] errore di rete, backoff ${delay}ms: ${lastError.bodyExcerpt}`);
					await sleep(delay);
					continue;
				}
				throw lastError;
			}

			if (response.ok) {
				const parsed = data ? JSON.parse(data) : {};
				if (cacheKey) this.cache.set(cacheKey, parsed);
				// Ogni write invalida la cache (ref/tree/contents cambiati).
				// keepCache: la POST è una lettura mascherata (GraphQL), non muta nulla.
				if (method !== 'GET' && !options.keepCache) this.cache.clear();
				return parsed;
			}

			const now = Date.now();
			const error = new GitHubApiError(response.status, data.slice(0, BODY_EXCERPT_LIMIT), {
				retryAfterMs: retryAfterFromHeaders(response.headers, now),
				requestId: response.headers.get('x-github-request-id')
			});
			lastError = error;

			const delay = backoffFor(attempt, error.retryAfterMs);
			// Non ritentare 4xx non transienti, né attese oltre il tetto: fallire
			// subito è più economico e non aggrava i secondary rate limit.
			const worthRetrying =
				error.isTransient &&
				attempt < MAX_ATTEMPTS &&
				(error.retryAfterMs === null || error.retryAfterMs <= MAX_BACKOFF_MS);

			if (!worthRetrying) throw error;

			console.warn(`[github] status ${response.status} (${error.code}), backoff ${delay}ms`);
			await sleep(delay);
		}

		throw lastError || new GitHubApiError(0, 'retry esauriti');
	}
}
