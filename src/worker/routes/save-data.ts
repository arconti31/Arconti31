// /api/save-data — scritture del CMS.
//
// Action supportate: login, verify-token, get-cloudinary-config, whoami,
// save, delete, batch-set-visibility, batch-save-order.
//
// Rimosse rispetto alla versione Netlify:
// - `regenerate-json`: la rigenerazione completa costa 1 GET per ogni .md
//   (beers/ da sola ne ha oltre cento) e sfonda il tetto di 50 subrequest del
//   piano free, morendo a metà. È un'operazione di recovery, non interattiva:
//   si esegue con `npm run build:data` e si committa il risultato.
// - `skipRegeneration`: permetteva al browser di committare un .md senza
//   aggiornare il JSON aggregato, cioè di lasciare il menù pubblico disallineato.
//
// Costo GitHub per salvataggio (caso normale, senza conflitti):
//   1 GET /branches (pinna il commit) + 1-2 GET snapshot JSON + 1 GET del .md
//   + POST tree + POST commit + PATCH ref. La cache per-richiesta del client
//   evita di rileggere lo stesso path due volte.

import { parseFrontmatter } from '../../../lib/menu-utils.js';
import type { Env, ItemRecord } from '../types';
import { RepoConfigError } from '../types';
import { verifyToken } from '../lib/auth';
import { resolveRepoConfig } from '../lib/repo-config';
import { GithubClient } from '../lib/github';
import { corsHeaders } from '../lib/cors';
import { BodyTooLargeError, getBearerToken, json, parseJsonBody, text } from '../lib/http';
import { MAX_BATCH_ITEMS, MAX_BODY_BYTES, ValidationError, parseSaveDataRequest } from '../lib/validate';
import { loginFromBody } from './auth';
import {
	type TreeEntry,
	NotFoundError,
	assertSafeCategoryDelete,
	assertSafeCategorySave,
	buildJsonTreeEntry,
	createCommitTransaction,
	deleteItemAtomically,
	generateMarkdown,
	getErrorStatusCode,
	getSafeErrorMessage,
	prepareDataForSave,
	readCollectionFiles,
	readCollectionSnapshot,
	saveItemAtomically
} from '../lib/collections';

/**
 * Tetto per i batch, allineato a MAX_BATCH_ITEMS della validazione.
 * I .md di un batch vengono letti in blocco via GraphQL (100 per chiamata), non
 * uno per uno: un riordino dell'intera carta birre (112 prodotti) resta UN solo
 * commit e costa una decina di chiamate GitHub, ampiamente sotto il limite di
 * 50 subrequest del Worker.
 */
