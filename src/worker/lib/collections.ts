// Logica di dominio CMS — port meccanico da netlify/functions/save-data.js.
// Semantica INVARIATA: commit atomici Git Trees API, OCC su SHA blob,
// retry non-fast-forward, generatori JSON aggregati, guardie categorie.
// Unica differenza strutturale: cache GET per-request incapsulata in GithubClient
// (parametro `gh`) invece del vecchio stato globale `requestGetCache`.

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
import { GithubClient } from './github';
import { sleep } from './http';
import type { ItemRecord } from '../types';

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

export function getErrorStatusCode(error: unknown): number {
	const message = String((error as Error)?.message || '');

	if (
		message.includes('Campi obbligatori') ||
		message.includes('Payload non valido') ||
		message.includes('Prezzo non valido') ||
		message.includes('Slug categoria non valido') ||
		message.includes('Categoria food non valida') ||
		message.includes('Sezione birra non valida') ||
		message.includes('tipo_menu categoria non valido') ||
		message.includes('Categoria padre') ||
		message.includes('Una categoria non puo avere se stessa come padre') ||
		message.includes('Impossibile modificare la categoria') ||
		message.includes('Impossibile eliminare la categoria')
	) {
		return 400;
	}

	if (
		message.includes('Esiste gia una categoria') ||
		message.includes('gia usata') ||
		message.includes('already exists') ||
		message.includes('Conflitto: il contenuto è stato modificato')
	) {
		return 409;
	}

	if (message.includes('File non trovato')) {
		return 404;
	}

	return 500;
}

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

export async function loadCategoriesSnapshot(gh: GithubClient, owner: string, repo: string): Promise<ItemRecord[]> {
	return (await readCollectionSnapshot('categorie', gh, owner, repo))
		|| readCollectionFiles('categorie', gh, owner, repo);
}

