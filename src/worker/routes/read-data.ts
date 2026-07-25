// /api/read-data — port di netlify/functions/read-data.js
// mode !== 'api': SOLO JSON statici via raw.githubusercontent (mai PAT senza auth utente),
// 503 su json-miss (mai 200+[] che farebbe wipe della cache client).
// mode === 'api': richiede token valido, usa API GitHub con PAT server.

import { Buffer } from 'node:buffer';
import {
	findBeverageCategoryByFolder,
	getCategoryFolder,
	normalizeSlug,
	parseFrontmatter,
	stringifyFrontmatter
} from '../../../lib/menu-utils.js';
import type { Env, ItemRecord } from '../types';
import { verifyToken } from '../lib/auth';
import { resolveRepoConfig } from '../lib/repo-config';
import { RepoConfigError } from '../types';
import { GithubClient } from '../lib/github';
import { corsHeaders } from '../lib/cors';
import { json, parseJsonBody, text } from '../lib/http';

function isValidPathSegment(value: unknown): boolean {
	if (!value || typeof value !== 'string') return false;
	return !(value.includes('..') || value.includes('/') || value.includes('\\'));
}

export async function handleReadData(request: Request, env: Env): Promise<Response> {
	const headers = corsHeaders(request, env);

	if (request.method === 'OPTIONS') {
		return text(200, '', headers);
	}
	if (request.method !== 'POST') {
		return text(405, 'Method Not Allowed', headers);
	}

	const parsedBody = await parseJsonBody(request);
	if (!parsedBody) {
		console.error('Invalid JSON body');
		return json(400, { error: 'JSON non valido' }, headers);
	}

	const { folder, mode, token, filename, filenames, lookupName } = parsedBody;

	if (!folder) {
		return json(400, { error: 'Folder required' }, headers);
	}

	// Validazione path traversal (come save-data)
	if (!isValidPathSegment(folder)) {
		return json(400, { error: 'Folder non valido', items: [] }, headers);
	}
	if (filename && !isValidPathSegment(filename)) {
		return json(400, { error: 'Filename non valido', items: [] }, headers);
	}
	if (Array.isArray(filenames)) {
		for (const f of filenames) {
			if (f && !isValidPathSegment(f)) {
				return json(400, { error: 'Filename non valido', items: [] }, headers);
			}
		}
	}

	// Config repo fail-loud — niente default hardcoded
	let REPO_OWNER: string;
	let REPO_NAME: string;
	let REPO_BRANCH: string;
	try {
		const cfg = resolveRepoConfig(env);
		REPO_OWNER = cfg.owner;
		REPO_NAME = cfg.repo;
		REPO_BRANCH = cfg.branch;
	} catch (error) {
		if (error instanceof RepoConfigError) {
			return json(500, { error: error.message, code: 'REPO_CONFIG_MISSING', items: [] }, headers);
		}
		throw error;
	}

	// mode=api espone SHA → richiede autenticazione utente
	if (mode === 'api') {
		const userEmail = verifyToken(env, token);
		if (!userEmail) {
			return json(401, { error: 'Autenticazione richiesta per la modalità API', items: [] }, headers);
		}
	}

	console.log(`[read-data] Folder: ${folder}, Mode: ${mode || 'auto'}, branch: ${REPO_BRANCH}`);

	// mode !== 'api': solo JSON statici (raw.githubusercontent) — MAI PAT server senza auth utente
	if (mode !== 'api') {
		const jsonResult = await tryReadFromJSON(folder, REPO_OWNER, REPO_NAME, REPO_BRANCH);
		if (jsonResult) {
			console.log(`[read-data] ✅ Dati caricati da JSON statico per ${folder} (${jsonResult.length} items)`);
			return json(200, { items: jsonResult, source: 'json' }, headers);
		}

		// 503 (non 200+[]) così i client non trattano "lista vuota legittima" e non wipe-ano la cache
		console.log(`[read-data] JSON non disponibile per ${folder} — non uso GITHUB_TOKEN senza auth`);
		return json(503, {
			items: [],
			source: 'json-miss',
			error: 'Dati non disponibili da JSON statico'
		}, headers);
	}

	// mode === 'api': usa API GitHub con PAT server (utente già autenticato)
	const GITHUB_TOKEN = env.GITHUB_TOKEN;
	console.log(`[read-data] Usando API GitHub per ${folder}`);

	if (!GITHUB_TOKEN) {
		console.error('[read-data] GITHUB_TOKEN non configurato!');
		return json(500, { error: 'GITHUB_TOKEN non configurato', items: [] }, headers);
	}

	const gh = new GithubClient(GITHUB_TOKEN);

	try {
		if (Array.isArray(filenames) && filenames.length > 0) {
			const items = await readItemsMetadataFromAPI({
				folder,
				filenames,
				gh,
				owner: REPO_OWNER,
				repo: REPO_NAME
			});
			return json(200, { items, source: 'api-listing' }, headers);
		}

		if (filename) {
			const item = await readSingleItemFromAPI({
				folder,
				filename,
				lookupName,
				gh,
				owner: REPO_OWNER,
				repo: REPO_NAME,
				branch: REPO_BRANCH
			});
			return json(200, { items: item ? [item] : [], source: 'api-single' }, headers);
		}

		const files = await gh.request('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${folder}`);

		if (!Array.isArray(files)) {
			return json(200, { items: [], source: 'api' }, headers);
		}

		const mdFiles = files.filter((f: any) => f.name.endsWith('.md') && f.name !== '.gitkeep');

		// Bounded concurrency (max 8) to avoid GitHub secondary rate limits (M4)
		const CONCURRENCY = 8;
		const items: (ItemRecord | null)[] = [];
		for (let i = 0; i < mdFiles.length; i += CONCURRENCY) {
			const batch = mdFiles.slice(i, i + CONCURRENCY);
			const batchResults = await Promise.all(batch.map(async (file: any) => {
				try {
					const fileData = await gh.request(
						'GET',
						`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${folder}/${file.name}`
					);
					const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
					const parsedItem = parseFrontmatter(content);
					return { content, filename: file.name, sha: fileData.sha, parsedItem };
				} catch (e) {
					console.error(`Error loading ${file.name}:`, e);
					return null;
				}
			}));
			items.push(...batchResults);
		}

		return json(200, { items: items.filter(i => i !== null), source: 'api' }, headers);
	} catch (error) {
		const message = (error as Error).message || '';
		console.error('[read-data] Error:', message);

		if (message.includes('403') || message.includes('rate limit')) {
			// Fallback JSON (pubblico, no PAT) anche in mode=api se rate limit
			const jsonFallback = await tryReadFromJSON(folder, REPO_OWNER, REPO_NAME, REPO_BRANCH);
			if (jsonFallback) {
				console.log(`[read-data] ✅ Fallback a JSON per rate limit`);
				return json(200, { items: jsonFallback, source: 'json-fallback' }, headers);
			}
			return json(429, { error: 'Rate limit GitHub raggiunto. Attendi qualche minuto.', items: [] }, headers);
		}

		// 404 = folder doesn't exist yet
		if (message.includes('404')) {
			console.log(`[read-data] Folder "${folder}" not found — returning empty items (new category?)`);
			return json(200, { items: [], source: 'empty-folder' }, headers);
		}

		return json(500, { error: message, items: [] }, headers);
	}
}

async function readItemsMetadataFromAPI({ folder, filenames, gh, owner, repo }: {
	folder: string;
	filenames: string[];
	gh: GithubClient;
	owner: string;
	repo: string;
}): Promise<ItemRecord[]> {
	const wanted = new Set((filenames || []).filter(Boolean));
	if (wanted.size === 0) return [];

	const files = await gh.request('GET', `/repos/${owner}/${repo}/contents/${folder}`);

	if (!Array.isArray(files)) return [];

	return files
		.filter((file: any) => file.name.endsWith('.md') && file.name !== '.gitkeep' && wanted.has(file.name))
		.map((file: any) => ({ filename: file.name, sha: file.sha }));
}

async function readMarkdownItemFromAPI({ folder, filename, gh, owner, repo }: {
	folder: string;
	filename: string;
	gh: GithubClient;
	owner: string;
	repo: string;
}): Promise<ItemRecord> {
	const fileData = await gh.request('GET', `/repos/${owner}/${repo}/contents/${folder}/${filename}`);
	const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
	const parsedItem = parseFrontmatter(content);
	return { content, filename, sha: fileData.sha, parsedItem };
}

function normalizeName(value: unknown): string {
	return String(value || '').trim().toLowerCase();
}

async function readSingleItemFromAPI({ folder, filename, lookupName, gh, owner, repo, branch = 'main' }: {
	folder: string;
	filename: string;
	lookupName?: string;
	gh: GithubClient;
	owner: string;
	repo: string;
	branch?: string;
}): Promise<ItemRecord | null> {
	try {
		return await readMarkdownItemFromAPI({ folder, filename, gh, owner, repo });
	} catch (error) {
		if (!(error as Error).message.includes('404')) {
			throw error;
		}
	}

	if (!lookupName) {
		return null;
	}

	// Lookup per nome via JSON pubblico (no PAT extra)
	const jsonItems = await tryReadFromJSON(folder, owner, repo, branch);
	if (!jsonItems || jsonItems.length === 0) {
		return null;
	}

	const targetName = normalizeName(lookupName);
	const candidate = jsonItems.find(item => normalizeName(item.parsedItem?.nome) === targetName);
	if (!candidate?.filename || candidate.filename === filename) {
		return null;
	}

	try {
		return await readMarkdownItemFromAPI({ folder, filename: candidate.filename, gh, owner, repo });
	} catch (error) {
		if ((error as Error).message.includes('404')) return null;
		throw error;
	}
}

// ========================================
// LETTURA DA JSON STATICI
// ========================================

interface JsonMapEntry {
	file: string;
	field: string;
	filter?: string;
}

export async function tryReadFromJSON(
	folder: string,
	owner: string,
	repo: string,
	branch = 'main'
): Promise<ItemRecord[] | null> {
	// Mapping folder -> JSON file e campo dati
	const JSON_MAP: Record<string, JsonMapEntry> = {
		'food': { file: 'food/food.json', field: 'food' },
		'beers': { file: 'beers/beers.json', field: 'beers' },
		'categorie': { file: 'categorie/categorie.json', field: 'categories' },
		'cocktails': { file: 'beverages/beverages.json', field: 'beverages', filter: 'Cocktails' },
		'analcolici': { file: 'beverages/beverages.json', field: 'beverages', filter: 'Analcolici' },
		'bibite': { file: 'beverages/beverages.json', field: 'beverages', filter: 'Bibite' },
		'caffetteria': { file: 'beverages/beverages.json', field: 'beverages', filter: 'Caffetteria' },
		'bollicine': { file: 'beverages/beverages.json', field: 'beverages', filter: 'Bollicine' },
		'bianchi-fermi': { file: 'beverages/beverages.json', field: 'beverages', filter: 'Bianchi fermi' },
		'vini-rossi': { file: 'beverages/beverages.json', field: 'beverages', filter: 'Vini rossi' }
	};

	let config: JsonMapEntry | undefined = JSON_MAP[folder];
	const safeBranch = encodeURIComponent(branch || 'main');

	// If folder is not in static map, check categorie.json for dynamic beverage folders
	if (!config) {
		try {
			const catUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${safeBranch}/categorie/categorie.json`;
			const catRes = await fetch(catUrl);
			if (catRes.ok) {
				const catData: any = await catRes.json();
				const match = findBeverageCategoryByFolder(catData.categories || [], folder);
				if (match) {
					config = { file: 'beverages/beverages.json', field: 'beverages', filter: match.nome };
					console.log(`[tryReadFromJSON] Dynamic beverage mapping: ${normalizeSlug(folder)} → filter "${match.nome}" (folder ${getCategoryFolder(match)})`);
				}
			}
		} catch (e) {
			console.log(`[tryReadFromJSON] Error checking dynamic beverage: ${(e as Error).message}`);
		}
	}

	if (!config) {
		console.log(`[tryReadFromJSON] Nessun mapping per ${folder}`);
		return null;
	}

	try {
		// Legge il JSON dal repository raw di GitHub (non conta verso rate limit API!)
		const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${safeBranch}/${config.file}`;
		console.log(`[tryReadFromJSON] Fetching ${rawUrl}`);

		const response = await fetch(rawUrl);
		if (!response.ok) {
			console.log(`[tryReadFromJSON] File non trovato: ${response.status}`);
			return null;
		}

		const jsonData: any = await response.json();
		let items: ItemRecord[] = jsonData[config.field] || [];

		// Filtra per tipo se necessario (per beverages)
		if (config.filter) {
			items = items.filter(item => item.tipo === config.filter);
		}

		// IMPORTANTE: Restituisce i dati in un formato che il CMS può usare direttamente
		return items.map(item => {
			const itemFilename = item._filename || ((item.slug || slugify(item.nome)) + '.md');
			const content = stringifyFrontmatter(item);

			return {
				content,
				filename: itemFilename,
				sha: null,
				fromJSON: true,
				parsedItem: item
			};
		});
	} catch (e) {
		console.error(`[tryReadFromJSON] Errore:`, (e as Error).message);
		return null;
	}
}

function slugify(text: unknown): string {
	if (!text) return 'item-' + Date.now();
	return String(text).toLowerCase().trim()
		.replace(/\s+/g, '-')
		.replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e')
		.replace(/[ìíîï]/g, 'i').replace(/[òóôõö]/g, 'o').replace(/[ùúûü]/g, 'u')
		.replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').substring(0, 50);
}
