// Client GitHub API con cache GET per-richiesta (istanza creata a ogni request:
// niente stato globale mutabile tra richieste, a differenza del vecchio
// `requestGetCache` globale delle Netlify Functions).
// Retry su 429/502/503/403-rate-limit e network error, con Retry-After.

import { sleep } from './http';

export class GithubClient {
	private readonly token: string;
	private readonly cache = new Map<string, any>();

	constructor(token: string) {
		this.token = token;
	}

	async request(method: string, path: string, body: unknown = null): Promise<any> {
		const cacheKey = method === 'GET' && !body ? path : null;
		if (cacheKey && this.cache.has(cacheKey)) {
			return this.cache.get(cacheKey);
		}

		const url = `https://api.github.com${path}`;

		const options: RequestInit = {
			method,
			headers: {
				'Authorization': `token ${this.token}`,
				'User-Agent': 'Arconti31-CMS',
				'Content-Type': 'application/json',
				'Accept': 'application/vnd.github.v3+json'
			}
		};

		if (body) {
			options.body = JSON.stringify(body);
		}

		// Retry (max 3 tentativi, backoff 300ms * attempt)
		let lastError: Error | undefined;
		for (let attempt = 1; attempt <= 3; attempt++) {
			console.log(`GitHub ${method} ${path}${attempt > 1 ? ` (retry ${attempt}/3)` : ''}`);

			let response: Response;
			let data: string;
			try {
				response = await fetch(url, options);
				data = await response.text();
			} catch (networkErr) {
				lastError = networkErr as Error;
				if (attempt < 3) {
					const delay = 300 * attempt;
					console.warn(`[githubRequest] network error, backoff ${delay}ms: ${(networkErr as Error).message}`);
					await sleep(delay);
					continue;
				}
				throw networkErr;
			}

			if (response.ok) {
				const parsed = data ? JSON.parse(data) : {};
				if (cacheKey) {
					this.cache.set(cacheKey, parsed);
				}
				// Qualsiasi write invalida la cache (ref/tree/contents cambiati)
				if (method !== 'GET') {
					this.cache.clear();
				}
				return parsed;
			}

			// 403 con body rate-limit è un secondary rate limit (retriabile)
			const is403RateLimit = response.status === 403 && /rate limit|secondary|abuse/i.test(data);
			const retriable =
				response.status === 429 || response.status === 502 || response.status === 503 || is403RateLimit;
			if (retriable && attempt < 3) {
				let delay = 300 * attempt;
				const retryAfter = response.headers.get('retry-after');
				if (retryAfter) {
					const asNum = Number(retryAfter);
					if (Number.isFinite(asNum) && asNum >= 0) {
						// Retry-After può essere secondi
						delay = asNum < 1000 ? asNum * 1000 : asNum;
					}
				}
				console.warn(`[githubRequest] status ${response.status}, backoff ${delay}ms`);
				await sleep(delay);
				lastError = new Error(`GitHub API error: ${response.status} - ${data}`);
				continue;
			}

			throw new Error(`GitHub API error: ${response.status} - ${data}`);
		}

		throw lastError || new Error('GitHub API error: retry esauriti');
	}
}
