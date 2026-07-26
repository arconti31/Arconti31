// Helper HTTP condivisi

/** Risposta JSON con status e header extra */
export function json(status: number, data: unknown, extraHeaders: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...extraHeaders
		}
	});
}

/** Risposta di testo semplice (es. 405 Method Not Allowed) */
export function text(status: number, body: string, extraHeaders: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: extraHeaders });
}

/** Body oltre il quale non vale nemmeno la pena parsare (payload CMS sono piccoli). */
export const DEFAULT_MAX_BODY_BYTES = 512 * 1024;

export class BodyTooLargeError extends Error {
	code = 'BODY_TOO_LARGE' as const;
}

/**
 * Parse body JSON; ritorna null se non valido.
 * Rifiuta i body oltre `maxBytes` PRIMA di deserializzare: prima si controlla
 * Content-Length (rifiuto immediato), poi la dimensione reale del testo letto
 * (Content-Length può mancare su transfer chunked).
 */
export async function parseJsonBody(
	request: Request,
	maxBytes: number = DEFAULT_MAX_BODY_BYTES
): Promise<Record<string, any> | null> {
	const declared = Number(request.headers.get('content-length') || '');
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new BodyTooLargeError(`Body troppo grande (max ${maxBytes} byte)`);
	}

	let raw: string;
	try {
		raw = await request.text();
	} catch {
		return null;
	}

	if (raw.length > maxBytes) {
		throw new BodyTooLargeError(`Body troppo grande (max ${maxBytes} byte)`);
	}

	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, any>;
		}
		return null;
	} catch {
		return null;
	}
}

/** IP client affidabile su Cloudflare */
export function getClientIp(request: Request): string {
	const cfIp = request.headers.get('CF-Connecting-IP');
	if (cfIp) return cfIp.trim();
	const xff = request.headers.get('X-Forwarded-For') || '';
	if (xff) return xff.split(',')[0].trim();
	return 'unknown';
}

/** Token Bearer dall'header Authorization, con fallback dal body */
export function getBearerToken(request: Request, bodyToken?: string): string {
	const authHeader = request.headers.get('Authorization') || '';
	if (authHeader) return authHeader.replace('Bearer ', '').trim();
	return (bodyToken || '').trim();
}

export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
