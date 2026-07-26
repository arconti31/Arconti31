// Rate limit login in-memory per isolate (best-effort, come su Netlify free tier).
// Su Workers ogni isolate ha la propria Map: protezione parziale ma senza costi extra.

const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_MAX = 10;
const LOGIN_ATTEMPTS_MAX_KEYS = 500;

interface AttemptEntry {
	count: number;
	firstAt: number;
}

const loginAttempts = new Map<string, AttemptEntry>();

/** Evict stale keys; se ancora sopra il cap, rimuovi i più vecchi. */
function pruneLoginAttempts(now = Date.now()): void {
	for (const [k, v] of loginAttempts) {
		if (now - v.firstAt > LOGIN_RATE_WINDOW_MS) loginAttempts.delete(k);
	}
	if (loginAttempts.size <= LOGIN_ATTEMPTS_MAX_KEYS) return;
	const sorted = [...loginAttempts.entries()].sort((a, b) => a[1].firstAt - b[1].firstAt);
	const excess = loginAttempts.size - LOGIN_ATTEMPTS_MAX_KEYS;
	for (let i = 0; i < excess; i++) {
		loginAttempts.delete(sorted[i][0]);
	}
}

export function checkLoginRateLimit(ip: string, email: string): boolean {
	const key = `${ip}|${String(email || '').toLowerCase().trim()}`;
	const now = Date.now();
	pruneLoginAttempts(now);

	let entry = loginAttempts.get(key);
	if (!entry || now - entry.firstAt > LOGIN_RATE_WINDOW_MS) {
		entry = { count: 0, firstAt: now };
		loginAttempts.set(key, entry);
	}
	entry.count += 1;

	return entry.count <= LOGIN_RATE_MAX;
}

export function resetLoginRateLimit(ip: string, email: string): void {
	const key = `${ip}|${String(email || '').toLowerCase().trim()}`;
	loginAttempts.delete(key);
}
