// Logica di dominio CMS.
//
// Invarianti rispetto al port originale delle Netlify Functions:
// - commit atomici via Git Trees API, OCC su SHA blob, guardie sulle categorie,
//   stessi generatori di JSON aggregato.
//
// Differenze deliberate (correzioni di integrità):
// 1. `createCommitTransaction` ricostruisce le tree entry a OGNI tentativo.
//    Prima il retry non-fast-forward riusava le entry calcolate sullo snapshot
//    iniziale: il .md concorrente sopravviveva (base_tree), ma il JSON aggregato
//    riscritto lo perdeva → prodotto sparito dal menù pubblico con i .md intatti.
// 2. Le letture sono FAIL-CLOSED: 404 = assente davvero, qualsiasi altro errore
//    aborta la transazione. Prima un 502 GitHub diventava "collezione vuota" e
//    poteva svuotare un JSON aggregato o aggirare le guardie di dipendenza.
// 3. Tutte le letture passano dal ref pinnato del client (commit SHA), quindi una
//    transazione vede un solo commit immutabile e rispetta sempre GITHUB_BRANCH.

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
	BASE_BEVERAGE_CATEGORIES,
	findBeverageCategoryByFolder,
	getCategoryFolder,
	getFilenameBase,
	normalizeSlug,
	parseFrontmatter,
	stringifyFrontmatter
} from '../../../lib/menu-utils.js';
import { compareMenuItems } from '../../../js/menu-order.js';
import {
	type BranchHead,
	GitHubApiError,
	GithubClient,
	SubrequestBudgetError,
	type RepoFile
} from './github';
import { sleep } from './http';
import { ValidationError } from './validate';
import type { ItemRecord } from '../types';

/** Tentativi di commit prima di arrendersi su un branch molto conteso. */
const MAX_COMMIT_ATTEMPTS = 3;

export interface TreeEntry {
	path: string;
	mode: '100644';
	type: 'blob';
	content?: string;
	sha?: null;
}

export interface CollectionConfig {
	jsonPath: string;
	type: 'food' | 'beers' | 'categories' | 'beverages';
	folder?: string;
	name?: string;
}

/** Campi che non devono mai finire nei file markdown (derivati JSON / meta CMS) */
export const MARKDOWN_STRIP_KEYS = new Set([
	'_filename', '_collection', '_hash', '_lastUpdated', '_writeTime', '_deleted',
	'filename', 'sha', 'id', 'fromJSON', 'parsedItem', 'content',
	'tipo' // derivato in beverages.json, non nel frontmatter sorgente
]);

/** Conflitto OCC: il contenuto è cambiato sotto di noi. */
export class ConflictError extends Error {
	code = 'CONFLICT' as const;
	constructor(message = 'Conflitto: il contenuto è stato modificato. Ricarica e riprova.') {
		super(message);
		this.name = 'ConflictError';
	}
}

/** Errore di dominio → 400 (payload/dati non validi, guardie categorie). */
export class DomainError extends Error {
	code = 'DOMAIN_ERROR' as const;
}

/** Risorsa assente → 404. */
export class NotFoundError extends Error {
	code = 'NOT_FOUND' as const;
}

// ========================================
// GENERAZIONE MARKDOWN
// ========================================

/**
 * Scrive SOLO frontmatter prodotto. Strippa meta CMS e campi derivati JSON
 * (es. `tipo`) per non inquinare i .md al reorder/save.
 * NON altera prezzi/nomi: passa i campi di dominio così come sono.
 */
export function generateMarkdown(data: ItemRecord): string {
	const clean: ItemRecord = {};
	Object.keys(data || {}).forEach(key => {
		if (MARKDOWN_STRIP_KEYS.has(key)) return;
		if (key.startsWith('_')) return;
		clean[key] = data[key];
	});
	return stringifyFrontmatter(clean);
}

export function calculateGitBlobSha(content: string): string {
	return createHash('sha1')
		.update(`blob ${Buffer.byteLength(content, 'utf8')}\0${content}`, 'utf8')
		.digest('hex');
}

/**
 * Status HTTP per il client. Gli errori GitHub NON vengono più mappati a 500
 * generico: un guasto upstream è 502/503/429, non un bug del CMS.
 */
export function getErrorStatusCode(error: unknown): number {
	if (error instanceof ConflictError) return 409;
	if (error instanceof NotFoundError) return 404;
	if (error instanceof DomainError || error instanceof ValidationError) return 400;
	if (error instanceof SubrequestBudgetError) return 503;

	if (error instanceof GitHubApiError) {
		switch (error.code) {
			case 'rate-limited': return 429;
			case 'unavailable': return 503;
			case 'not-found': return 404;
			case 'conflict': return 409;
			case 'unauthorized': return 502; // PAT del server, non colpa dell'utente
			default: return 502;
		}
	}

	return 500;
}

/**
 * Messaggio esponibile al browser. I body GitHub (che possono contenere path,
 * nomi di repo privati e dettagli del token) restano nei log del Worker.
 */
