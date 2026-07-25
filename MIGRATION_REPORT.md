# 📋 Report Migrazione: Netlify → Cloudflare Workers

**Branch**: `migration/cloudflare-workers` (main non toccato)
**Data**: 26 luglio 2026
**Motivo**: crediti free Netlify esauriti, sito sospeso. Target: Cloudflare Workers + Static Assets (piano free).

Guida operativa (deploy, DNS, rollback): [`CLOUDFLARE_DEPLOY.md`](./CLOUDFLARE_DEPLOY.md)

---

## 1. Architettura risultante

- **Sito pubblico**: asset statici serviti da Cloudflare (binding `ASSETS`, directory `dist/`
  generata da build con allowlist esplicita)
- **Backend CMS**: un unico Worker TypeScript (`src/worker/`) che gestisce `/api/*`,
  gli alias legacy `/.netlify/functions/*` e il fallback SPA di `/admin/*`
  (`run_worker_first` in `wrangler.jsonc`)
- **Dati**: invariati — file `.md` + JSON aggregati su GitHub, commit atomici via Git Trees API,
  optimistic concurrency (SHA → 409), Cloudinary per le immagini
- **Semantica di `save-data` preservata 1:1** (nessun refactor: stessi messaggi di errore,
  stessi status code, stessa rigenerazione JSON)

## 2. File creati

| File | Scopo |
|------|-------|
| `wrangler.jsonc` | Config Worker: nodejs_compat, assets dist/, run_worker_first, observability |
| `tsconfig.worker.json` | Typecheck del Worker |
| `.dev.vars.example` | Template variabili locali (nomi identici a Netlify) |
| `src/worker/index.ts` | Entry point |
| `src/worker/router.ts` | Routing `/api/*` + alias legacy + fallback asset/admin |
| `src/worker/types.ts` | Tipi `Env` |
| `src/worker/routes/health.ts` | Liveness pubblica + diagnostica autenticata |
| `src/worker/routes/auth.ts` | `/api/auth/login`, `/api/auth/verify` |
| `src/worker/routes/read-data.ts` | Lettura pubblica da JSON statici / API GitHub autenticata |
| `src/worker/routes/save-data.ts` | Port completo della function Netlify (save/delete/login/verify/…) |
| `src/worker/routes/cloudinary-signature.ts` | Firma per upload diretto browser→Cloudinary |
| `src/worker/routes/upload-image.ts` | Relay Base64 legacy (fallback) |
| `src/worker/routes/bump-cache-version.ts` | Bump `admin/version.json` |
| `src/worker/lib/*.ts` | auth (HMAC), http, cors, github (client+retry), collections, cloudinary, repo-config, rate-limit |
| `src/worker/__tests__/worker.test.ts` | 29 test integrazione (GitHub/Cloudinary mockati) |
| `scripts/build-cloudflare.mjs` | Build `dist/` con allowlist + `_headers`/`_redirects` |
| `cloudflare/_headers` | Security header, cache policy JSON/immagini/HTML |
| `cloudflare/_redirects` | Placeholder (nessun redirect statico necessario) |
| `CLOUDFLARE_DEPLOY.md` | Guida deploy/DNS/rollback |
| `MIGRATION_REPORT.md` | Questo report |

## 3. File modificati

| File | Modifica |
|------|----------|
| `package.json` | Script `build`, `build:static`, `dev:cloudflare`, `deploy:*`, `test:worker`, `typecheck:worker` + devDeps |
| `admin/cms-simple.js` | Endpoint `/.netlify/functions/*` → `/api/*` (oggetto `API`); upload diretto Cloudinary firmato con fallback relay |
| `admin/sw.js` | `CACHE_VERSION` → `2026-07-26-cloudflare` (`/api/` era già network-only) |
| `README.md`, `ARCHITETTURA.md`, `admin/SETUP.md` | Riferimenti Netlify → Cloudflare |
| `beers.json`, `food.json`, `beverages.json` | Rigenerati da `npm run build:data` (allineati ai `.md` presenti) |

**Conservati come legacy** (riferimento + rollback, non più usati dal deploy CF):
`netlify/functions/`, `netlify.toml`.

## 4. Dipendenze

**Aggiunte (devDependencies)**: `wrangler@^4`, `typescript`, `@cloudflare/workers-types`, `vitest`.
**Rimosse**: nessuna (nessuna dipendenza runtime: il frontend resta vanilla JS).

## 5. Route: vecchie → nuove

| Netlify (legacy) | Cloudflare | Note |
|------------------|-----------|------|
| `/.netlify/functions/save-data` | `/api/save-data` | Alias legacy attivo, stesso handler |
| `/.netlify/functions/read-data` | `/api/read-data` | Alias legacy attivo |
| `/.netlify/functions/health` | `/api/health` | Alias legacy attivo |
| `/.netlify/functions/upload-image` | `/api/upload-image` | Ora solo fallback: upload primario diretto browser→Cloudinary |
| — | `/api/cloudinary-signature` | Nuovo: firma signed upload |
| `/.netlify/functions/bump-cache-version` | `/api/bump-cache-version` | Alias legacy attivo |
| — | `/api/auth/login`, `/api/auth/verify` | Nuovi endpoint dedicati (login/verify restano disponibili anche come action di save-data) |

