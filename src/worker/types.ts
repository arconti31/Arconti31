// Tipi condivisi del Worker Arconti31

import type { Fetcher } from '@cloudflare/workers-types';

export interface Env {
	ASSETS: Fetcher;

	// GitHub (repo contenuti)
	REPO_OWNER?: string;
	REPO_NAME?: string;
	GITHUB_BRANCH?: string;
	GITHUB_TOKEN?: string;

	// Login CMS
	ADMIN_EMAIL?: string;
	ADMIN_PASSWORD?: string;
	CMS_TOKEN_SECRET?: string;
	TOKEN_SECRET?: string;

	// Cloudinary
	CLOUDINARY_CLOUD_NAME?: string;
	CLOUDINARY_UPLOAD_PRESET?: string;
	CLOUDINARY_FOLDER?: string;
	CLOUDINARY_API_KEY?: string;
	CLOUDINARY_API_SECRET?: string;

	// CORS extra
	ALLOWED_ORIGINS?: string;
}

/** Record generico di un item del menù (frontmatter parsato) */
export type ItemRecord = Record<string, any>;

export class RepoConfigError extends Error {
	code = 'REPO_CONFIG_MISSING' as const;
}