export function getSafeErrorMessage(error: unknown): string {
	if (error instanceof GitHubApiError) return error.safeMessage;
	if (
		error instanceof ConflictError ||
		error instanceof NotFoundError ||
		error instanceof DomainError ||
		error instanceof ValidationError ||
		error instanceof SubrequestBudgetError
	) {
		return error.message;
	}
	return 'Errore interno';
}

// ========================================
// LETTURE REPO (fail-closed)
// ========================================

/** Legge un file al ref pinnato. Lancia su assenza e su guasto upstream. */
export async function readRepoFile(gh: GithubClient, repoPath: string): Promise<RepoFile> {
	return gh.readFile(repoPath);
}

export async function readRepoFileContent(gh: GithubClient, repoPath: string): Promise<string> {
	return (await gh.readFile(repoPath)).content;
}

/**
 * Legge un file trattando SOLO il 404 come "assente" (→ null).
 * Ogni altro errore risale: un 502 non è un file mancante.
 */
export async function readRepoFileOptional(gh: GithubClient, repoPath: string): Promise<RepoFile | null> {
	try {
		return await gh.readFile(repoPath);
	} catch (error) {
		if (error instanceof GitHubApiError && error.isNotFound) return null;
		throw error;
	}
}

async function readJsonFileOptional(gh: GithubClient, repoPath: string): Promise<any | null> {
	const file = await readRepoFileOptional(gh, repoPath);
	if (!file) return null;
	try {
		return JSON.parse(file.content);
	} catch {
		// JSON committato corrotto: non è un "file assente", va segnalato
		throw new DomainError(`JSON non parsabile: ${repoPath}`);
	}
}

/**
 * Verifica OCC: il blob al ref corrente deve avere lo SHA che il client ha letto.
 * FAIL-CLOSED: se la verifica non si può fare (rate limit, 502) l'errore risale e
 * il commit non parte. Prima veniva loggata e ignorata, spegnendo la protezione
 * anti-concorrenza proprio sotto stress GitHub.
 */
export async function assertBlobUnchanged(
	gh: GithubClient,
	repoPath: string,
	expectedSha: string
): Promise<void> {
	let current: RepoFile | null;
	try {
		current = await readRepoFileOptional(gh, repoPath);
	} catch (error) {
		if (error instanceof GitHubApiError) {
			console.error(`[OCC] verifica impossibile su ${repoPath}: ${error.message}`);
		}
		throw error;
	}
	// File sparito: qualcun altro l'ha eliminato → conflitto, non "ok procedi"
	if (!current) throw new ConflictError();
	if (current.sha && current.sha !== expectedSha) throw new ConflictError();
}

// ========================================
// CATEGORIE — helper di riferimento
// ========================================

export function findCategoryByReference(
	categories: ItemRecord[] = [],
	value: unknown,
	typeMenu: string | null = null
): ItemRecord | null {
	const normalizedValue = normalizeSlug(value);
	if (!normalizedValue) return null;

	return categories.find(category =>
		(!typeMenu || category.tipo_menu === typeMenu) &&
		getCategoryReferenceAliases(category).includes(normalizedValue)
	) || null;
}

export function getCategoryReferenceAliases(category: ItemRecord = {}): string[] {
	const aliases = new Set<string>();
	[category.nome, category.slug, category.folder, getFilenameBase(category._filename)].forEach(value => {
		const normalizedValue = normalizeSlug(value);
		if (normalizedValue) aliases.add(normalizedValue);
	});
	return [...aliases];
}

function matchesCategoryReference(value: unknown, aliases: string[] = []): boolean {
	const normalizedValue = normalizeSlug(value);
	return normalizedValue ? aliases.includes(normalizedValue) : false;
}

function hasCategoryStructuralChange(previousCategory: ItemRecord = {}, nextCategory: ItemRecord = {}): boolean {
	return (
		normalizeSlug(previousCategory.nome) !== normalizeSlug(nextCategory.nome) ||
		normalizeSlug(previousCategory.slug) !== normalizeSlug(nextCategory.slug) ||
		normalizeSlug(previousCategory.parent_category) !== normalizeSlug(nextCategory.parent_category) ||
		String(previousCategory.tipo_menu || '') !== String(nextCategory.tipo_menu || '')
	);
}

function buildCategoryDependencyError(
	actionLabel: string,
	category: ItemRecord,
	dependents: { childCategories: ItemRecord[]; foodItems: ItemRecord[]; beerItems: ItemRecord[]; beverageItems: ItemRecord[] }
): string | null {
	const parts: string[] = [];
	if (dependents.childCategories.length > 0) parts.push(`${dependents.childCategories.length} sottocategorie`);
	if (dependents.foodItems.length > 0) parts.push(`${dependents.foodItems.length} prodotti food`);
	if (dependents.beerItems.length > 0) parts.push(`${dependents.beerItems.length} birre collegate`);
	if (dependents.beverageItems.length > 0) parts.push(`${dependents.beverageItems.length} bevande collegate`);

	if (parts.length === 0) return null;

	return `Impossibile ${actionLabel} la categoria "${category.nome}": contiene o collega ancora ${parts.join(', ')}. Sposta prima i contenuti collegati.`;
}

