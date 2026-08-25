# 🚀 Deploy su Cloudflare Workers — Guida Operativa

Guida completa per sviluppo locale, deploy, CI/CD, dominio custom, monitoraggio e rollback
del sito Arconti31 su **Cloudflare Workers + Static Assets** (piano free).

> Stato migrazione e dettaglio tecnico: [`MIGRATION_REPORT.md`](./MIGRATION_REPORT.md)

---

## 1. Prerequisiti

- **Node.js ≥ 20** e npm
- **Account Cloudflare** (piano free sufficiente) — Account ID: `b033262973abdab714d87e0c9e8ea00f`
- **Email Cloudflare verificata** (⚠️ obbligatoria per Workers, vedi §7)
- **Token GitHub** (Classic, permesso `repo`) per il salvataggio dal CMS
- **Account Cloudinary** (free) per upload immagini
- Wrangler è già in `devDependencies` (v4): non serve installazione globale, usa `npx wrangler`

## 2. Installazione

```bash
git clone https://github.com/arconti31/Arconti31.git
cd Arconti31
npm ci
```

## 3. Sviluppo locale

1. Crea il file dei secret locali (mai committato, è in `.gitignore`):

   ```bash
   cp .dev.vars.example .dev.vars
   # poi compila i valori reali in .dev.vars
   ```

2. Avvia build + Worker locale:

   ```bash
   npm run dev:cloudflare
   # → http://localhost:8787
   ```

3. Verifiche rapide:

   ```bash
   curl http://localhost:8787/api/health          # {"ok":true}
   curl -I http://localhost:8787/food/food.json   # Cache-Control: no-cache...
   open http://localhost:8787/admin/              # CMS
   ```

## 4. Secret e variabili

**Secret** (valori sensibili, MAI in `wrangler.jsonc` né nei file committati):

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put CMS_TOKEN_SECRET
npx wrangler secret put CLOUDINARY_API_KEY
npx wrangler secret put CLOUDINARY_API_SECRET
```

**Variabili non segrete** (dashboard Cloudflare → Workers → arconti31 → Settings →
Variables, oppure blocco `vars` in `wrangler.jsonc`):

| Variabile | Obbligatoria | Descrizione |
|-----------|--------------|-------------|
| `REPO_OWNER` | ✅ | Owner del repo GitHub dei contenuti |
| `REPO_NAME` | ✅ | Nome del repo |
| `GITHUB_BRANCH` | ❌ | Default `main` |
| `ADMIN_EMAIL` | ✅ | Email ammesse al CMS (virgola-separate) |
| `CLOUDINARY_CLOUD_NAME` | ❌ | Per upload immagini |
| `CLOUDINARY_FOLDER` | ❌ | Cartella upload (default `arconti31`) |
| `ALLOWED_ORIGINS` | ❌ | Origini CORS extra (virgola-separate) |

Note:
- `CMS_TOKEN_SECRET` è **obbligatorio**: senza, l'auth fallisce volutamente con
  500 `AUTH_CONFIG_MISSING` (nessun fallback sulla password).
- I nomi sono gli stessi usati storicamente su Netlify: i valori sono stati copiati 1:1 alla migrazione.

## 5. Build

```bash
npm run build
# = validate + build:data (rigenera i 4 JSON) + build:static (dist/)
```

`scripts/build-cloudflare.mjs` copia in `dist/` solo una **allowlist** esplicita
(HTML, css/, js/, images/, admin/, i 4 JSON aggregati, `_headers`, `_redirects`).
I file `.md` sorgente, gli script e i secret NON finiscono in `dist/`.
Limiti free plan rispettati: 46 file (max 20.000), file più grande 5,9 MiB (max 25 MiB).

## 6. Test

```bash
npm run test:worker       # 29 test Vitest (GitHub/Cloudinary mockati, zero scritture reali)
npm run typecheck:worker  # tsc --noEmit
npm run validate          # validazione contenuti .md
```

## 7. Deploy temporaneo su workers.dev

**✅ Fatto**: deploy eseguito e verificato su `https://arconti31.arconti31.workers.dev`
(secret impostati via `wrangler secret bulk`, checklist completa passata). Il dominio
ufficiale `arconti31.com` + `www` è connesso come **Custom Domain** del Worker.

Se in futuro il deploy fallisse con errore `10034 — verify your email address`:

