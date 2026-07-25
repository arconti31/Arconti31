// Config repository GitHub — REPO_OWNER e REPO_NAME obbligatori, nessun default

import type { Env } from '../types';
import { RepoConfigError } from '../types';

export interface RepoConfig {
	owner: string;
	repo: string;
	branch: string;
}

export function resolveRepoConfig(env: Env): RepoConfig {
	const owner = (env.REPO_OWNER || '').trim();
	const repo = (env.REPO_NAME || '').trim();
	const branch = (env.GITHUB_BRANCH || 'main').trim() || 'main';

	if (!owner || !repo) {
		throw new RepoConfigError(
			'Configurazione repository mancante: imposta REPO_OWNER e REPO_NAME nelle variabili del Worker.'
		);
	}

	return { owner, repo, branch };
}