export async function loadCategoriesSnapshot(gh: GithubClient): Promise<ItemRecord[]> {
	return (await readCollectionSnapshot(gh, 'categorie')) || readCollectionFiles(gh, 'categorie');
}

// ========================================
// NORMALIZZAZIONE PAYLOAD
// ========================================

export async function prepareDataForSave(
	gh: GithubClient,
	collection: string,
	rawData: ItemRecord = {},
	options: { filename?: string; sha?: string | null } = {}
): Promise<ItemRecord> {
	if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
		throw new DomainError('Payload non valido');
	}

	// Merge con .md esistente su UPDATE: preserva campi non presenti nel form
	// (es. legacy, note future) senza cancellarli. I campi del form vincono.
	// Un 404 qui è legittimo (file appena rinominato); un 502 no → risale.
	let existing: ItemRecord = {};
	if (options.sha && options.filename) {
		const file = await readRepoFileOptional(gh, `${collection}/${options.filename}`);
		if (file) existing = parseFrontmatter(file.content) || {};
	}

	const overlay: ItemRecord = { ...rawData };
	// Non far propagare meta CMS nel merge
	MARKDOWN_STRIP_KEYS.forEach(k => { delete overlay[k]; delete existing[k]; });
	Object.keys(overlay).forEach(k => { if (k.startsWith('_')) delete overlay[k]; });
	Object.keys(existing).forEach(k => { if (k.startsWith('_')) delete existing[k]; });

	const normalized: ItemRecord = { ...existing, ...overlay };

	if (collection === 'categorie') {
		normalized.slug = normalizeSlug(normalized.slug || normalized.nome || '');
		if (!normalized.slug) {
			throw new DomainError('Slug categoria non valido');
		}

		const parentCategory = normalizeSlug(normalized.parent_category || '');
		if (parentCategory) {
			normalized.parent_category = parentCategory;
		} else {
			delete normalized.parent_category;
		}
	}

	if (normalized.prezzo !== undefined) {
		const priceValue = String(normalized.prezzo).replace(',', '.').trim();
		const parsedPrice = Number(priceValue);
		if (!Number.isFinite(parsedPrice)) {
			throw new DomainError('Prezzo non valido');
		}
		normalized.prezzo = parsedPrice.toFixed(2);
	}

	if (normalized.order !== undefined) {
		normalized.order = Number.parseInt(normalized.order, 10) || 0;
	}

	if (collection === 'food' || collection === 'beers' || !['categorie', 'food', 'beers'].includes(collection)) {
		const categories = await loadCategoriesSnapshot(gh);

		if (collection === 'food') {
			const match = findCategoryByReference(categories, normalized.category, 'food');
			if (!match) {
				throw new DomainError('Categoria food non valida');
			}
			normalized.category = match.nome;
			normalized.category_slug = normalizeSlug(match.slug || match.nome);
		} else if (collection === 'beers') {
			const match = findCategoryByReference(categories, normalized.sezione, 'beverage');
			if (!match) {
				throw new DomainError('Sezione birra non valida');
			}
			normalized.sezione = match.nome;
			normalized.sezione_slug = normalizeSlug(match.slug || match.nome);
		} else {
			const match = findBeverageCategoryByFolder(categories, collection);
			if (match) {
				normalized.tipo_slug = normalizeSlug(match.slug || match.nome);
			}
		}
	}

	const parsed = parseFrontmatter(generateMarkdown(normalized));
	validateRequiredFields(collection, parsed || {});
	return parsed || {};
}

export function validateRequiredFields(collection: string, data: ItemRecord): void {
	const requiredFields = ['nome'];

	if (collection === 'food') {
		requiredFields.push('category', 'prezzo');
	} else if (collection === 'beers') {
		requiredFields.push('sezione', 'prezzo');
	} else if (collection === 'categorie') {
		requiredFields.push('slug', 'tipo_menu');
	} else {
		requiredFields.push('prezzo');
	}

	const missing = requiredFields.filter(field => {
		const value = data[field];
		return value === undefined || value === null || String(value).trim() === '';
	});

	if (missing.length > 0) {
		throw new DomainError(`Campi obbligatori mancanti: ${missing.join(', ')}`);
	}

	if (collection === 'categorie') {
		if (!['food', 'beverage'].includes(data.tipo_menu)) {
			throw new DomainError('tipo_menu categoria non valido');
		}
		if (data.parent_category && normalizeSlug(data.parent_category) === normalizeSlug(data.slug)) {
			throw new DomainError('Una categoria non puo avere se stessa come padre');
		}
	}
}

// ========================================
// GUARDIE CATEGORIE
// ========================================

function cloneCollectionItems(items: ItemRecord[] = []): ItemRecord[] {
	return items.map(item => ({ ...item }));
}