Gli alias `/.netlify/functions/*` sono temporanei (PWA/tab con JS in cache): rimuovibili
da `router.ts` + `wrangler.jsonc` dopo un periodo di stabilità.

## 6. Secret e variabili richiesti (solo nomi)

**Secret** (`npx wrangler secret put …`): `GITHUB_TOKEN`, `ADMIN_PASSWORD`,
`CMS_TOKEN_SECRET` (ora **obbligatorio**, fail-loud), `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.

**Vars**: `REPO_OWNER`, `REPO_NAME`, `GITHUB_BRANCH`, `ADMIN_EMAIL`,
`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_FOLDER`, `ALLOWED_ORIGINS`.

Nomi identici a Netlify → copia valori 1:1. In locale: `.dev.vars` (gitignored).

## 7. Test eseguiti e risultati

| Verifica | Risultato |
|----------|-----------|
| `npm run test:worker` (Vitest) | ✅ **29/29 passati** — routing, health, 405, CORS (same-origin/allowlist/negata), login ok/ko, fail-loud secret mancante, token valido/scaduto/alterato, path traversal, JSON invalido, collection/filename invalidi, save con SHA ok (PUT verificata sul mock), conflitto SHA → 409 senza scritture, read pubblica JSON (formato legacy wrappato), 503 json-miss, mode=api con/senza token, firma Cloudinary senza leak del secret, fallback `/admin/*`, alias legacy |
| `npm run typecheck:worker` | ✅ 0 errori |
| `npm run validate` | ✅ contenuti validi |
| `npm run build` | ✅ `dist/`: 46 file, 37,66 MiB (max per-file 5,9 MiB < 25 MiB) |
| `wrangler deploy --dry-run` | ✅ 59 asset, upload 200,66 KiB (gzip 40,07) |
| `wrangler dev` locale (curl) | ✅ `/` 200, `/api/health` `{"ok":true}`, alias legacy identico, 404 su API sconosciuta, `_headers` applicati ai JSON (no-cache + ACAO *), `/admin/` 200, SPA fallback |
| Auth flow locale (secret reali, mai stampati) | ✅ login → token, verify → valid, password errata → 401, health autenticata → `githubRepo: true` (ping reale repo GitHub OK) |
| read-data locale | ✅ pubblica: 66 item `source=json`; `mode=api` senza token → 401; con token → 32 categorie con SHA |
| cloudinary-signature locale | ✅ tutti i campi presenti, nessun leak del secret nella risposta |

Nei test automatici GitHub e Cloudinary sono **sempre mockati**: nessuna scrittura reale.

## 8. Problemi incontrati

1. **Deploy reale bloccato — errore CF `10034`**: "You need to verify your email address
   to use Workers". Blocco esterno all'ambiente di sviluppo (serve accesso alla casella
   email dell'account Cloudflare). Tutto il resto è pronto: login wrangler OK,
   sottodominio workers.dev `arconti31` registrato via API, dry-run OK.
2. **Wrangler 4 senza comando `subdomain`**: sottodominio registrato via API REST
   (`PUT /accounts/{id}/workers/subdomain`) con il token OAuth di wrangler.
3. **Formato risposta read-data**: il formato legacy Netlify wrappa gli item
   (`{filename, content, parsedItem, fromJSON, sha}`); un'asserzione di test inizialmente
   errata è stata corretta per rispettare il formato legacy (il Worker era già conforme).

## 9. Rischi residui

- **Deploy non ancora eseguito in produzione**: la verifica end-to-end su workers.dev
  (e in particolare un salvataggio CMS reale in produzione) va ripetuta dopo lo sblocco email.
- **Cutover DNS**: dominio su Aruba ancora puntato a Netlify (sospeso). Finché non si
  esegue la procedura in `CLOUDFLARE_DEPLOY.md` §9 il dominio ufficiale resta offline.
- **Limiti free plan Workers**: 100k richieste/giorno sulle API (gli asset statici non
  contano). Ampio margine per l'uso attuale, ma senza burst protection custom.
- **Alias legacy**: da rimuovere in un secondo momento; finché attivi, mantengono
  compatibilità con eventuali client PWA con JS vecchio in cache.

## 10. Azioni manuali rimanenti (in ordine)

1. **Verificare l'email dell'account Cloudflare** (dash → My Profile → Communication)
2. `npm run deploy:cloudflare` → verifica su `https://arconti31.arconti31.workers.dev`
   (curl + login CMS + salvataggio di prova, checklist in `CLOUDFLARE_DEPLOY.md` §7)
3. Impostare **secret e vars** in produzione (`CLOUDFLARE_DEPLOY.md` §4)
4. Configurare **Workers Builds** su repo `arconti31/Arconti31`, branch `main`
   (`CLOUDFLARE_DEPLOY.md` §8) — nessuna GitHub Action: un solo sistema CI/CD
5. Merge di `migration/cloudflare-workers` in `main` (dopo verifica su workers.dev)
6. **Cutover dominio Aruba → Cloudflare** (`CLOUDFLARE_DEPLOY.md` §9): esporta DNS,
   aggiungi zona, cambia nameserver, custom domain sul Worker, redirect canonico
7. Dopo stabilità: rimuovere il dominio da Netlify (tenere il sito come rollback)
