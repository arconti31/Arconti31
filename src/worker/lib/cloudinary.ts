// Firma Cloudinary condivisa (signature-only endpoint + relay legacy)

import { createHash } from 'node:crypto';
import type { Env } from '../types';

export interface CloudinaryConfig {
	cloudName: string;
	apiKey: string;
	apiSecret: string;
	folder: string;
}

export function getCloudinaryConfig(env: Env): CloudinaryConfig | null {
	const cloudName = (env.CLOUDINARY_CLOUD_NAME || '').trim();
	const apiKey = (env.CLOUDINARY_API_KEY || '').trim();
	const apiSecret = (env.CLOUDINARY_API_SECRET || '').trim();
	const folder = (env.CLOUDINARY_FOLDER || 'arconti31').trim();
	if (!cloudName || !apiKey || !apiSecret) return null;
	return { cloudName, apiKey, apiSecret, folder };
}

/**
 * Firma per signed upload: SHA-1 di `folder=X&timestamp=Y` + api_secret
 * (parametri in ordine alfabetico, come da spec Cloudinary).
 */
export function signCloudinaryUpload(folder: string, timestamp: number, apiSecret: string): string {
	const signatureString = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
	return createHash('sha1').update(signatureString).digest('hex');
}