async function readCategoryByFilename(gh: GithubClient, filename: string): Promise<ItemRecord | null> {
	const file = await readRepoFileOptional(gh, `categorie/${filename}`);
	if (!file) return null;
	const parsed = parseFrontmatter(file.content);
	if (!parsed) return null;
	parsed._filename = filename;
	return parsed;
}

async function loadCategoryDependents(
	gh: GithubClient,
	category: ItemRecord,
	overrides: Record<string, ItemRecord[]> = {}
) {
	const aliases = getCategoryReferenceAliases(category);
	const categories = (await readCollectionSnapshot(gh, 'categorie', overrides))
		|| await readCollectionFiles(gh, 'categorie', overrides);
	const childCategories = categories.filter(item =>
		item._filename !== category._filename &&
		matchesCategoryReference(item.parent_category, aliases)
	);

	const foodItems = category.tipo_menu === 'food'
		? ((await readCollectionSnapshot(gh, 'food', overrides))
			|| await readCollectionFiles(gh, 'food', overrides))
			.filter(item => matchesCategoryReference(item.category, aliases))
		: [];

	const beerItems = category.tipo_menu === 'beverage'
		? ((await readCollectionSnapshot(gh, 'beers', overrides))
			|| await readCollectionFiles(gh, 'beers', overrides))
			.filter(item => matchesCategoryReference(item.sezione, aliases))
		: [];

	const beverageItems = category.tipo_menu === 'beverage'
		? ((await readCollectionSnapshot(gh, getCategoryFolder(category), overrides))
			|| await readCollectionFiles(gh, getCategoryFolder(category), overrides))
		: [];

	return { childCategories, foodItems, beerItems, beverageItems };
}

export async function assertSafeCategorySave(
	gh: GithubClient,
	collection: string,
	filename: string,
	nextData: ItemRecord,
	sha: string | null | undefined
): Promise<void> {
	if (collection !== 'categorie') return;

	const categories = (await readCollectionSnapshot(gh, 'categorie'))
		|| await readCollectionFiles(gh, 'categorie');
	const normalizedNextSlug = normalizeSlug(nextData.slug);
	const nextCategoryCandidate = { ...nextData, _filename: filename };
	const nextFolder = nextData.tipo_menu === 'beverage' ? getCategoryFolder(nextCategoryCandidate) : null;

	const duplicateSlug = categories.find(category =>
		category._filename !== filename &&
		normalizeSlug(category.slug || category.nome) === normalizedNextSlug
	);
	if (duplicateSlug) {
		throw new ConflictError(`Esiste gia una categoria con slug "${nextData.slug}"`);
	}

	if (nextFolder) {
		const duplicateFolder = categories.find(category =>
			category._filename !== filename &&
			category.tipo_menu === 'beverage' &&
			getCategoryFolder(category) === nextFolder
		);
		if (duplicateFolder) {
			throw new ConflictError(`La cartella beverage "${nextFolder}" e gia usata da "${duplicateFolder.nome}"`);
		}
	}

	if (nextData.parent_category) {
		const parent = categories.find(category =>
			category._filename !== filename &&
			normalizeSlug(category.slug || category.nome) === normalizeSlug(nextData.parent_category)
		);
		if (!parent) {
			throw new DomainError('Categoria padre non trovata');
		}
		if (parent.tipo_menu !== nextData.tipo_menu) {
			throw new DomainError('La categoria padre deve avere lo stesso tipo_menu');
		}
		if (parent.parent_category) {
			throw new DomainError('La categoria padre deve essere di primo livello');
		}
	}

	if (!sha) return;

	const currentCategory = categories.find(category => category._filename === filename)
		|| await readCategoryByFilename(gh, filename);
	if (!currentCategory || !hasCategoryStructuralChange(currentCategory, nextData)) return;

	const dependents = await loadCategoryDependents(gh, currentCategory);
	const dependencyError = buildCategoryDependencyError('modificare', currentCategory, dependents);
	if (dependencyError) {
		throw new DomainError(dependencyError);
	}
}

export async function assertSafeCategoryDelete(
	gh: GithubClient,
	collection: string,
	filename: string
): Promise<void> {
	if (collection !== 'categorie') return;

	const currentCategory = await readCategoryByFilename(gh, filename);
	if (!currentCategory) return;

	const dependents = await loadCategoryDependents(gh, currentCategory);
	const dependencyError = buildCategoryDependencyError('eliminare', currentCategory, dependents);
	if (dependencyError) {
		throw new DomainError(dependencyError);
	}
}

function applySaveToCollectionItems(items: ItemRecord[], filename: string, data: ItemRecord): ItemRecord[] {
	const nextItems = items.filter(item => item._filename !== filename);
	nextItems.push({ ...data, _filename: filename });
	nextItems.sort(compareMenuItems);
	return nextItems;
}

function applyDeleteToCollectionItems(items: ItemRecord[], filename: string): ItemRecord[] {
	return items
		.filter(item => item._filename !== filename)
		.sort(compareMenuItems);
}

// ========================================
// TRANSAZIONE DI COMMIT
// ========================================

