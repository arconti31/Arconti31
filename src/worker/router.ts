// Router del Worker: /api/* + alias legacy /.netlify/functions/* (stessi handler,
// nessuna logica duplicata) + fallback SPA per /admin/* via ASSETS.

import type { Env } from './types';
import { handleHealth } from './routes/health';
import { handleAuthLogin, handleAuthVerify } from './routes/auth';
import { handleReadData } from './routes/read-data';
import { handleSaveData } from './routes/save-data';
import { handleCloudinarySignature } from './routes/cloudinary-signature';
import { handleUploadImage } from './routes/upload-image';
import { handleBumpCacheVersion } from './routes/bump-cache-version';
import { json } from './lib/http';

type RouteHandler = (request: Request, env: Env) => Promise<Response>;

const ROUTES: Record<string, RouteHandler> = {
	// Endpoint canonici
	'/api/health': handleHealth,
	'/api/auth/login': handleAuthLogin,
	'/api/auth/verify': handleAuthVerify,
	'/api/read-data': handleReadData,
	'/api/save-data': handleSaveData,
	'/api/cloudinary-signature': handleCloudinarySignature,
	'/api/upload-image': handleUploadImage,
	'/api/bump-cache-version': handleBumpCacheVersion,

	// Alias legacy temporanei (client con Service Worker in cache) — stessi handler
	'/.netlify/functions/health': handleHealth,
	'/.netlify/functions/read-data': handleReadData,
	'/.netlify/functions/save-data': handleSaveData,
	'/.netlify/functions/upload-image': handleUploadImage,
	'/.netlify/functions/bump-cache-version': handleBumpCacheVersion
};

export async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const pathname = url.pathname.replace(/\/+$/, '') || '/';

	const handler = ROUTES[pathname];
	if (handler) {
		return handler(request, env);
	}

	// API sconosciuta → 404 JSON (non fallback agli asset)
	if (pathname.startsWith('/api/') || pathname.startsWith('/.netlify/')) {
		return json(404, { error: 'Not found' });
	}

	// /admin/*: prova asset statico, su 404 fallback SPA a /admin/index.html
	if (pathname === '/admin' || pathname.startsWith('/admin/')) {
		const assetResponse = await env.ASSETS.fetch(request);
		if (assetResponse.status !== 404) {
			return assetResponse;
		}
		const indexUrl = new URL('/admin/index.html', url.origin);
		return env.ASSETS.fetch(new Request(indexUrl.toString(), { headers: request.headers }));
	}

	// Tutto il resto è servito dagli asset statici
	return env.ASSETS.fetch(request);
}
