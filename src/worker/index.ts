// Entry point Worker Arconti31 — Cloudflare Workers + Static Assets.
// API CMS su /api/*, asset statici via ASSETS.

import type { Env } from './types';
import { route } from './router';
import { json } from './lib/http';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			return await route(request, env);
		} catch (error) {
			// Ultima linea di difesa: mai 1101 senza log strutturato
			console.error('[worker] Unhandled error:', error);
			return json(500, { error: 'Internal Server Error' });
		}
	}
};