1. Vai su [dash.cloudflare.com](https://dash.cloudflare.com) → icona profilo → **My Profile** → **Communication**
2. Clicca **Resend verification email** e conferma dal link ricevuto
3. Poi lancia:

```bash
npx wrangler login          # se non già autenticato
npm run deploy:cloudflare
```

Il sottodominio workers.dev **`arconti31`** è già registrato: l'URL finale sarà

```
https://arconti31.arconti31.workers.dev
```

Verifica post-deploy:

```bash
BASE=https://arconti31.arconti31.workers.dev
curl $BASE/api/health                      # {"ok":true}
curl -I $BASE/                             # 200 HTML
curl -I $BASE/food/food.json               # no-cache + ACAO *
curl -I $BASE/admin/                       # 200
```

Poi test manuale CMS: login su `$BASE/admin/`, modifica un prodotto, verifica commit su GitHub.

## 8. CI/CD — Workers Builds (deploy) + GitHub Actions (verifica)

I due sistemi hanno ruoli distinti e non si sovrappongono:

| Sistema | Ruolo | Trigger |
|---------|-------|---------|
| **GitHub Actions** (`.github/workflows/ci.yml`) | Solo verifica: validate, typecheck, test, build, `wrangler deploy --dry-run`, controllo che i JSON committati corrispondano ai `.md` | pull request e push su `main`/`migration/**` |
| **Cloudflare Workers Builds** | Deploy vero e proprio | push su `main` |

La CI **non ha credenziali Cloudflare** e non pubblica nulla: resta un solo sistema di
deploy, quindi nessun rischio di deploy duplicati o in conflitto.
Il merge in `main` va protetto richiedendo il check `verify`
(GitHub → Settings → Branches → Branch protection rule su `main`).

Configurazione Workers Builds (dashboard, una tantum, dopo la verifica email):

Configurazione (dashboard, una tantum, dopo la verifica email):

1. Dashboard → **Workers & Pages** → worker **arconti31** → **Settings** → **Builds**
2. **Connect** → GitHub → repository **arconti31/Arconti31**
3. Branch di produzione: **main**
4. Build command: `npm ci && npm run build`
5. Deploy command: `npx wrangler deploy`
6. Salva: da quel momento ogni push su `main` (inclusi i commit fatti dal CMS!) builda e deploya

> Nota: ogni salvataggio dal CMS crea un commit su `main` e quindi un deploy. È il
> comportamento desiderato: rigenera i JSON statici pubblicati. Il free plan Workers
> Builds ha minuti di build limitati ma ampiamente sufficienti per questo sito.

## 9. Dominio ufficiale (registrato su Aruba) → Cloudflare

> ✅ **Completato**: la zona `arconti31.com` è attiva su Cloudflare e i custom domain
> `arconti31.com` / `www` sono collegati al Worker. Le sottosezioni restano come
> riferimento storico/procedurale.

Il dominio è registrato su **aruba.it** e al momento della migrazione puntava a
Netlify. La migrazione
DNS va fatta **solo dopo** aver verificato tutto su workers.dev (sito, CMS, salvataggio,
JSON, upload Cloudinary, PWA, HTTPS). Il dominio resta registrato su Aruba: cambiano solo
i **nameserver**.

### 9.1 Prima di toccare il DNS

- Esporta/annota **tutti** i record DNS attuali dal pannello Aruba (A, CNAME, **MX**,
  **TXT/SPF/DKIM** — fondamentali se ci sono caselle email sul dominio).
- Non rimuovere ancora il sito da Netlify: serve come target di rollback.

### 9.2 Aggiungi la zona su Cloudflare

1. Dashboard → **Add a domain** → inserisci il dominio (es. `arconti31.com`) → piano **Free**
2. Cloudflare importa i record automaticamente: **confronta con l'export Aruba** e
   aggiungi a mano i record mancanti (soprattutto MX/TXT)
3. Cloudflare mostra 2 nameserver assegnati (es. `xxx.ns.cloudflare.com`)

### 9.3 Cambia i nameserver su Aruba

1. Pannello Aruba → gestione dominio → **Gestione DNS e Nameserver** → nameserver personalizzati
2. Sostituisci i nameserver Aruba con i 2 forniti da Cloudflare
3. Propagazione: da pochi minuti a 24-48h. La zona su Cloudflare diventa **Active**

### 9.4 Collega il dominio al Worker

Aggiungi in `wrangler.jsonc` e rideploya (`npm run deploy:cloudflare`):

```jsonc
"routes": [
	{ "pattern": "arconti31.com", "custom_domain": true },
	{ "pattern": "www.arconti31.com", "custom_domain": true }
]
```

(oppure da dashboard: worker → Settings → **Domains & Routes** → Add → Custom Domain).
Cloudflare emette automaticamente i certificati HTTPS.

### 9.5 Redirect canonico

Scegli l'host canonico (consigliato: apex `arconti31.com`) e crea un **Bulk Redirect**
o una Redirect Rule 301 `www.arconti31.com/*` → `https://arconti31.com/$1`
(Dashboard → zona → Rules → Redirect Rules).

### 9.6 Dopo la stabilizzazione

✅ Completato (agosto 2026): il custom domain è stato rimosso da Netlify e il sito
Netlify è stato dismesso. L'unica infrastruttura attiva è Cloudflare; per il rollback
vedi §11.

## 10. Monitoraggio

```bash
npx wrangler tail            # log realtime del Worker in produzione
npx wrangler deployments list
```

Dashboard → worker **arconti31** → **Observability**: richieste, errori, CPU time
(`observability.enabled = true` è già attivo in `wrangler.jsonc`).

Limiti free plan da tenere d'occhio: 100.000 richieste/giorno, 10 ms CPU/richiesta
(le richieste di asset statici NON contano).

## 11. Rollback in meno di 15 minuti

### Caso A — L'ultimo deploy del Worker ha rotto qualcosa

```bash
npx wrangler versions list     # trova l'ID della versione precedente funzionante
npx wrangler rollback [version-id]
```

Effetto immediato (< 1 minuto), nessuna build necessaria.

### Caso B — Problema grave su Cloudflare, redeploy dell'ultima versione nota buona

Netlify non esiste più come fallback: il ripristino avviene con git + wrangler.

1. Identifica l'ultimo commit funzionante su `main` (`git log --oneline`)
2. Redeploya da quello stato:
   ```bash
   git checkout <commit-funzionante>
   npm ci && npm run deploy:cloudflare
   git checkout main
   ```
3. In alternativa `npx wrangler rollback [version-id]` (Caso A) agisce senza rebuild
   e resta la via più rapida se il problema riguarda solo il Worker.

### Caso C — Solo il CMS ha problemi

Il sito pubblico legge JSON statici e resta online. Puoi modificare i `.md` direttamente
su GitHub e lanciare `npm run build:data` in locale (o attendere il CI) come procedura
d'emergenza.

## 12. Troubleshooting

| Sintomo | Causa probabile | Rimedio |
|---------|-----------------|---------|
| Deploy: errore `10034 verify your email` | Email account CF non verificata | §7, verifica email e riprova |
| `/api/*` risponde 404 HTML | `run_worker_first` mancante | Controlla `assets.run_worker_first` in `wrangler.jsonc` |
| Login CMS → 500 `AUTH_CONFIG_MISSING` | `CMS_TOKEN_SECRET` non impostato | `npx wrangler secret put CMS_TOKEN_SECRET` |
| Salvataggio CMS → "GITHUB_TOKEN non configurato" | Secret mancante | `npx wrangler secret put GITHUB_TOKEN` |
| Salvataggio → 409 "Conflitto" | Il file è cambiato su GitHub (SHA diverso) | Ricarica l'elemento nel CMS e risalva (comportamento voluto, OCC) |
| Salvataggio → 503 "budget di N chiamate GitHub" | Manca uno snapshot JSON aggregato, il Worker sta leggendo i `.md` uno per uno | Esegui `npm run build:data` in locale e committa i JSON rigenerati |
| Salvataggio → 503 "GitHub non raggiungibile" | Guasto o rate limit upstream | Nessun commit è partito (fail-closed): riprova più tardi |
| Riordino di molti elementi → più commit | Batch spezzato in blocchi da 30 | Comportamento voluto: ogni blocco è un commit atomico e coerente |
| Upload immagini fallisce | Secret Cloudinary mancanti | Imposta `CLOUDINARY_API_KEY`/`API_SECRET` + var `CLOUDINARY_CLOUD_NAME` |
| CORS bloccato da un'origine nuova | Origine non in allowlist | Aggiungi a `ALLOWED_ORIGINS` (virgola-separate) |
| Modifiche menù non visibili | Cache/CI in corso | Attendi il deploy CI; i JSON hanno `Cache-Control: no-cache` |
| Il CMS mostra dati vecchi dopo update | Service Worker admin | Hard refresh; il SW usa network-only su `/api/` |
| Asset > 25 MiB rifiutato al deploy | Immagine troppo grande | Comprimi l'immagine (limite per-file del free plan) |
| Wrangler non autenticato | Sessione OAuth scaduta | `npx wrangler login` |