const MAX_BATCH_PER_REQUEST = MAX_BATCH_ITEMS;

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

	let body: Record<string, any> | null;
	try {
		body = await parseJsonBody(request, MAX_BODY_BYTES);
	} catch (error) {
		if (error instanceof BodyTooLargeError) {
			return json(413, { error: error.message }, headers);
		}
		throw error;
	}
	if (!body) {
		return json(400, { error: 'JSON non valido' }, headers);
	}

	// Login prima della validazione di schema: ha un payload proprio (email/password)
	if (body.action === 'login') {
		return loginFromBody(request, env, body, headers);
	}

	// Schema chiuso per action: mai `.includes()` su un campo di tipo ignoto
	let parsed;
	try {
		parsed = parseSaveDataRequest(body);
	} catch (error) {
		if (error instanceof ValidationError) {
			return json(400, { error: error.message }, headers);
		}
		throw error;
	}

	// ==========================================
	// VERIFICA TOKEN (Middleware) — tutte le action non-login
	// ==========================================
	const incomingToken = getBearerToken(request, body.token);
	const userEmail = verifyToken(env, incomingToken);

	if (!userEmail) {
		return json(401, { error: 'Sessione scaduta o non valida' }, headers);
	}

	if (parsed.action === 'verify-token') {
		return json(200, { valid: true, email: userEmail }, headers);
	}

	if (parsed.action === 'get-cloudinary-config') {
		return json(200, {
			cloudName: env.CLOUDINARY_CLOUD_NAME || '',
			uploadPreset: env.CLOUDINARY_UPLOAD_PRESET || ''
		}, headers);
	}

	// Config repo (fail-loud) — serve anche a whoami
	let target: { owner: string; repo: string; branch: string };
	try {
		target = resolveRepoConfig(env);
	} catch (error) {
		if (error instanceof RepoConfigError) {
			return repoConfigErrorResponse(headers, error);
		}
		throw error;
	}

	if (parsed.action === 'whoami') {
		return json(200, {
			ok: true,
			target,
			hasToken: !!(env.GITHUB_TOKEN || '').trim()
		}, headers);
	}

	const GITHUB_TOKEN = env.GITHUB_TOKEN;
	if (!GITHUB_TOKEN) {
		return json(500, { error: 'GITHUB_TOKEN non configurato nelle variabili del Worker' }, headers);
	}

	// Cache GET e budget subrequest incapsulati nel client (niente stato globale)
	const gh = new GithubClient(GITHUB_TOKEN, target);

	try {
		// Un'unica GET /branches per tutta la richiesta: pinna il ref, così ogni
		// lettura successiva vede lo STESSO commit e createCommitTransaction non
		// deve rileggere HEAD al primo tentativo.
		const head = await gh.syncBranchHead();

		switch (parsed.action) {
			case 'save': {
				const { collection, filename, data, sha } = parsed;
				const preparedData = await prepareDataForSave(gh, collection, data, { filename, sha });
				await assertSafeCategorySave(gh, collection, filename, preparedData, sha);

				const result = await saveItemAtomically({
					gh, collection, filename, data: preparedData, sha, head
				});

				return json(200, { success: true, sha: result.content.sha, target }, headers);
			}

			case 'delete': {
				const { collection, filename, sha } = parsed;
				await assertSafeCategoryDelete(gh, collection, filename);
				await deleteItemAtomically({ gh, collection, filename, sha, head });

				return json(200, { success: true, target }, headers);
			}

			case 'batch-set-visibility': {
				const updated = await runBatchVisibility(gh, parsed, head);
				return json(200, { success: true, updated, target }, headers);
			}

			case 'batch-save-order': {
				const updated = await runBatchOrder(gh, parsed, head);
				return json(200, { success: true, updated, target }, headers);
			}
		}

		return json(400, { error: 'Azione non valida' }, headers);

	} catch (error) {
		// Log completo lato Worker, messaggio sanificato verso il browser:
		// i body GitHub possono contenere path e dettagli del repository.
		console.error(`[save-data] action=${parsed.action}:`, error);
		if (error instanceof RepoConfigError) {
			return repoConfigErrorResponse(headers, error);
		}
		return json(getErrorStatusCode(error), { error: getSafeErrorMessage(error) }, headers);
	}
}

/** Errore uniforme quando il client manda un batch più grande del budget. */
function assertBatchSize(count: number): void {
	if (count > MAX_BATCH_PER_REQUEST) {
		throw new ValidationError(
			`Troppi elementi in un solo batch (${count}, max ${MAX_BATCH_PER_REQUEST}). Dividi l'operazione.`
		);
	}
}

/**
 * BATCH VISIBILITY — un solo commit atomico.
 * Patcha SOLO `visibile` leggendo i .md reali: prezzi e testi restano intatti.
 * L'intero calcolo sta dentro `build`, quindi su retry riparte da HEAD fresco.
 */
