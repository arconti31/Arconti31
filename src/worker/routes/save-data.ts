// /api/save-data — port di netlify/functions/save-data.js (handler).
// Action: login, verify-token, get-cloudinary-config, whoami, save, delete,
// regenerate-json, batch-set-visibility, batch-save-order.
// La logica di dominio è in lib/collections.ts (port meccanico, semantica invariata).

import { Buffer } from 'node:buffer';
import {
	findBeverageCategoryByFolder,
	getCategoryFolder,
	parseFrontmatter
} from '../../../lib/menu-utils.js';
import type { Env, ItemRecord } from '../types';
import { RepoConfigError } from '../types';
import { verifyToken } from '../lib/auth';
import { resolveRepoConfig } from '../lib/repo-config';
import { GithubClient } from '../lib/github';
import { corsHeaders } from '../lib/cors';
import { getBearerToken, json, parseJsonBody, text } from '../lib/http';
import { loginFromBody } from './auth';
import {
	COLLECTION_CONFIG,
	TreeEntry,
	assertSafeCategoryDelete,
	assertSafeCategorySave,
	createCommitFromEntries,
	deleteItemAtomically,
	generateJSONForConfig,
	generateMarkdown,
	getErrorStatusCode,
	makeBatchOccRecheck,
	prepareDataForSave,
	readCollectionFiles,
	readCollectionSnapshot,
	readRepoFileWithMeta,
	regenerateJSON,
	resolveCollectionConfig,
	saveItemAtomically
} from '../lib/collections';

function repoConfigErrorResponse(headers: Record<string, string>, error: RepoConfigError): Response {
	return json(500, {
		error: error.message || 'Configurazione repository mancante',
		code: error.code || 'REPO_CONFIG_MISSING'
	}, headers);
}