export async function prepareDataForSave(
	collection: string,
	rawData: ItemRecord = {},
	gh: GithubClient,
	owner: string,
	repo: string,
	options: { filename?: string; sha?: string | null } = {}
): Promise<ItemRecord> {
	if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
		throw new Error('Payload non valido');
	}

	// Merge con .md esistente su UPDATE: preserva campi non presenti nel form
	// (es. legacy, note future) senza cancellarli. I campi del form vincono.
	let existing: ItemRecord = {};
	if (options.sha && options.filename) {
		try {
			const mdContent = await readRepoFileContent(`${collection}/${options.filename}`, gh, owner, repo);
			existing = parseFrontmatter(mdContent) || {};
		} catch (e) {
			console.warn(`[prepareDataForSave] merge skip: ${(e as Error).message}`);
		}
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
			throw new Error('Slug categoria non valido');
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
			throw new Error('Prezzo non valido');
		}
		normalized.prezzo = parsedPrice.toFixed(2);
	}

	if (normalized.order !== undefined) {
		normalized.order = Number.parseInt(normalized.order, 10) || 0;
	}

	if (collection === 'food' || collection === 'beers' || !['categorie', 'food', 'beers'].includes(collection)) {
		const categories = await loadCategoriesSnapshot(gh, owner, repo);

		if (collection === 'food') {
			const match = findCategoryByReference(categories, normalized.category, 'food');
			if (!match) {
				throw new Error('Categoria food non valida');
			}
			normalized.category = match.nome;
			normalized.category_slug = normalizeSlug(match.slug || match.nome);
		} else if (collection === 'beers') {
			const match = findCategoryByReference(categories, normalized.sezione, 'beverage');
			if (!match) {
				throw new Error('Sezione birra non valida');
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
		throw new Error(`Campi obbligatori mancanti: ${missing.join(', ')}`);
	}

	if (collection === 'categorie') {
		if (!['food', 'beverage'].includes(data.tipo_menu)) {
			throw new Error('tipo_menu categoria non valido');
		}
		if (data.parent_category && normalizeSlug(data.parent_category) === normalizeSlug(data.slug)) {
			throw new Error('Una categoria non puo avere se stessa come padre');
		}
	}
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

export async function readRepoFileContent(repoPath: string, gh: GithubClient, owner: string, repo: string): Promise<string> {
	const fileData = await gh.request('GET', `/repos/${owner}/${repo}/contents/${repoPath}`);
	return Buffer.from(fileData.content, 'base64').toString('utf-8');
}

/** Content + blob SHA per OCC recheck sui batch commit */
export async function readRepoFileWithMeta(
	repoPath: string,
	gh: GithubClient,
	owner: string,
	repo: string
): Promise<{ content: string; sha: string | null }> {
	const fileData = await gh.request('GET', `/repos/${owner}/${repo}/contents/${repoPath}`);
	return {
		content: Buffer.from(fileData.content, 'base64').toString('utf-8'),
		sha: fileData.sha || null
	};
}

/**
 * Ri-verifica gli SHA blob su retry NFF così i batch commit non sovrascrivono
 * silenziosamente modifiche concorrenti.
 */
export function makeBatchOccRecheck(
	expected: { path: string; sha: string }[],
	gh: GithubClient,
	owner: string,
	repo: string,
	branch = 'main'
): (() => Promise<void>) | null {
	const checks = (expected || []).filter(e => e && e.path && e.sha);
	if (!checks.length) return null;
	return async () => {
		for (const { path, sha } of checks) {
			try {
				const fileData = await gh.request(
					'GET',
					`/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`
				);
				if (fileData && fileData.sha && fileData.sha !== sha) {
					throw new Error('Conflitto: il contenuto è stato modificato. Ricarica e riprova.');
				}
			} catch (error) {
				if (String((error as Error).message || '').includes('Conflitto:')) throw error;
				console.warn(`[batch OCC recheck] ${path}: ${(error as Error).message}`);
			}
		}
	};
}

async function readJsonFileFromRepo(repoPath: string, gh: GithubClient, owner: string, repo: string): Promise<any> {
	return JSON.parse(await readRepoFileContent(repoPath, gh, owner, repo));
}

function cloneCollectionItems(items: ItemRecord[] = []): ItemRecord[] {
	return items.map(item => ({ ...item }));
}

async function readCategoryByFilename(
	filename: string,
	gh: GithubClient,
	owner: string,
	repo: string
): Promise<ItemRecord | null> {
	const content = await readRepoFileContent(`categorie/${filename}`, gh, owner, repo);
	const parsed = parseFrontmatter(content);
	if (!parsed) return null;
	parsed._filename = filename;
	return parsed;
}

async function loadCategoryDependents(
	category: ItemRecord,
	gh: GithubClient,
	owner: string,
	repo: string,
	overrides: Record<string, ItemRecord[]> = {}
) {
	const aliases = getCategoryReferenceAliases(category);
	const categories = (await readCollectionSnapshot('categorie', gh, owner, repo, overrides))
		|| await readCollectionFiles('categorie', gh, owner, repo, overrides);
	const childCategories = categories.filter(item =>
		item._filename !== category._filename &&
		matchesCategoryReference(item.parent_category, aliases)
	);

	const foodItems = category.tipo_menu === 'food'
		? ((await readCollectionSnapshot('food', gh, owner, repo, overrides))
			|| await readCollectionFiles('food', gh, owner, repo, overrides))
			.filter(item => matchesCategoryReference(item.category, aliases))
		: [];

	const beerItems = category.tipo_menu === 'beverage'
		? ((await readCollectionSnapshot('beers', gh, owner, repo, overrides))
			|| await readCollectionFiles('beers', gh, owner, repo, overrides))
			.filter(item => matchesCategoryReference(item.sezione, aliases))
		: [];

	const beverageItems = category.tipo_menu === 'beverage'
		? ((await readCollectionSnapshot(getCategoryFolder(category), gh, owner, repo, overrides))
			|| await readCollectionFiles(getCategoryFolder(category), gh, owner, repo, overrides))
		: [];

	return { childCategories, foodItems, beerItems, beverageItems };
}

export async function assertSafeCategorySave(
	collection: string,
	filename: string,
	nextData: ItemRecord,
	sha: string | null | undefined,
	gh: GithubClient,
	owner: string,
	repo: string
): Promise<void> {
	if (collection !== 'categorie') return;

	const categories = (await readCollectionSnapshot('categorie', gh, owner, repo))
		|| await readCollectionFiles('categorie', gh, owner, repo);
	const normalizedNextSlug = normalizeSlug(nextData.slug);
	const nextCategoryCandidate = { ...nextData, _filename: filename };
	const nextFolder = nextData.tipo_menu === 'beverage' ? getCategoryFolder(nextCategoryCandidate) : null;

	const duplicateSlug = categories.find(category =>
		category._filename !== filename &&
		normalizeSlug(category.slug || category.nome) === normalizedNextSlug
	);
	if (duplicateSlug) {
		throw new Error(`Esiste gia una categoria con slug "${nextData.slug}"`);
	}

	if (nextFolder) {
		const duplicateFolder = categories.find(category =>
			category._filename !== filename &&
			category.tipo_menu === 'beverage' &&
			getCategoryFolder(category) === nextFolder
		);
		if (duplicateFolder) {
			throw new Error(`La cartella beverage "${nextFolder}" e gia usata da "${duplicateFolder.nome}"`);
		}
	}

	if (nextData.parent_category) {
		const parent = categories.find(category =>
			category._filename !== filename &&
			normalizeSlug(category.slug || category.nome) === normalizeSlug(nextData.parent_category)
		);
		if (!parent) {
			throw new Error('Categoria padre non trovata');
		}
		if (parent.tipo_menu !== nextData.tipo_menu) {
			throw new Error('La categoria padre deve avere lo stesso tipo_menu');
		}
		if (parent.parent_category) {
			throw new Error('La categoria padre deve essere di primo livello');
		}
	}

	if (!sha) return;

	const currentCategory = categories.find(category => category._filename === filename)
		|| await readCategoryByFilename(filename, gh, owner, repo);
	if (!currentCategory || !hasCategoryStructuralChange(currentCategory, nextData)) return;

	const dependents = await loadCategoryDependents(currentCategory, gh, owner, repo);
	const dependencyError = buildCategoryDependencyError('modificare', currentCategory, dependents);
	if (dependencyError) {
		throw new Error(dependencyError);
	}
}

export async function assertSafeCategoryDelete(
	collection: string,
	filename: string,
	gh: GithubClient,
	owner: string,
	repo: string
): Promise<void> {
	if (collection !== 'categorie') return;

	const currentCategory = await readCategoryByFilename(filename, gh, owner, repo);
	if (!currentCategory) return;

	const dependents = await loadCategoryDependents(currentCategory, gh, owner, repo);
	const dependencyError = buildCategoryDependencyError('eliminare', currentCategory, dependents);
	if (dependencyError) {
		throw new Error(dependencyError);
	}
}

function applySaveToCollectionItems(items: ItemRecord[], filename: string, data: ItemRecord): ItemRecord[] {
	const nextItems = items.filter(item => item._filename !== filename);
	nextItems.push({ ...data, _filename: filename });
	nextItems.sort((a, b) => (a.order || 0) - (b.order || 0));
	return nextItems;
}

function applyDeleteToCollectionItems(items: ItemRecord[], filename: string): ItemRecord[] {
	return items
		.filter(item => item._filename !== filename)
		.sort((a, b) => (a.order || 0) - (b.order || 0));
}

async function getBranchContext(gh: GithubClient, owner: string, repo: string, branch = 'main') {
	const branchInfo = await gh.request('GET', `/repos/${owner}/${repo}/branches/${branch}`);
	return {
		branch,
		latestCommitSha: branchInfo.commit.sha,
		baseTreeSha: branchInfo.commit.commit.tree.sha
	};
}

function isNonFastForwardError(error: unknown): boolean {
	const message = String((error as Error)?.message || '');
	if (!message.includes('422')) return false;
	const lower = message.toLowerCase();
	return (
		lower.includes('not a fast forward') ||
		lower.includes('update is not a fast forward') ||
		lower.includes('fast-forward') ||
		lower.includes('does not point to') ||
		lower.includes('reference does not')
	);
}

export async function createCommitFromEntries({
	gh, owner, repo, message, treeEntries, branch = 'main', preCommitCheck = null
}: {
	gh: GithubClient;
	owner: string;
	repo: string;
	message: string;
	treeEntries: TreeEntry[];
	branch?: string;
	preCommitCheck?: (() => Promise<void>) | null;
}): Promise<any> {
	if (!treeEntries.length) {
		throw new Error('Nessuna modifica da salvare');
	}

	// Retry su 422 non-fast-forward: re-leggi HEAD e riprova (max 2 retry = 3 tentativi)
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			// M3: su retry, ri-verifica OCC SHA per non sovrascrivere modifiche concorrenti
			if (attempt > 0 && preCommitCheck) {
				await preCommitCheck();
			}

			const branchContext = await getBranchContext(gh, owner, repo, branch);
			const newTree = await gh.request(
				'POST',
				`/repos/${owner}/${repo}/git/trees`,
				{ base_tree: branchContext.baseTreeSha, tree: treeEntries }
			);

			const newCommit = await gh.request(
				'POST',
				`/repos/${owner}/${repo}/git/commits`,
				{
					message,
					tree: newTree.sha,
					parents: [branchContext.latestCommitSha]
				}
			);

			await gh.request(
				'PATCH',
				`/repos/${owner}/${repo}/git/refs/heads/${branch}`,
				{ sha: newCommit.sha }
			);

			return newCommit;
		} catch (error) {
			lastError = error;
			if (isNonFastForwardError(error) && attempt < 2) {
				console.warn(
					`[createCommitFromEntries] non-fast-forward su ${branch}, re-leggo HEAD (tentativo ${attempt + 1}/2)`
				);
				await sleep(300 * (attempt + 1));
				continue;
			}
			throw error;
		}
	}

	throw lastError;
}

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
	collection: string,
	gh: GithubClient,
	owner: string,
	repo: string,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<CollectionConfig | null> {
	let config = COLLECTION_CONFIG[collection];

	if (!config) {
		const categories = (await readCollectionSnapshot('categorie', gh, owner, repo, overrides))
			|| await readCollectionFiles('categorie', gh, owner, repo, overrides);
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

export async function readCollectionSnapshot(
	collection: string,
	gh: GithubClient,
	owner: string,
	repo: string,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<ItemRecord[] | null> {
	if (Object.prototype.hasOwnProperty.call(overrides, collection)) {
		return cloneCollectionItems(overrides[collection] || []);
	}

	const config = await resolveCollectionConfig(collection, gh, owner, repo, overrides);
	if (!config) return null;

	try {
		const jsonData = await readJsonFileFromRepo(config.jsonPath, gh, owner, repo);

		if (config.type === 'food') {
			return cloneCollectionItems(jsonData.food || []);
		}
		if (config.type === 'beers') {
			return cloneCollectionItems(jsonData.beers || []);
		}
		if (config.type === 'categories') {
			return cloneCollectionItems(jsonData.categories || []);
		}
		if (config.type === 'beverages') {
			return cloneCollectionItems((jsonData.beverages || []).filter((item: ItemRecord) => item.tipo === config.name));
		}
	} catch (error) {
		console.log(`⚠️ Snapshot fallback to markdown for ${collection}: ${(error as Error).message}`);
	}

	return null;
}

export async function generateJSONForConfig(
	config: CollectionConfig | null,
	gh: GithubClient,
	owner: string,
	repo: string,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<any> {
	if (!config) return null;

	if (config.type === 'food') {
		return generateFoodJSON(gh, owner, repo, overrides);
	}
	if (config.type === 'beers') {
		return generateBeersJSON(gh, owner, repo, overrides);
	}
	if (config.type === 'categories') {
		return generateCategoriesJSON(gh, owner, repo, overrides);
	}
	if (config.type === 'beverages') {
		const incremental = await generateIncrementalBeveragesJSON(config, gh, owner, repo, overrides);
		if (incremental) return incremental;
		return generateBeveragesJSON(gh, owner, repo, overrides);
	}

	return null;
}

export async function buildJsonTreeEntry(
	collection: string,
	gh: GithubClient,
	owner: string,
	repo: string,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<TreeEntry | null> {
	const config = await resolveCollectionConfig(collection, gh, owner, repo, overrides);
	if (!config) return null;

	const jsonContent = await generateJSONForConfig(config, gh, owner, repo, overrides);
	if (!jsonContent) return null;

	return {
		path: config.jsonPath,
		mode: '100644',
		type: 'blob',
		content: JSON.stringify(jsonContent, null, 2)
	};
}

async function generateIncrementalBeveragesJSON(
	config: CollectionConfig,
	gh: GithubClient,
	owner: string,
	repo: string,
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

	try {
		const currentJson = JSON.parse(await readRepoFileContent(config.jsonPath, gh, owner, repo));
		const currentByType: Record<string, ItemRecord[]> = { ...(currentJson.beveragesByType || {}) };
		const updatedItems = (overrides[config.folder] || [])
			.map((item): ItemRecord => ({ ...item, tipo: displayName }))
			.sort((a, b) => (a.order || 0) - (b.order || 0));

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
	} catch (error) {
		console.log(`⚠️ Fallback full beverages regen: ${(error as Error).message}`);
		return null;
	}
}

export async function saveItemAtomically({
	collection, filename, data, sha, gh, owner, repo, branch = 'main'
}: {
	collection: string;
	filename: string;
	data: ItemRecord;
	sha?: string | null;
	gh: GithubClient;
	owner: string;
	repo: string;
	branch?: string;
}): Promise<any> {
	const existingItems = (await readCollectionSnapshot(collection, gh, owner, repo))
		|| await readCollectionFiles(collection, gh, owner, repo);
	const fileExists = existingItems.some(item => item._filename === filename);

	if (!sha && fileExists) {
		throw new Error('GitHub API error: 422 - File already exists');
	}
	if (sha && !fileExists) {
		throw new Error('File non trovato per aggiornamento');
	}

	// Optimistic concurrency: se sha fornito e file esiste, confronta con SHA blob attuale
	if (sha && fileExists) {
		try {
			const fileData = await gh.request(
				'GET',
				`/repos/${owner}/${repo}/contents/${collection}/${filename}?ref=${encodeURIComponent(branch)}`
			);
			if (fileData && fileData.sha && fileData.sha !== sha) {
				throw new Error('Conflitto: il contenuto è stato modificato. Ricarica e riprova.');
			}
		} catch (error) {
			const msg = String((error as Error).message || '');
			if (msg.includes('Conflitto:')) {
				throw error;
			}
			if (msg.includes('409') || msg.includes('Conflitto')) {
				throw error;
			}
			console.warn(`[saveItemAtomically] Impossibile verificare SHA attuale: ${msg}`);
		}
	}

	const updatedItems = applySaveToCollectionItems(existingItems, filename, data);
	const fileContent = generateMarkdown(data);
	const fileSha = calculateGitBlobSha(fileContent);
	const treeEntries: TreeEntry[] = [
		{
			path: `${collection}/${filename}`,
			mode: '100644',
			type: 'blob',
			content: fileContent
		}
	];

	const jsonEntry = await buildJsonTreeEntry(collection, gh, owner, repo, {
		[collection]: updatedItems
	});
	if (jsonEntry) {
		treeEntries.push(jsonEntry);
	}

	// M3: ri-verifica SHA a ogni retry per prevenire bypass OCC dopo write concorrente
	const occRecheck = sha ? async () => {
		try {
			const fileData = await gh.request(
				'GET',
				`/repos/${owner}/${repo}/contents/${collection}/${filename}?ref=${encodeURIComponent(branch)}`
			);
			if (fileData && fileData.sha && fileData.sha !== sha) {
				throw new Error('Conflitto: il contenuto è stato modificato. Ricarica e riprova.');
			}
		} catch (error) {
			if (String((error as Error).message || '').includes('Conflitto:')) throw error;
			console.warn(`[saveItemAtomically] OCC recheck: ${(error as Error).message}`);
		}
	} : null;

	const commit = await createCommitFromEntries({
		gh,
		owner,
		repo,
		message: `CMS: Update ${collection}/${filename}`,
		treeEntries,
		branch,
		preCommitCheck: occRecheck
	});

	return {
		sha: fileSha,
		content: { sha: fileSha },
		commit
	};
}

export async function deleteItemAtomically({
	collection, filename, gh, owner, repo, branch = 'main', sha = null
}: {
	collection: string;
	filename: string;
	gh: GithubClient;
	owner: string;
	repo: string;
	branch?: string;
	sha?: string | null;
}): Promise<any> {
	const existingItems = (await readCollectionSnapshot(collection, gh, owner, repo))
		|| await readCollectionFiles(collection, gh, owner, repo);
	const fileExists = existingItems.some(item => item._filename === filename);
	if (!fileExists) {
		// Verifica su GitHub: lo snapshot potrebbe essere stale
		try {
			await gh.request(
				'GET',
				`/repos/${owner}/${repo}/contents/${collection}/${filename}?ref=${encodeURIComponent(branch)}`
			);
		} catch {
			throw new Error('File non trovato per eliminazione');
		}
	}

	// OCC: se il client manda sha, confronta con blob attuale
	if (sha) {
		try {
			const fileData = await gh.request(
				'GET',
				`/repos/${owner}/${repo}/contents/${collection}/${filename}?ref=${encodeURIComponent(branch)}`
			);
			if (fileData && fileData.sha && fileData.sha !== sha) {
				throw new Error('Conflitto: il contenuto è stato modificato. Ricarica e riprova.');
			}
		} catch (error) {
			if (String((error as Error).message || '').includes('Conflitto:')) throw error;
			console.warn(`[deleteItemAtomically] SHA check: ${(error as Error).message}`);
		}
	}

	const updatedItems = applyDeleteToCollectionItems(existingItems, filename);
	const treeEntries: TreeEntry[] = [
		{
			path: `${collection}/${filename}`,
			mode: '100644',
			type: 'blob',
			sha: null
		}
	];

	const jsonEntry = await buildJsonTreeEntry(collection, gh, owner, repo, {
		[collection]: updatedItems
	});
	if (jsonEntry) {
		treeEntries.push(jsonEntry);
	}

	// M3: ri-verifica SHA a ogni retry per prevenire bypass OCC dopo write concorrente
	const occRecheck = sha ? async () => {
		try {
			const fileData = await gh.request(
				'GET',
				`/repos/${owner}/${repo}/contents/${collection}/${filename}?ref=${encodeURIComponent(branch)}`
			);
			if (fileData && fileData.sha && fileData.sha !== sha) {
				throw new Error('Conflitto: il contenuto è stato modificato. Ricarica e riprova.');
			}
		} catch (error) {
			if (String((error as Error).message || '').includes('Conflitto:')) throw error;
			console.warn(`[deleteItemAtomically] OCC recheck: ${(error as Error).message}`);
		}
	} : null;

	return createCommitFromEntries({
		gh,
		owner,
		repo,
		message: `CMS: Delete ${collection}/${filename}`,
		treeEntries,
		branch,
		preCommitCheck: occRecheck
	});
}

export async function regenerateJSON(
	collection: string,
	gh: GithubClient,
	owner: string,
	repo: string,
	branch = 'main'
): Promise<void> {
	const config = await resolveCollectionConfig(collection, gh, owner, repo);
	if (!config) {
		console.log(`⚠️ Collection ${collection} non configurata per rigenerazione JSON`);
		return;
	}

	// Full rebuild da markdown (source of truth). Più call API ma corretto se JSON stale.
	// I path atomici (save/reorder/visibility) non passano da qui: aggiornano JSON nello stesso commit.
	const jsonContent = await generateJSONForConfig(config, gh, owner, repo);
	if (jsonContent) {
		await commitJSON(config.jsonPath, jsonContent, gh, owner, repo, branch);
		console.log(`✅ JSON rigenerato: ${config.jsonPath}`);
	}
}

// Legge tutti i file .md di una collection
export async function readCollectionFiles(
	folder: string,
	gh: GithubClient,
	owner: string,
	repo: string,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<ItemRecord[]> {
	if (Object.prototype.hasOwnProperty.call(overrides, folder)) {
		return (overrides[folder] || []).map(item => ({ ...item }));
	}

	try {
		const url = `/repos/${owner}/${repo}/contents/${folder}`;
		const files = await gh.request('GET', url);

		if (!Array.isArray(files)) return [];

		const mdFiles = files.filter((f: any) => f.name.endsWith('.md') && f.name !== '.gitkeep');

		// M4: concorrenza limitata (max 8 letture parallele) per evitare secondary rate limit
		const CONCURRENCY = 8;
		const results: (ItemRecord | null)[] = [];
		for (let i = 0; i < mdFiles.length; i += CONCURRENCY) {
			const batch = mdFiles.slice(i, i + CONCURRENCY);
			const batchResults = await Promise.all(batch.map(async (file: any) => {
				try {
					const fileData = await gh.request('GET', `/repos/${owner}/${repo}/contents/${folder}/${file.name}`);
					const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
					const parsed = parseFrontmatter(content);
					if (parsed) {
						parsed._filename = file.name;
						return parsed;
					}
				} catch (e) {
					console.error(`Errore lettura ${file.name}:`, (e as Error).message);
				}
				return null;
			}));
			results.push(...batchResults);
		}

		return results.filter(Boolean) as ItemRecord[];
	} catch (e) {
		console.error(`Errore lettura collection ${folder}:`, (e as Error).message);
		return [];
	}
}

// ========================================
// GENERATORI JSON SPECIFICI
// ========================================

export async function generateFoodJSON(
	gh: GithubClient,
	owner: string,
	repo: string,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<any> {
	const useSnapshots = Object.keys(overrides).length > 0;
	// Carica anche le categorie per l'ordine
	const categories = useSnapshots
		? (await readCollectionSnapshot('categorie', gh, owner, repo, overrides))
			|| await readCollectionFiles('categorie', gh, owner, repo, overrides)
		: await readCollectionFiles('categorie', gh, owner, repo, overrides);
	const foodCategories = categories.filter(c => c.tipo_menu === 'food' && c.visibile !== false);

	const foodItems = useSnapshots
		? (await readCollectionSnapshot('food', gh, owner, repo, overrides))
			|| await readCollectionFiles('food', gh, owner, repo, overrides)
		: await readCollectionFiles('food', gh, owner, repo, overrides);

	foodItems.forEach(item => {
		const match = findCategoryByReference(foodCategories, item.category, 'food');
		if (match) {
			item.category = match.nome;
			item.category_slug = normalizeSlug(item.category_slug || match.slug || match.nome);
		} else if (item.category_slug) {
			item.category_slug = normalizeSlug(item.category_slug);
		}
	});

	// Ordina per order
	foodItems.sort((a, b) => (a.order || 0) - (b.order || 0));

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
	owner: string,
	repo: string,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<any> {
	const useSnapshots = Object.keys(overrides).length > 0;
	const beers = useSnapshots
		? (await readCollectionSnapshot('beers', gh, owner, repo, overrides))
			|| await readCollectionFiles('beers', gh, owner, repo, overrides)
		: await readCollectionFiles('beers', gh, owner, repo, overrides);

	const beverageCategories = await (useSnapshots
		? loadCategoriesSnapshot(gh, owner, repo)
		: readCollectionFiles('categorie', gh, owner, repo, overrides));

	beers.forEach(beer => {
		const match = findCategoryByReference(beverageCategories, beer.sezione, 'beverage');
		if (match) {
			beer.sezione = match.nome;
			beer.sezione_slug = normalizeSlug(beer.sezione_slug || match.slug || match.nome);
		} else if (beer.sezione_slug) {
			beer.sezione_slug = normalizeSlug(beer.sezione_slug);
		}
	});

	// Ordina per order
	beers.sort((a, b) => (a.order || 0) - (b.order || 0));

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
	owner: string,
	repo: string,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<any> {
	// Preferisci snapshot JSON (1 GET) — stesso shape; full MD solo se snapshot manca
	const categories = (await readCollectionSnapshot('categorie', gh, owner, repo, overrides))
		|| await readCollectionFiles('categorie', gh, owner, repo, overrides);

	// Ordina (NON FILTRARE VISIBILI: il CMS deve vederle tutte!)
	const allCategories = categories
		.sort((a, b) => (a.order || 0) - (b.order || 0));

	return {
		categories: allCategories,
		foodCategories: allCategories.filter(c => c.tipo_menu === 'food'),
		beverageCategories: allCategories.filter(c => c.tipo_menu === 'beverage')
	};
}

export async function generateBeveragesJSON(
	gh: GithubClient,
	owner: string,
	repo: string,
	overrides: Record<string, ItemRecord[]> = {}
): Promise<any> {
	const useSnapshots = Object.keys(overrides).length > 0;
	// Lista completa dei folder beverage: hardcoded + dinamici dalle categorie
	const knownFolders = new Set<string>(BASE_BEVERAGE_CATEGORIES.map((c: { folder: string }) => c.folder));
	const allBeverageFolders: { name: string; folder: string; slug?: string }[] = [...BASE_BEVERAGE_CATEGORIES];

	// Scopri folder beverage dinamici dalla collection categorie
	try {
		const categories = useSnapshots
			? (await readCollectionSnapshot('categorie', gh, owner, repo, overrides))
				|| await readCollectionFiles('categorie', gh, owner, repo, overrides)
			: await readCollectionFiles('categorie', gh, owner, repo, overrides);
		const beverageCats = categories.filter(c => c.tipo_menu === 'beverage');
		for (const cat of beverageCats) {
			const folder = getCategoryFolder(cat);
			if (folder && !knownFolders.has(folder)) {
				allBeverageFolders.push({ name: cat.nome, folder, slug: normalizeSlug(cat.slug || cat.nome) });
				knownFolders.add(folder);
				console.log(`📦 Dynamic beverage folder discovered: ${folder} → "${cat.nome}"`);
			}
		}
	} catch (e) {
		console.error('Error discovering dynamic beverage folders:', (e as Error).message);
	}

	const beveragesByType: Record<string, ItemRecord[]> = {};
	const allBeverages: ItemRecord[] = [];

	for (const category of allBeverageFolders) {
		let items: ItemRecord[];
		try {
			items = useSnapshots
				? (await readCollectionSnapshot(category.folder, gh, owner, repo, overrides))
					|| await readCollectionFiles(category.folder, gh, owner, repo, overrides)
				: await readCollectionFiles(category.folder, gh, owner, repo, overrides);
		} catch {
			// Folder può non esistere ancora (nessun prodotto) — skip senza errore
			console.log(`⏭️ Beverage folder "${category.folder}" not found or empty, skipping`);
			continue;
		}

		// Aggiungi il tipo a ogni item
		items.forEach(item => {
			item.tipo = category.name;
			item.tipo_slug = normalizeSlug(item.tipo_slug || category.slug || category.folder || category.name);
		});

		// Ordina
		items.sort((a, b) => (a.order || 0) - (b.order || 0));

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
// COMMIT JSON SU GITHUB (rigenerazione manuale)
// ========================================

export async function commitJSON(
	jsonPath: string,
	content: unknown,
	gh: GithubClient,
	owner: string,
	repo: string,
	branch = 'main'
): Promise<void> {
	const jsonString = JSON.stringify(content, null, 2);
	const base64Content = Buffer.from(jsonString).toString('base64');

	// Prima prova a ottenere lo SHA del file esistente
	let existingSha: string | null = null;
	try {
		const existingFile = await gh.request(
			'GET',
			`/repos/${owner}/${repo}/contents/${jsonPath}?ref=${encodeURIComponent(branch)}`
		);
		existingSha = existingFile.sha;
	} catch {
		// File non esiste, verrà creato
		console.log(`📝 Creazione nuovo file: ${jsonPath}`);
	}

	const body: Record<string, unknown> = {
		message: `CMS Auto: Rigenera ${jsonPath}`,
		content: base64Content,
		branch
	};

	if (existingSha) {
		body.sha = existingSha;
	}

	await gh.request('PUT', `/repos/${owner}/${repo}/contents/${jsonPath}`, body);
}