async function runBatchVisibility(
	gh: GithubClient,
	parsed: { collection: string; filenames: string[]; visibile: boolean },
	head: Awaited<ReturnType<GithubClient['syncBranchHead']>>
): Promise<number> {
	const { collection, filenames, visibile } = parsed;
	assertBatchSize(filenames.length);

	let updatedCount = 0;

	await createCommitTransaction({
		gh,
		head,
		message: `CMS: Batch visibility ${collection} (${filenames.length} → ${visibile ? 'visible' : 'hidden'})`,
		build: async () => {
			updatedCount = 0;
			const allItems = (await readCollectionSnapshot(gh, collection))
				|| await readCollectionFiles(gh, collection);
			const byFile = new Map(allItems.map(item => [item._filename, item]));

			// Solo i file che lo snapshot dice essere da cambiare, letti tutti insieme
			const candidates = filenames.filter(filename => {
				const snapshotItem = byFile.get(filename);
				return !snapshotItem || (snapshotItem.visibile !== false) !== visibile;
			});
			const contents = await gh.readFilesBatch(candidates.map(f => `${collection}/${f}`));

			const treeEntries: TreeEntry[] = [];
			for (const filename of candidates) {
				const repoPath = `${collection}/${filename}`;
				const file = contents.get(repoPath);
				// Fail-closed: un file atteso e non trovato non si salta in silenzio
				if (!file) throw new NotFoundError(`File non trovato: ${repoPath}`);

				const mdData: ItemRecord = parseFrontmatter(file.content) || {};
				const snapshotItem = byFile.get(filename);
				if (snapshotItem) snapshotItem.visibile = visibile;
				if ((mdData.visibile !== false) === visibile) continue;

				mdData.visibile = visibile;
				treeEntries.push({
					path: repoPath,
					mode: '100644',
					type: 'blob',
					content: generateMarkdown(mdData)
				});
				updatedCount++;
			}

			if (treeEntries.length === 0) return [];

			const sorted = [...byFile.values()].sort((a, b) => (a.order || 0) - (b.order || 0));
			const jsonEntry = await buildJsonTreeEntry(gh, collection, { [collection]: sorted });
			if (jsonEntry) treeEntries.push(jsonEntry);

			return treeEntries;
		}
	});

	return updatedCount;
}

/**
 * BATCH REORDER — un solo commit atomico.
 * Per ogni file con `order` cambiato si legge il .md reale e si patcha SOLO
 * `order`: mai un dump dell'intero record JSON, che potrebbe essere stale.
 */
async function runBatchOrder(
	gh: GithubClient,
	parsed: { collection: string; items: { filename: string; order: number }[] },
	head: Awaited<ReturnType<GithubClient['syncBranchHead']>>
): Promise<number> {
	const { collection, items } = parsed;
	assertBatchSize(items.length);

	const orderMap = new Map(items.map(item => [item.filename, item.order]));
	let updatedCount = 0;

	await createCommitTransaction({
		gh,
		head,
		message: `CMS: Reorder ${collection} (${items.length} items)`,
		build: async () => {
			updatedCount = 0;
			const allItems = (await readCollectionSnapshot(gh, collection))
				|| await readCollectionFiles(gh, collection);

			// Solo gli item con `order` davvero diverso, letti in un colpo solo:
			// un riordino da 95 prodotti costa 1 chiamata di lettura, non 95.
			const changed = allItems.filter(item => {
				const newOrder = orderMap.get(item._filename);
				return newOrder !== undefined && newOrder !== Number(item.order || 0);
			});
			const contents = await gh.readFilesBatch(changed.map(i => `${collection}/${i._filename}`));

			const treeEntries: TreeEntry[] = [];
			for (const item of changed) {
				const repoPath = `${collection}/${item._filename}`;
				const file = contents.get(repoPath);
				if (!file) throw new NotFoundError(`File non trovato: ${repoPath}`);

				const newOrder = orderMap.get(item._filename)!;
				const mdData: ItemRecord = parseFrontmatter(file.content) || {};
				mdData.order = newOrder;
				item.order = newOrder;

				treeEntries.push({
					path: repoPath,
					mode: '100644',
					type: 'blob',
					content: generateMarkdown(mdData)
				});
				updatedCount++;
			}

			if (treeEntries.length === 0) return [];

			const sorted = [...allItems].sort((a, b) => (a.order || 0) - (b.order || 0));
			const jsonEntry = await buildJsonTreeEntry(gh, collection, { [collection]: sorted });
			if (jsonEntry) treeEntries.push(jsonEntry);

			return treeEntries;
		}
	});

	return updatedCount;
}
