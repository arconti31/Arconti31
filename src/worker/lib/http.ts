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

/** Parse body JSON; ritorna null se non valido */
export async function parseJsonBody(request: Request): Promise<Record<string, any> | null> {
	try {
		const parsed = await request.json();
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
