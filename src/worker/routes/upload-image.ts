// /api/upload-image — relay legacy (Base64 → Cloudinary) mantenuto per i client
// CMS con Service Worker in cache che non hanno ancora il nuovo flusso diretto.
// Su Workers usa fetch + FormData nativi invece di https.request.
// Condivide la firma con lib/cloudinary (stessa usata da /api/cloudinary-signature).

import type { Env } from '../types';
import { verifyToken } from '../lib/auth';
import { getCloudinaryConfig, signCloudinaryUpload } from '../lib/cloudinary';
import { corsHeaders } from '../lib/cors';
import { json, parseJsonBody, text } from '../lib/http';

// ~4.5MB stima per length stringa (data URL / base64)
const MAX_FILE_LENGTH = Math.floor(4.5 * 1024 * 1024);

function isValidImagePayload(file: unknown): file is string {
	if (typeof file !== 'string' || !file.length) return false;
	// data URL oppure base64 grezzo
	if (file.startsWith('data:')) {
		// data:[mime];base64,<payload>
		const comma = file.indexOf(',');
		if (comma < 0) return false;
		const meta = file.slice(0, comma);
		if (!meta.includes('base64')) return false;
		return true;
	}
	// base64 grezzo: caratteri ammessi
	return /^[A-Za-z0-9+/=\s]+$/.test(file.slice(0, 200));
}

export async function handleUploadImage(request: Request, env: Env): Promise<Response> {
	const headers = corsHeaders(request, env);

	// Handle CORS preflight
	if (request.method === 'OPTIONS') {
		return text(200, '', headers);
	}
	if (request.method !== 'POST') {
		return text(405, 'Method Not Allowed', headers);
	}

	const parsed = await parseJsonBody(request);
	if (!parsed) {
		return json(400, { error: 'JSON non valido' }, headers);
	}

	const { token, file } = parsed;

	const userEmail = verifyToken(env, token);
	if (!userEmail) {
		return json(401, { error: 'Token non valido' }, headers);
	}

	if (!isValidImagePayload(file)) {
		return json(400, { error: 'File non valido: attendi data URL o base64' }, headers);
	}

	if (file.length > MAX_FILE_LENGTH) {
		return json(413, { error: 'File troppo grande (max ~4.5MB)' }, headers);
	}

	const config = getCloudinaryConfig(env);
	if (!config) {
		return json(500, {
			error: 'Cloudinary non configurato. Aggiungi CLOUDINARY_API_KEY e CLOUDINARY_API_SECRET al Worker.'
		}, headers);
	}

	try {
		// Signed upload: firma condivisa con /api/cloudinary-signature
		const timestamp = Math.round(Date.now() / 1000);
		const signature = signCloudinaryUpload(config.folder, timestamp, config.apiSecret);

		const form = new FormData();
		form.append('file', file);
		form.append('api_key', config.apiKey);
		form.append('timestamp', String(timestamp));
		form.append('signature', signature);
		form.append('folder', config.folder);

		const response = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`, {
			method: 'POST',
			body: form
		});

		let responseBody: any;
		try {
			responseBody = await response.json();
		} catch {
			responseBody = { error: { message: await response.text().catch(() => 'Upload failed') } };
		}

		if (response.ok) {
			return json(200, {
				success: true,
				url: responseBody.secure_url,
				public_id: responseBody.public_id
			}, headers);
		}

		return json(response.status, { error: responseBody.error?.message || 'Upload failed' }, headers);
	} catch (error) {
		console.error('Upload error:', error);
		return json(500, { error: (error as Error).message }, headers);
	}
}