/**
 * Commit atomico con transazione RICOSTRUITA a ogni tentativo.
 *
 * Per tentativo:
 *   1. legge HEAD del branch e ci pinna tutte le letture del client;
 *   2. chiama `build()`, che rilegge lo snapshot, riapplica la modifica,
 *      riverifica l'OCC e rigenera il JSON aggregato su QUEL commit;
 *   3. crea tree + commit con `parents: [HEAD]` e fa PATCH della ref.
 *
 * La PATCH senza `force` è il lucchetto: se il branch si è mosso GitHub risponde
 * 422 non-fast-forward e si ricomincia dal punto 1 con dati freschi. Nessun
 * risultato di un tentativo precedente viene riusato.
 */
export async function createCommitTransaction({
	gh, message, build, head = null
}: {
	gh: GithubClient;
	message: string;
	build: (head: BranchHead) => Promise<TreeEntry[]>;
	/** HEAD già letto dal chiamante: evita una GET /branches al primo tentativo. */
	head?: BranchHead | null;
}): Promise<any> {
	let currentHead = head;
	let lastError: unknown;

	for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
		if (!currentHead) {
			currentHead = await gh.syncBranchHead();
		}

		const treeEntries = await build(currentHead);
		// Nessuna entry = niente da committare (es. batch già allineato)
		if (!treeEntries.length) return null;

		try {
			const newTree = await gh.request('POST', `/repos/${gh.owner}/${gh.repo}/git/trees`, {
				base_tree: currentHead.treeSha,
				tree: treeEntries
			});

			const newCommit = await gh.request('POST', `/repos/${gh.owner}/${gh.repo}/git/commits`, {
				message,
				tree: newTree.sha,
				parents: [currentHead.commitSha]
			});

			await gh.request(
				'PATCH',
				`/repos/${gh.owner}/${gh.repo}/git/refs/heads/${gh.branch}`,
				{ sha: newCommit.sha }
			);

			return newCommit;
		} catch (error) {
			lastError = error;
			const movedUnderUs = error instanceof GitHubApiError && error.isNonFastForward;
			if (movedUnderUs && attempt < MAX_COMMIT_ATTEMPTS - 1) {
				console.warn(
					`[commit] ${gh.branch} si è mosso: ricostruisco la transazione (tentativo ${attempt + 2}/${MAX_COMMIT_ATTEMPTS})`
				);
				currentHead = null; // forza syncBranchHead → nuovo pin → build() da capo
				await sleep(200 * (attempt + 1));
				continue;
			}
			throw error;
		}
	}

	throw lastError;
}

// ========================================
// CONFIG COLLECTION + SNAPSHOT
// ========================================

// Mapping delle collection ai file JSON di destinazione
export const COLLECTION_CONFIG: Record<string, CollectionConfig> = {
	'food': { jsonPath: 'food/food.json', type: 'food' },
	'beers': { jsonPath: 'beers/beers.json', type: 'beers' },
	'categorie': { jsonPath: 'categorie/categorie.json', type: 'categories' },
	// Beverage collections derivate dalla costante BASE_BEVERAGE_CATEGORIES
	...Object.fromEntries(BASE_BEVERAGE_CATEGORIES.map((c: { folder: string; name: string }) => [
		c.folder,
		{ jsonPath: 'beverages/beverages.json', type: 'beverages', folder: c.folder, name: c.name }
	]))
};

