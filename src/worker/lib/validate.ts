// Validazione dei payload /api/save-data.
//
// Prima di questo modulo il body veniva destrutturato "as is" e campi come
// `collection` finivano direttamente in `.includes(...)`: un `{"collection": {}}`
// produceva un TypeError → 500 invece di un 400 pulito. Qui ogni action ha uno
// schema chiuso e tipizzato, così il router lavora su dati già validati.
//
// `skipRegeneration` NON esiste più come campo di input: saltare la rigenerazione
// del JSON aggregato era una scelta interna, non un'opzione del browser (permetteva
// di committare un .md lasciando il JSON pubblico disallineato).

import type { ItemRecord } from '../types';

/** Limiti volutamente stretti: i payload del CMS sono piccoli. */
export const MAX_BODY_BYTES = 512 * 1024;
export const MAX_BATCH_ITEMS = 500;

const COLLECTION_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const FILENAME_RE = /^[a-z0-9][a-z0-9-]{0,119}\.md$/;

export class ValidationError extends Error {
	code = 'VALIDATION_ERROR' as const;
}

export type SaveDataRequest =
	| { action: 'login' }
	| { action: 'verify-token' }
	| { action: 'get-cloudinary-config' }
	| { action: 'whoami' }
	| { action: 'save'; collection: string; filename: string; data: ItemRecord; sha: string | null }
	| { action: 'delete'; collection: string; filename: string; sha: string }
	| { action: 'batch-set-visibility'; collection: string; filenames: string[]; visibile: boolean }
	| { action: 'batch-save-order'; collection: string; items: { filename: string; order: number }[] };

export type SaveDataAction = SaveDataRequest['action'];

const KNOWN_ACTIONS: readonly SaveDataAction[] = [
	'login',
	'verify-token',
	'get-cloudinary-config',
	'whoami',
	'save',
	'delete',
	'batch-set-visibility',
	'batch-save-order'
];

function isKnownAction(value: unknown): value is SaveDataAction {
	return typeof value === 'string' && (KNOWN_ACTIONS as readonly string[]).includes(value);
}

function fail(message: string): never {
	throw new ValidationError(message);
}

function requireCollection(value: unknown): string {
	if (typeof value !== 'string' || !COLLECTION_RE.test(value)) {
		fail('Collection non valida');
	}
	return value;
}

function requireFilename(value: unknown): string {
	if (typeof value !== 'string' || !FILENAME_RE.test(value)) {
		fail('Filename non valido');
	}
	return value;
}

function optionalSha(value: unknown): string | null {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value !== 'string' || value.length > 100) {
		fail('SHA non valido');
	}
	return value;
}

function requireDataObject(value: unknown): ItemRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		fail('Payload non valido');
	}
	return value as ItemRecord;
}

function requireBatchArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value) || value.length === 0) {
		fail(`Nessun elemento in ${label}`);
	}
	if (value.length > MAX_BATCH_ITEMS) {
		fail(`Troppi elementi in ${label} (max ${MAX_BATCH_ITEMS})`);
	}
	return value;
}

/**
 * Valida il body e restituisce una richiesta tipizzata.
 * Lancia ValidationError (→ 400) su qualunque forma inattesa.
 */
export function parseSaveDataRequest(body: Record<string, any>): SaveDataRequest {
	const action: unknown = body.action;
	if (!isKnownAction(action)) {
		fail('Azione non valida');
	}

	switch (action) {
		case 'login':
		case 'verify-token':
		case 'get-cloudinary-config':
		case 'whoami':
			return { action };

		case 'save':
			return {
				action,
				collection: requireCollection(body.collection),
				filename: requireFilename(body.filename),
				data: requireDataObject(body.data),
				sha: optionalSha(body.sha)
			};

		case 'delete': {
			const sha = optionalSha(body.sha);
			if (!sha) fail('SHA mancante per eliminazione');
			return {
				action,
				collection: requireCollection(body.collection),
				filename: requireFilename(body.filename),
				sha
			};
		}

		case 'batch-set-visibility': {
			const raw = requireBatchArray(body.items, 'items');
			const filenames = raw.map((entry: any) =>
				requireFilename(typeof entry === 'string' ? entry : entry?.filename)
			);
			return {
				action,
				collection: requireCollection(body.collection),
				filenames,
				visibile: body.visibile === true || body.visibile === 'true'
			};
		}

		case 'batch-save-order': {
			const raw = requireBatchArray(body.items, 'items');
			const items = raw.map((entry: any) => {
				const filename = requireFilename(entry?.filename);
				const order = Number.parseInt(String(entry?.order), 10);
				if (!Number.isFinite(order)) fail(`Order non valido per ${filename}`);
				return { filename, order };
			});
			return { action, collection: requireCollection(body.collection), items };
		}
	}
}