export async function handleSaveData(request: Request, env: Env): Promise<Response> {
	const headers = corsHeaders(request, env);

	// Handle CORS preflight
	if (request.method === 'OPTIONS') {
		return text(200, '', headers);
	}

	// Solo POST
	if (request.method !== 'POST') {
		return text(405, 'Method Not Allowed', headers);
	}

	// Parse body con gestione errori
	const body = await parseJsonBody(request);
	if (!body) {
		return json(400, { error: 'JSON non valido' }, headers);
	}

	const { action, collection, filename, data, sha, token, skipRegeneration } = body;

	// Validazione path traversal (sicurezza)
	if (collection && (collection.includes('..') || collection.includes('/') || collection.includes('\\'))) {
		return json(400, { error: 'Collection non valida' }, headers);
	}
	if (filename && (filename.includes('..') || filename.includes('/') || filename.includes('\\'))) {
		return json(400, { error: 'Filename non valido' }, headers);
	}

	// ==========================================
	// LOGIN (rate limit IP+email, no auth)
	// ==========================================
	if (action === 'login') {
		return loginFromBody(request, env, body, headers);
	}

	// ==========================================
	// VERIFICA TOKEN (Middleware) — tutte le altre action
	// ==========================================
	const incomingToken = getBearerToken(request, token);
	const userEmail = verifyToken(env, incomingToken);

	if (!userEmail) {
		return json(401, { error: 'Sessione scaduta o non valida' }, headers);
	}

	// Token valido (verificato dal middleware sopra)
	if (action === 'verify-token') {
		return json(200, { valid: true, email: userEmail }, headers);
	}

	// Cloudinary config — richiede auth
	if (action === 'get-cloudinary-config') {
		return json(200, {
			cloudName: env.CLOUDINARY_CLOUD_NAME || '',
			uploadPreset: env.CLOUDINARY_UPLOAD_PRESET || ''
		}, headers);
	}

	// whoami — target repo + presenza token, senza leak
	if (action === 'whoami') {
		try {
			const cfg = resolveRepoConfig(env);
			return json(200, {
				ok: true,
				target: { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch },
				hasToken: !!(env.GITHUB_TOKEN || '').trim()
			}, headers);
		} catch (error) {
			if (error instanceof RepoConfigError) {
				return repoConfigErrorResponse(headers, error);
			}
			throw error;
		}
	}

	const GITHUB_TOKEN = env.GITHUB_TOKEN;

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
			return repoConfigErrorResponse(headers, error);
		}
		throw error;
	}

	const target = { owner: REPO_OWNER, repo: REPO_NAME, branch: REPO_BRANCH };

	if (!GITHUB_TOKEN) {
		return json(500, { error: 'GITHUB_TOKEN non configurato nelle variabili del Worker' }, headers);
	}

	// Cache GET per-richiesta incapsulata nel client (niente stato globale)
	const gh = new GithubClient(GITHUB_TOKEN);

	try {
		const path = `${collection}/${filename}`;

		if (action === 'save') {
			const preparedData = await prepareDataForSave(collection, data, gh, REPO_OWNER, REPO_NAME, {
				filename,
				sha
			});
			await assertSafeCategorySave(collection, filename, preparedData, sha, gh, REPO_OWNER, REPO_NAME);

			let result;
			if (skipRegeneration) {
				const content = generateMarkdown(preparedData);
				const base64Content = Buffer.from(content).toString('base64');

				const putBody: Record<string, unknown> = {
					message: `CMS: Update ${path}`,
					content: base64Content,
					branch: REPO_BRANCH
				};

				if (sha) {
					putBody.sha = sha;
				}

				result = await gh.request('PUT', `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, putBody);
			} else {
				result = await saveItemAtomically({
					collection,
					filename,
					data: preparedData,
					sha,
					gh,
					owner: REPO_OWNER,
					repo: REPO_NAME,
					branch: REPO_BRANCH
				});
			}

			return json(200, { success: true, sha: result.content?.sha, target }, headers);

		} else if (action === 'delete') {
			console.log('Delete action - received sha:', sha, 'filename:', filename);

			if (!sha) {
				return json(400, { error: 'SHA mancante per eliminazione' }, headers);
			}

			await assertSafeCategoryDelete(collection, filename, gh, REPO_OWNER, REPO_NAME);

			if (skipRegeneration) {
				const deleteBody = {
					message: `CMS: Delete ${path}`,
					sha: sha,
					branch: REPO_BRANCH
				};

				console.log('Sending to GitHub:', JSON.stringify(deleteBody));

				await gh.request('DELETE', `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, deleteBody);
			} else {
				await deleteItemAtomically({
					collection,
					filename,
					gh,
					owner: REPO_OWNER,
					repo: REPO_NAME,
					branch: REPO_BRANCH,
					sha
				});
			}

			return json(200, { success: true, target }, headers);
		} else if (action === 'regenerate-json') {
			console.log(`📦 Rigenerazione JSON manuale per collection: ${collection}`);
			await regenerateJSON(collection, gh, REPO_OWNER, REPO_NAME, REPO_BRANCH);

			return json(200, { success: true, target }, headers);
		} else if (action === 'batch-set-visibility') {
			// ========================================
			// BATCH VISIBILITY: un commit atomico (niente N PUT + regenerate separato)
			// Patch SOLO `visibile` leggendo i .md reali — prezzi/altri campi intatti.
			// ========================================
			const visItems = body.items; // [{ filename }]
			const nextVisible = body.visibile === true || body.visibile === 'true';
			if (!collection || !Array.isArray(visItems) || !visItems.length) {
				return json(400, { error: 'Missing collection or items' }, headers);
			}

			const filenames = visItems.map((i: any) => i.filename || i).filter(Boolean);
			const allItems = await readCollectionSnapshot(collection, gh, REPO_OWNER, REPO_NAME)
				|| await readCollectionFiles(collection, gh, REPO_OWNER, REPO_NAME);

			if (!Array.isArray(allItems)) {
				return json(404, { error: 'Collection not found' }, headers);
			}

			const treeEntries: TreeEntry[] = [];
			let updatedCount = 0;
			const byFile = new Map(allItems.map(i => [i._filename, i]));
			const expectedShas: { path: string; sha: string }[] = []; // OCC: blob SHA letti prima del commit

			for (const fname of filenames) {
				let mdData: ItemRecord;
				let blobSha: string | null = null;
				const repoPath = `${collection}/${fname}`;
				try {
					const meta = await readRepoFileWithMeta(repoPath, gh, REPO_OWNER, REPO_NAME);
					mdData = parseFrontmatter(meta.content) || {};
					blobSha = meta.sha;
				} catch (e) {
					console.warn(`[batch-set-visibility] skip ${fname}: ${(e as Error).message}`);
					continue;
				}

				const currentVis = mdData.visibile !== false; // default true se assente
				if (currentVis === nextVisible) {
					// Allinea comunque lo snapshot in memoria
					if (byFile.has(fname)) byFile.get(fname)!.visibile = nextVisible;
					continue;
				}

				mdData.visibile = nextVisible;
				if (byFile.has(fname)) {
					byFile.get(fname)!.visibile = nextVisible;
				}

				// OCC solo per blob che stiamo davvero riscrivendo
				if (blobSha) expectedShas.push({ path: repoPath, sha: blobSha });

				treeEntries.push({
					path: repoPath,
					mode: '100644',
					type: 'blob',
					content: generateMarkdown(mdData)
				});
				updatedCount++;
			}

			if (treeEntries.length === 0) {
				return json(200, { success: true, updated: 0, target }, headers);
			}

			// JSON aggregato nello stesso commit (da snapshot aggiornato in memoria)
			const sorted = [...byFile.values()].sort((a, b) => (a.order || 0) - (b.order || 0));
			if (collection === 'categorie') {
				treeEntries.push({
					path: 'categorie/categorie.json',
					mode: '100644',
					type: 'blob',
					content: JSON.stringify({
						categories: sorted,
						foodCategories: sorted.filter(c => c.tipo_menu === 'food'),
						beverageCategories: sorted.filter(c => c.tipo_menu === 'beverage')
					}, null, 2)
				});
			} else {
				const cfg = await resolveCollectionConfig(collection, gh, REPO_OWNER, REPO_NAME, {
					[collection]: sorted
				});
				if (cfg) {
					const jsonContent = await generateJSONForConfig(cfg, gh, REPO_OWNER, REPO_NAME, {
						[collection]: sorted
					});
					if (jsonContent) {
						treeEntries.push({
							path: cfg.jsonPath,
							mode: '100644',
							type: 'blob',
							content: JSON.stringify(jsonContent, null, 2)
						});
					}
				}
			}

			await createCommitFromEntries({
				gh,
				owner: REPO_OWNER,
				repo: REPO_NAME,
				message: `CMS: Batch visibility ${collection} (${updatedCount} → ${nextVisible ? 'visible' : 'hidden'})`,
				treeEntries,
				branch: REPO_BRANCH,
				preCommitCheck: makeBatchOccRecheck(expectedShas, gh, REPO_OWNER, REPO_NAME, REPO_BRANCH)
			});

			console.log(`✅ Batch visibility: ${updatedCount} in ${collection}`);

			return json(200, { success: true, updated: updatedCount, target }, headers);

		} else if (action === 'batch-save-order') {
			// ========================================
			// BATCH REORDER: un commit atomico.
			// SICUREZZA CONTENUTI: per ogni file con order cambiato si legge il .md reale
			// e si patcha SOLO `order` — mai dump dell'intero record JSON (evita prezzi/testi stale).
			// ========================================
			const orderItems = body.items;
			if (!collection || !orderItems || !orderItems.length) {
				return json(400, { error: 'Missing collection or items' }, headers);
			}

			const BRANCH = REPO_BRANCH;
			const orderMap = new Map<string, unknown>(orderItems.map((i: any) => [i.filename, i.order]));

			// Snapshot JSON per ricostruire il JSON aggregato (1 GET). Fallback MD se manca.
			const allItems = await readCollectionSnapshot(collection, gh, REPO_OWNER, REPO_NAME)
				|| await readCollectionFiles(collection, gh, REPO_OWNER, REPO_NAME);

			if (!Array.isArray(allItems)) {
				return json(404, { error: 'Collection not found' }, headers);
			}

			const treeEntries: TreeEntry[] = [];
			let updatedCount = 0;
			const expectedShas: { path: string; sha: string }[] = []; // OCC: blob SHA letti prima del commit

			for (const item of allItems) {
				const newOrder = orderMap.get(item._filename);
				if (newOrder === undefined || Number(newOrder) === Number(item.order || 0)) {
					continue;
				}

				// Leggi markdown autoritativo e patcha solo order
				let mdData: ItemRecord;
				let blobSha: string | null = null;
				const repoPath = `${collection}/${item._filename}`;
				try {
					const meta = await readRepoFileWithMeta(repoPath, gh, REPO_OWNER, REPO_NAME);
					mdData = parseFrontmatter(meta.content) || {};
					blobSha = meta.sha;
				} catch (e) {
					console.warn(`[batch-save-order] skip ${item._filename}: ${(e as Error).message}`);
					continue;
				}

				mdData.order = Number.parseInt(String(newOrder), 10) || 0;
				item.order = mdData.order;

				if (blobSha) expectedShas.push({ path: repoPath, sha: blobSha });

				treeEntries.push({
					path: repoPath,
					mode: '100644',
					type: 'blob',
					content: generateMarkdown(mdData)
				});
				updatedCount++;
			}

			if (treeEntries.length === 0) {
				return json(200, { success: true, updated: 0, target }, headers);
			}

			const sorted = [...allItems].sort((a, b) => (a.order || 0) - (b.order || 0));
			let batchConfig = COLLECTION_CONFIG[collection];

			if (!batchConfig) {
				const categories = await readCollectionSnapshot('categorie', gh, REPO_OWNER, REPO_NAME)
					|| await readCollectionFiles('categorie', gh, REPO_OWNER, REPO_NAME);
				const matchedCategory = findBeverageCategoryByFolder(categories, collection);
				if (matchedCategory) {
					batchConfig = {
						jsonPath: 'beverages/beverages.json',
						type: 'beverages',
						folder: getCategoryFolder(matchedCategory),
						name: matchedCategory.nome
					};
				}
			}

			if (batchConfig) {
				let jsonContent = null;

				if (batchConfig.type === 'categories') {
					jsonContent = {
						categories: sorted,
						foodCategories: sorted.filter(c => c.tipo_menu === 'food'),
						beverageCategories: sorted.filter(c => c.tipo_menu === 'beverage')
					};
				} else if (batchConfig.type === 'food') {
					const categories = await readCollectionSnapshot('categorie', gh, REPO_OWNER, REPO_NAME)
						|| await readCollectionFiles('categorie', gh, REPO_OWNER, REPO_NAME);
					const foodCats = categories.filter(c => c.tipo_menu === 'food' && c.visibile !== false);
					const foodByCategory: Record<string, ItemRecord[]> = {};
					foodCats.forEach(cat => { foodByCategory[cat.nome] = []; });
					sorted.forEach(row => {
						const cat = row.category || 'Altro';
						if (!foodByCategory[cat]) foodByCategory[cat] = [];
						foodByCategory[cat].push(row);
					});
					const categoryOrder: Record<string, number> = {};
					foodCats.forEach((cat, idx) => { categoryOrder[cat.nome] = cat.order || idx; });
					jsonContent = { food: sorted, foodByCategory, categoryOrder };
				} else if (batchConfig.type === 'beers') {
					const beersBySection: Record<string, ItemRecord[]> = {};
					sorted.forEach(beer => {
						const sec = beer.sezione || 'Birre alla spina';
						if (!beersBySection[sec]) beersBySection[sec] = [];
						beersBySection[sec].push(beer);
					});
					jsonContent = { beers: sorted, beersBySection };
				} else if (batchConfig.type === 'beverages') {
					// Incremental: aggiorna solo order nella slice di questa cartella
					jsonContent = await generateJSONForConfig(batchConfig, gh, REPO_OWNER, REPO_NAME, {
						[collection]: sorted
					});
				}

				if (jsonContent) {
					treeEntries.push({
						path: batchConfig.jsonPath,
						mode: '100644',
						type: 'blob',
						content: JSON.stringify(jsonContent, null, 2)
					});
				}
			}

			await createCommitFromEntries({
				gh,
				owner: REPO_OWNER,
				repo: REPO_NAME,
				message: `CMS: Reorder ${collection} (${updatedCount} items)`,
				treeEntries,
				branch: BRANCH,
				preCommitCheck: makeBatchOccRecheck(expectedShas, gh, REPO_OWNER, REPO_NAME, BRANCH)
			});

			console.log(`✅ Batch reorder: ${updatedCount} items in ${collection} (order-only MD patch)`);

			return json(200, { success: true, updated: updatedCount, target }, headers);
		}

		return json(400, { error: 'Azione non valida' }, headers);

	} catch (error) {
		console.error('Error:', error);
		if (error instanceof RepoConfigError) {
			return repoConfigErrorResponse(headers, error);
		}
		return json(getErrorStatusCode(error), { error: (error as Error).message || 'Unknown error' }, headers);
	}
}
