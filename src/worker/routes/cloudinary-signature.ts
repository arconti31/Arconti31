// /api/cloudinary-signature — NUOVO endpoint per upload diretto dal browser.
// Il Worker firma i parametri (folder, timestamp) con l'API secret;
// il file NON transita più dal server (niente relay Base64).

import type { Env } from '../types';
import { verifyToken } from '../lib/auth';
import { getCloudinaryConfig, signCloudinaryUpload } from '../lib/cloudinary';
import { corsHeaders } from '../lib/cors';
import { getBearerToken, json, parseJsonBody, text } from '../lib/http';

export async function handleCloudinarySignature(request: Request, env: Env): Promise<Response> {
	const headers = corsHeaders(request, env);

	if (request.method === 'OPTIONS') {
		return text(200, '', headers);
	}
	if (request.method !== 'POST') {
		return text(405, 'Method Not Allowed', headers);
	}

	const body = (await parseJsonBody(request)) || {};

	const incomingToken = getBearerToken(request, body.token);
	const userEmail = verifyToken(env, incomingToken);
	if (!userEmail) {
		return json(401, { error: 'Token non valido' }, headers);
	}

	const config = getCloudinaryConfig(env);
	if (!config) {
		return json(500, {
			error: 'Cloudinary non configurato. Aggiungi CLOUDINARY_API_KEY e CLOUDINARY_API_SECRET al Worker.'
		}, headers);
	}

	const timestamp = Math.round(Date.now() / 1000);
	const signature = signCloudinaryUpload(config.folder, timestamp, config.apiSecret);

	// Il client invia FormData a https://api.cloudinary.com/v1_1/<cloudName>/image/upload
	// con: file, api_key, timestamp, signature, folder
	return json(200, {
		cloudName: config.cloudName,
		apiKey: config.apiKey,
		timestamp,
		signature,
		folder: config.folder,
		uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`
	}, headers);
}