export async function resolveCollectionConfig(
	gh: GithubClient,
	collection: string,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<CollectionConfig | null> {
	let config = COLLECTION_CONFIG[collection];

	if (!config) {
		const categories = (await readCollectionSnapshot(gh, 'categorie', overrides))
			|| await readCollectionFiles(gh, 'categorie', overrides);
		const matchedCategory = findBeverageCategoryByFolder(categories, collection);
		if (matchedCategory) {
			config = {
				jsonPath: 'beverages/beverages.json',
				type: 'beverages',
				folder: getCategoryFolder(matchedCategory),
				name: matchedCategory.nome
			};
			console.log(`📦 Dynamic beverage folder detected: ${config.folder} → "${matchedCategory.nome}"`);
		}
	}

	return config || null;
}

/**
 * Snapshot della collection dal JSON aggregato (1 sola GET).
 * `null` SOLO se la collection non è mappata o il JSON non esiste ancora:
 * in quel caso il chiamante ricade sui markdown. Un guasto GitHub risale.
 */
export async function readCollectionSnapshot(
	gh: GithubClient,
	collection: string,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<ItemRecord[] | null> {
	if (Object.prototype.hasOwnProperty.call(overrides, collection)) {
		return cloneCollectionItems(overrides[collection] || []);
	}

	const config = await resolveCollectionConfig(gh, collection, overrides);
	if (!config) return null;

	const jsonData = await readJsonFileOptional(gh, config.jsonPath);
	if (!jsonData) {
		console.log(`⚠️ Snapshot JSON assente per ${collection}: fallback ai markdown`);
		return null;
	}

	if (config.type === 'food') return cloneCollectionItems(jsonData.food || []);
	if (config.type === 'beers') return cloneCollectionItems(jsonData.beers || []);
	if (config.type === 'categories') return cloneCollectionItems(jsonData.categories || []);
	if (config.type === 'beverages') {
		return cloneCollectionItems((jsonData.beverages || []).filter((item: ItemRecord) => item.tipo === config.name));
	}

	return null;
}

// ========================================
// GENERAZIONE JSON AGGREGATI
// ========================================

export async function generateJSONForConfig(
	gh: GithubClient,
	config: CollectionConfig | null,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<any> {
	if (!config) return null;

	if (config.type === 'food') return generateFoodJSON(gh, overrides);
	if (config.type === 'beers') return generateBeersJSON(gh, overrides);
	if (config.type === 'categories') return generateCategoriesJSON(gh, overrides);
	if (config.type === 'beverages') {
		const incremental = await generateIncrementalBeveragesJSON(gh, config, overrides);
		if (incremental) return incremental;
		return generateBeveragesJSON(gh, overrides);
	}

	return null;
}

export async function buildJsonTreeEntry(
	gh: GithubClient,
	collection: string,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<TreeEntry | null> {
	const config = await resolveCollectionConfig(gh, collection, overrides);
	if (!config) return null;

	const jsonContent = await generateJSONForConfig(gh, config, overrides);
	if (!jsonContent) return null;

	return {
		path: config.jsonPath,
		mode: '100644',
		type: 'blob',
		content: JSON.stringify(jsonContent, null, 2)
	};
}

/**
 * Aggiorna solo la fetta di beverages.json della cartella toccata (1 GET).
 * Se il JSON non esiste ancora si ricade sul rebuild completo, che è molto più
 * costoso in subrequest — da qui il budget del client.
 */
async function generateIncrementalBeveragesJSON(
	gh: GithubClient,
	config: CollectionConfig,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<any> {
	if (!config?.folder || !Object.prototype.hasOwnProperty.call(overrides, config.folder)) {
		return null;
	}

	const displayName = config.name
		|| BASE_BEVERAGE_CATEGORIES.find((category: { folder: string; name: string }) => category.folder === config.folder)?.name;
	if (!displayName) {
		return null;
	}

	const currentJson = await readJsonFileOptional(gh, config.jsonPath);
	if (!currentJson) {
		console.log(`⚠️ ${config.jsonPath} assente: rebuild completo beverages`);
		return null;
	}

	const currentByType: Record<string, ItemRecord[]> = { ...(currentJson.beveragesByType || {}) };
	const updatedItems = (overrides[config.folder] || [])
		.map((item): ItemRecord => ({ ...item, tipo: displayName }))
		.sort(compareMenuItems);

	if (updatedItems.length > 0) {
		currentByType[displayName] = updatedItems;
	} else {
		delete currentByType[displayName];
	}

	const orderedKeys = Object.keys(currentJson.beveragesByType || {});
	if (updatedItems.length > 0 && !orderedKeys.includes(displayName)) {
		orderedKeys.push(displayName);
	}

	const nextByType: Record<string, ItemRecord[]> = {};
	orderedKeys.forEach(key => {
		if (currentByType[key]?.length) {
			nextByType[key] = currentByType[key];
		}
	});

	Object.keys(currentByType).forEach(key => {
		if (!nextByType[key] && currentByType[key]?.length) {
			nextByType[key] = currentByType[key];
		}
	});

	const beverages: ItemRecord[] = [];
	Object.values(nextByType).forEach(items => beverages.push(...items));

	return {
		beverages,
		beveragesByType: nextByType
	};
}

export async function generateFoodJSON(
	gh: GithubClient,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<any> {
	const useSnapshots = Object.keys(overrides).length > 0;
	// Carica anche le categorie per l'ordine
	const categories = useSnapshots
		? (await readCollectionSnapshot(gh, 'categorie', overrides))
			|| await readCollectionFiles(gh, 'categorie', overrides)
		: await readCollectionFiles(gh, 'categorie', overrides);
	// INCLUDE anche le categorie nascoste (visibile: false), come scripts/generate-json.js:
	// il filtro visibilità è del frontend (app.js). Escluderle qui disallineava
	// food.json rigenerato dal CMS rispetto al build, facendo fallire il check CI.
	const foodCategories = categories.filter(c => c.tipo_menu === 'food');

	const foodItems = useSnapshots
		? (await readCollectionSnapshot(gh, 'food', overrides))
			|| await readCollectionFiles(gh, 'food', overrides)
		: await readCollectionFiles(gh, 'food', overrides);

	foodItems.forEach(item => {
		const match = findCategoryByReference(foodCategories, item.category, 'food');
		if (match) {
			item.category = match.nome;
			item.category_slug = normalizeSlug(item.category_slug || match.slug || match.nome);
		} else if (item.category_slug) {
			item.category_slug = normalizeSlug(item.category_slug);
		}
	});

	// Ordine canonico condiviso con il build locale.
	foodItems.sort(compareMenuItems);

	// Raggruppa per categoria
	const foodByCategory: Record<string, ItemRecord[]> = {};

	// Inizializza categorie vuote
	foodCategories.forEach(cat => {
		foodByCategory[cat.nome] = [];
	});

	// Aggiungi i piatti
	foodItems.forEach(item => {
		const category = item.category || 'Altro';
		if (!foodByCategory[category]) {
			foodByCategory[category] = [];
		}
		foodByCategory[category].push(item);
	});

	// Ordina categorie
	const categoryOrder: Record<string, number> = {};
	foodCategories.forEach((cat, idx) => {
		categoryOrder[cat.nome] = cat.order || idx;
	});

	return {
		food: foodItems,
		foodByCategory,
		categoryOrder
	};
}

export async function generateBeersJSON(
	gh: GithubClient,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<any> {
	const useSnapshots = Object.keys(overrides).length > 0;
	const beers = useSnapshots
		? (await readCollectionSnapshot(gh, 'beers', overrides))
			|| await readCollectionFiles(gh, 'beers', overrides)
		: await readCollectionFiles(gh, 'beers', overrides);

	const beverageCategories = await (useSnapshots
		? loadCategoriesSnapshot(gh)
		: readCollectionFiles(gh, 'categorie', overrides));

	beers.forEach(beer => {
		const match = findCategoryByReference(beverageCategories, beer.sezione, 'beverage');
		if (match) {
			beer.sezione = match.nome;
			beer.sezione_slug = normalizeSlug(beer.sezione_slug || match.slug || match.nome);
		} else if (beer.sezione_slug) {
			beer.sezione_slug = normalizeSlug(beer.sezione_slug);
		}
	});

	// Ordine canonico condiviso con il build locale.
	beers.sort(compareMenuItems);

	// Raggruppa per sezione
	const beersBySection: Record<string, ItemRecord[]> = {};
	beers.forEach(beer => {
		const section = beer.sezione || 'Birre alla spina';
		if (!beersBySection[section]) {
			beersBySection[section] = [];
		}
		beersBySection[section].push(beer);
	});

	return {
		beers,
		beersBySection
	};
}

export async function generateCategoriesJSON(
	gh: GithubClient,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<any> {
	// Preferisci snapshot JSON (1 GET) — stesso shape; full MD solo se snapshot manca
	const categories = (await readCollectionSnapshot(gh, 'categorie', overrides))
		|| await readCollectionFiles(gh, 'categorie', overrides);

	// Ordina (NON FILTRARE VISIBILI: il CMS deve vederle tutte!)
	const allCategories = categories
		.sort(compareMenuItems);

	return {
		categories: allCategories,
		foodCategories: allCategories.filter(c => c.tipo_menu === 'food'),
		beverageCategories: allCategories.filter(c => c.tipo_menu === 'beverage')
	};
}

export async function generateBeveragesJSON(
	gh: GithubClient,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<any> {
	const useSnapshots = Object.keys(overrides).length > 0;
	// Lista completa dei folder beverage: hardcoded + dinamici dalle categorie
	const knownFolders = new Set<string>(BASE_BEVERAGE_CATEGORIES.map((c: { folder: string }) => c.folder));
	const allBeverageFolders: { name: string; folder: string; slug?: string }[] = [...BASE_BEVERAGE_CATEGORIES];

	// Scopri folder beverage dinamici dalla collection categorie
	const categories = useSnapshots
		? (await readCollectionSnapshot(gh, 'categorie', overrides))
			|| await readCollectionFiles(gh, 'categorie', overrides)
		: await readCollectionFiles(gh, 'categorie', overrides);
	const beverageCats = categories.filter(c => c.tipo_menu === 'beverage');
	for (const cat of beverageCats) {
		const folder = getCategoryFolder(cat);
		if (folder && !knownFolders.has(folder)) {
			allBeverageFolders.push({ name: cat.nome, folder, slug: normalizeSlug(cat.slug || cat.nome) });
			knownFolders.add(folder);
			console.log(`📦 Dynamic beverage folder discovered: ${folder} → "${cat.nome}"`);
		}
	}

	const beveragesByType: Record<string, ItemRecord[]> = {};
	const allBeverages: ItemRecord[] = [];

	for (const category of allBeverageFolders) {
		const items = useSnapshots
			? (await readCollectionSnapshot(gh, category.folder, overrides))
				|| await readCollectionFiles(gh, category.folder, overrides)
			: await readCollectionFiles(gh, category.folder, overrides);

		// Aggiungi il tipo a ogni item
		items.forEach(item => {
			item.tipo = category.name;
			item.tipo_slug = normalizeSlug(item.tipo_slug || category.slug || category.folder || category.name);
		});

		// Ordina
		items.sort(compareMenuItems);

		if (items.length > 0) {
			beveragesByType[category.name] = items;
			allBeverages.push(...items);
		}
	}

	return {
		beverages: allBeverages,
		beveragesByType
	};
}

// ========================================
// SAVE / DELETE ATOMICI
// ========================================

export async function saveItemAtomically({
	gh, collection, filename, data, sha, head = null
}: {
	gh: GithubClient;
	collection: string;
	filename: string;
	data: ItemRecord;
	sha?: string | null;
	head?: BranchHead | null;
}): Promise<{ sha: string; content: { sha: string }; commit: any }> {
	const repoPath = `${collection}/${filename}`;
	const fileContent = generateMarkdown(data);
	const fileSha = calculateGitBlobSha(fileContent);

	const commit = await createCommitTransaction({
		gh,
		message: `CMS: Update ${repoPath}`,
		head,
		// Rieseguito da capo a ogni tentativo, sul commit appena pinnato
		build: async () => {
			const existingItems = (await readCollectionSnapshot(gh, collection))
				|| await readCollectionFiles(gh, collection);
			const fileExists = existingItems.some(item => item._filename === filename);

			if (!sha && fileExists) {
				throw new ConflictError('Esiste gia un file con questo nome');
			}
			if (sha && !fileExists) {
				throw new NotFoundError('File non trovato per aggiornamento');
			}

			// OCC fail-closed: se non possiamo verificare, non committiamo
			if (sha) {
				await assertBlobUnchanged(gh, repoPath, sha);
			}

			const updatedItems = applySaveToCollectionItems(existingItems, filename, data);
			const treeEntries: TreeEntry[] = [
				{ path: repoPath, mode: '100644', type: 'blob', content: fileContent }
			];

			// JSON aggregato rigenerato QUI dentro: sul retry riparte dallo snapshot
			// fresco e include le modifiche concorrenti già committate.
			const jsonEntry = await buildJsonTreeEntry(gh, collection, { [collection]: updatedItems });
			if (jsonEntry) treeEntries.push(jsonEntry);

			return treeEntries;
		}
	});

	return { sha: fileSha, content: { sha: fileSha }, commit };
}

export async function deleteItemAtomically({
	gh, collection, filename, sha = null, head = null
}: {
	gh: GithubClient;
	collection: string;
	filename: string;
	sha?: string | null;
	head?: BranchHead | null;
}): Promise<any> {
	const repoPath = `${collection}/${filename}`;

	return createCommitTransaction({
		gh,
		message: `CMS: Delete ${repoPath}`,
		head,
		build: async () => {
			const existingItems = (await readCollectionSnapshot(gh, collection))
				|| await readCollectionFiles(gh, collection);

			const current = await readRepoFileOptional(gh, repoPath);
			if (!current) throw new NotFoundError('File non trovato per eliminazione');
			// OCC fail-closed: il blob deve essere quello che il client ha letto
			if (sha && current.sha && current.sha !== sha) throw new ConflictError();

			const updatedItems = applyDeleteToCollectionItems(existingItems, filename);
			const treeEntries: TreeEntry[] = [
				{ path: repoPath, mode: '100644', type: 'blob', sha: null }
			];

			const jsonEntry = await buildJsonTreeEntry(gh, collection, { [collection]: updatedItems });
			if (jsonEntry) treeEntries.push(jsonEntry);

			return treeEntries;
		}
	});
}

// ========================================
// LETTURA MARKDOWN DI UNA COLLECTION
// ========================================

/**
 * Legge tutti i .md di una collection. Percorso COSTOSO (1 listing + 1 GET per
 * file): usato solo quando manca lo snapshot JSON. Il budget subrequest del
 * client lo interrompe con un errore azionabile prima che il Worker muoia.
 *
 * FAIL-CLOSED: 404 sulla cartella = collezione vuota legittima; qualunque altro
 * errore, anche su un singolo file, aborta. Prima un file illeggibile veniva
 * saltato in silenzio e spariva dal JSON aggregato riscritto.
 */
export async function readCollectionFiles(
	gh: GithubClient,
	folder: string,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<ItemRecord[]> {
	if (Object.prototype.hasOwnProperty.call(overrides, folder)) {
		return (overrides[folder] || []).map(item => ({ ...item }));
	}

	let files: any[];
	try {
		files = await gh.listDir(folder);
	} catch (error) {
		if (error instanceof GitHubApiError && error.isNotFound) {
			console.log(`[readCollectionFiles] cartella "${folder}" assente → nessun item`);
			return [];
		}
		throw error;
	}

	const mdFiles = files.filter((f: any) => f.name.endsWith('.md') && f.name !== '.gitkeep');
	if (mdFiles.length === 0) return [];

	// Una chiamata GraphQL ogni 100 file invece di una GET per file: leggere
	// beers/ costa 2 chiamate, non 112.
	const contents = await gh.readFilesBatch(mdFiles.map((f: any) => `${folder}/${f.name}`));

	return mdFiles.map((file: any) => {
		const repoPath = `${folder}/${file.name}`;
		const item = contents.get(repoPath);
		// Elencato ma non leggibile: non si salta in silenzio, si aborta
		if (!item) throw new DomainError(`File elencato ma non leggibile: ${repoPath}`);

		const parsed = parseFrontmatter(item.content);
		if (!parsed) {
			throw new DomainError(`Frontmatter non valido: ${repoPath}`);
		}
		parsed._filename = file.name;
		return parsed;
	});
}
